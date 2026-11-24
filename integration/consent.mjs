// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyContracts } from "./contract.mjs";
import { resourceConsentFixture } from "./fixtures/resource-consent.mjs";
import { jsonResult as json } from "./record-test-support.mjs";

const { setup, request, sql, q, prefix, tenant, recipientUnit, subjectId, idempotency } = resourceConsentFixture("consent");
const consents = "/v1/me/resource-consents";

test("the database evaluates consent state at the read instant", async () => {
  const passed = await sql(`
    WITH cases(fields, expected) AS (VALUES
      ('{}'::jsonb, 'consent_required'),
      ('{"consent_id":"44444444-4444-4444-8444-444444444444"}'::jsonb, NULL),
      ('{"consent_id":"44444444-4444-4444-8444-444444444444","expires_at":"2026-01-01T00:00:00Z"}'::jsonb, 'consent_expired'),
      ('{"consent_id":"44444444-4444-4444-8444-444444444444","expires_at":"2026-01-01T00:00:00Z","revoked_at":"2025-12-31T00:00:00Z"}'::jsonb, 'consent_revoked'))
    SELECT bool_and(app_private.resource_consent_state(
      jsonb_populate_record(NULL::app_private.resource_consents, fields), '2026-01-01T00:00:00Z'
    ) IS NOT DISTINCT FROM expected) FROM cases;`);
  assert.equal(passed, "t");
});

test("a verified subject grants and revokes audited delegated reads to a unit", { timeout: 120_000 }, async () => {
  const { owner, admin, outsider, reader, appId, appPath, clientId, exchange,
    ownerSource, readerSource, outsiderSource, readerAssignment, record, target, object, objectPath, contents } = await setup();

  const otherTenantLookup = await sql(`BEGIN;
    SET LOCAL ROLE junctura_app_owner;
    SELECT set_config('request.jwt.claims', '{"tenant_id":"tenant-b"}', true);
    SELECT (r.record_row).id IS NULL AND (o.object_row).id IS NULL
      FROM app_private.resource_consent_target('record',${q(record.id)},${q(prefix)}) r
      CROSS JOIN app_private.resource_consent_target('object',${q(object.id)},NULL) o;
    ROLLBACK;`);
  assert.equal(otherTenantLookup.split("\n").at(-1), "t");

  await json(await request(`/v2/data-masking/${prefix}`, await exchange(ownerSource), {
    method: "PUT", body: { fields: { label: { mask: "full", owner: true } } },
  }), 200);
  const body = { resourceType: "record", resourceId: record.id, recipientUnit, purpose: "Review the selected record" };
  const create = (who, input, headers = idempotency()) => request(consents, who, { method: "POST", body: input, headers });
  const revoke = (who, grant) => request(`${consents}/${grant.consentId}/revoke`, who, { method: "POST", body: {} });
  assert.equal((await create(outsider, body)).status, 404);
  assert.equal((await create(owner, { ...body, recipientUnit: `${prefix}-missing` })).status, 404);
  const receipt = idempotency();
  const grant = await json(await create(owner, body, receipt), 201);
  assert.deepEqual(await json(await create(owner, body, receipt), 201), grant);
  assert.equal((await json(await create(owner, { ...body, purpose: "Another purpose" }, receipt), 422)).error, "idempotency_key_reused");
  assert.equal(grant.expiresAt, null);
  const objectGrant = await json(await create(owner, { ...body, resourceType: "object", resourceId: object.id }), 201);
  assert.equal((await revoke(outsider, grant)).status, 404);
  assert.deepEqual((await json(await request(consents, outsider), 200)).consents, []);
  assert.equal((await request(target, readerSource)).status, 403);
  assert.equal((await json(await request(target, await exchange(outsiderSource)), 403)).error, "unit_mismatch");

  const readerToken = await exchange(readerSource);
  const readRecord = await request(target, readerToken);
  assert.deepEqual((await json(readRecord, 200)).data, { label: "***" });
  const readObject = await request(objectPath, readerToken);
  assert.equal(readObject.status, 200);
  assert.equal(await readObject.text(), contents);
  const revoked = await json(await revoke(owner, grant), 200);
  assert.equal(revoked.status, "revoked");
  assert.deepEqual(await json(await revoke(owner, grant), 200), revoked);
  const denied = await request(target, readerToken);
  assert.deepEqual(await json(denied, 403), { error: "consent_revoked", requestId: denied.headers.get("x-request-id") });
  await json(await revoke(owner, objectGrant), 200);
  const objectDenied = await request(objectPath, readerToken);
  assert.equal((await json(objectDenied, 403)).error, "consent_revoked");

  const expiring = await json(await create(owner, { ...body, expiresAt: new Date(Date.now() + 60_000).toISOString() }), 201);
  await sql(`BEGIN;
    SELECT set_config('request.jwt.claims', ${q(JSON.stringify({ tenant_id: tenant }))}, true);
    UPDATE app_private.resource_consents SET expires_at=now()-interval '1 minute'
      WHERE tenant_id=${q(tenant)} AND consent_id=${q(expiring.consentId)};
    COMMIT;`);
  const expired = await request(target, await exchange(readerSource));
  assert.equal((await json(expired, 403)).error, "consent_expired");
  const listed = await json(await request(consents, owner), 200);
  assert.deepEqual(Object.fromEntries(listed.consents.map(s => [s.consentId, s.status])), {
    [grant.consentId]: "revoked", [expiring.consentId]: "expired", [objectGrant.consentId]: "revoked",
  });
  assert.deepEqual((await json(await request(target, await exchange(ownerSource)), 200)).data, record.data);

  const history = await json(await request("/v1/me/data-access", owner), 200);
  const otherHistory = await json(await request("/v1/me/data-access", outsider), 200);
  assert.equal(otherHistory.entries.some(entry => entry.action === "resource.read"), false);
  const audit = await json(await request("/v1/audit-events?action=resource.read&limit=100", admin), 200);
  for (const [response, consent, resourceRef, reasonCode] of [
    [readRecord, grant, { type: "record", id: record.id, collection: prefix }, null],
    [readObject, objectGrant, { type: "object", id: object.id }, null],
    [denied, grant, { type: "record", id: record.id, collection: prefix }, "consent_revoked"],
    [objectDenied, objectGrant, { type: "object", id: object.id }, "consent_revoked"],
    [expired, expiring, { type: "record", id: record.id, collection: prefix }, "consent_expired"],
  ]) {
    const requestId = response.headers.get("x-request-id");
    const common = { requestId, resourceRef, reasonCode, reader: reader.id, unit: recipientUnit,
      consentId: consent.consentId, outcome: reasonCode ? "denied" : "success" };
    const [entry, ...duplicates] = history.entries.filter(row => row.requestId === requestId);
    assert.equal(duplicates.length, 0);
    assert.ok(entry && Number.isFinite(Date.parse(entry.accessedAt)));
    assert.equal(entry.app.appId, appId);
    assert.equal(entry.purpose, body.purpose);
    for (const [field, value] of Object.entries(common)) assert.deepEqual(entry[field], value, field);
    const rows = audit.items.filter(row => row.requestId === requestId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, "resource_consent");
    assert.equal(Date.parse(rows[0].occurredAt), Date.parse(entry.accessedAt));
    for (const [field, value] of Object.entries({ ...common, subjectId, tenantId: tenant, appId, managementClient: clientId })) {
      assert.deepEqual(rows[0][field], value, field);
    }
  }
  const verification = await json(await request("/v1/audit-events/verify", admin, { method: "POST", body: {} }), 200);
  assert.equal(verification.verified, true);
  const restored = await json(await create(owner, body), 201);
  assert.equal(restored.status, "active");
  const beforeUnassign = await exchange(readerSource);
  assert.equal((await request(`${appPath}/assignments/${readerAssignment.assignmentId}`, admin, { method: "DELETE" })).status, 204);
  assert.equal((await json(await request(target, beforeUnassign), 403)).error, "not_assigned_to_app");
  await verifyContracts("consent", [{ schema: "SubjectAccessPage", value: history },
    { schema: "AuditQueryPage", value: audit }], "--capability-runtime");
  await verifyContracts("consent");
});
