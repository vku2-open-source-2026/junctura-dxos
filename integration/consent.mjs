// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { verifyContracts } from "./contract.mjs";
import { createAuthorityFixture } from "./fixtures/authority.mjs";
import { provisionFixtureDirectory } from "./fixtures/keycloak.mjs";
import { base, issuer, jsonResult as json, recordTestSupport } from "./record-test-support.mjs";

const prefix = `consent-${randomBytes(6).toString("hex")}`;
const tenant = "tenant-a";
const units = ["owner", "recipient", "outside"].map(label => `${prefix}-${label}`);
const [ownerUnit, recipientUnit, outsideUnit] = units;
const clientIds = [], users = [], keys = [];
const { api: request, sql, q } = recordTestSupport(prefix);
const fixture = createAuthorityFixture({ base, prefix, sql, q, clientIds, users,
  api: (path, who, body, headers, method = body === undefined ? "GET" : "POST") => request(path, who, { method, body, headers }) });
const idempotency = () => {
  const key = randomUUID();
  keys.push(key);
  return { "Idempotency-Key": key };
};
const consents = "/v1/me/resource-consents";
const recordPath = `/v2/data/${prefix}`;
const subjectId = randomUUID();
const otherSubjectId = randomUUID();

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

after(async () => {
  if (!clientIds.length) return;
  const subjects = users.map(q).join(",") || "NULL";
  const appIds = `SELECT app_id FROM app_private.applications WHERE tenant_id=${q(tenant)} AND owner_subject IN (${subjects})`;
  const unitKeys = units.map(q).join(",");
  try {
    await sql(`BEGIN;
      SELECT set_config('request.jwt.claims', ${q(JSON.stringify({ tenant_id: tenant }))}, true);
      DELETE FROM app_private.resource_consents WHERE tenant_id=${q(tenant)} AND login_subject IN (${subjects});
      DELETE FROM app_private.object_upload_staging WHERE tenant_id=${q(tenant)} AND owner_app_id IN (${appIds});
      DELETE FROM app_private.resource_objects WHERE tenant_id=${q(tenant)} AND owner_app_id IN (${appIds});
      DELETE FROM app_private.object_quotas WHERE tenant_id=${q(tenant)} AND owner_app_id IN (${appIds});
      DELETE FROM core.app_records WHERE tenant_id=${q(tenant)} AND owner_app_id IN (${appIds});
      DELETE FROM app_private.record_collections WHERE tenant_id=${q(tenant)} AND owner_app_id IN (${appIds});
      DELETE FROM app_private.idempotency_results WHERE tenant_id=${q(tenant)} AND key IN (${keys.map(q).join(",") || "NULL"});
      DELETE FROM app_private.app_assignments WHERE tenant_id=${q(tenant)} AND app_id IN (${appIds});
      DELETE FROM app_private.approvals WHERE tenant_id=${q(tenant)} AND app_id IN (${appIds});
      UPDATE app_private.applications SET state='revoked'
        WHERE tenant_id=${q(tenant)} AND app_id IN (${appIds});
      DELETE FROM app_private.enrollments WHERE tenant_id=${q(tenant)} AND owner_subject IN (${subjects});
      DELETE FROM app_private.principals WHERE tenant_id=${q(tenant)} AND subject IN (${subjects});
      DELETE FROM app_private.directory_memberships WHERE tenant_id=${q(tenant)} AND unit IN (${unitKeys});
      DELETE FROM app_private.directory_members WHERE tenant_id=${q(tenant)} AND unit IN (${unitKeys});
      DELETE FROM app_private.directory_units WHERE tenant_id=${q(tenant)} AND unit IN (${unitKeys});
      DELETE FROM app_private.directory_unit_types WHERE tenant_id=${q(tenant)} AND unit_type=${q(prefix)};
      ALTER TABLE app_private.subject_bindings DISABLE TRIGGER subject_binding_guard;
      DELETE FROM app_private.subject_bindings WHERE tenant_id=${q(tenant)} AND issuer=${q(issuer)}
        AND subject_id IN (${q(subjectId)},${q(otherSubjectId)}) AND login_subject IN (${subjects});
      ALTER TABLE app_private.subject_bindings ENABLE TRIGGER subject_binding_guard;
      COMMIT;`);
  } finally {
    await fixture.operatorToken();
    for (const id of clientIds) await fixture.admin(`clients/${id}`, undefined, "DELETE");
    for (const id of users) await fixture.admin(`users/${id}`, undefined, "DELETE");
    const roots = await json(await fixture.admin(`groups?search=${tenant}&exact=true`), 200);
    const root = roots.find(group => group.path === `/${tenant}`);
    if (root) for (const group of await json(await fixture.admin(`groups/${root.id}/children`), 200)) {
      if (units.includes(group.name)) await fixture.admin(`groups/${group.id}`, undefined, "DELETE");
    }
  }
});

test("a verified subject grants and revokes audited delegated reads to a unit", { timeout: 120_000 }, async () => {
  await provisionFixtureDirectory(base);
  await fixture.operatorToken();
  const [template] = await json(await fixture.admin(`clients?clientId=${tenant}`), 200);
  const { protocolMappers } = await json(await fixture.admin(`clients/${template.id}`), 200);
  const redirectUri = "http://127.0.0.1:9876/callback";
  const client = await fixture.admin("clients", {
    clientId: `${prefix}-management-${tenant}`, enabled: true, protocol: "openid-connect", publicClient: true,
    standardFlowEnabled: true, redirectUris: [redirectUri], attributes: { "pkce.code.challenge.method": "S256" },
    protocolMappers: protocolMappers.map(({ id, ...mapper }) => mapper),
  }, "POST");
  assert.equal(client.status, 201);
  clientIds.push(client.headers.get("location").split("/").at(-1));

  const owner = await fixture.verifiedSubject(await fixture.human("owner", tenant, ["applications.register"]), subjectId);
  const admin = await fixture.human("admin", tenant, ["applications.approve", "trust.approve", "audit.read", "directory.write"]);
  const reader = await fixture.human("reader", tenant, []);
  const outsider = await fixture.verifiedSubject(await fixture.human("outsider", tenant, []), otherSubjectId);
  const put = (path, body) => request(`/v1/directory/${path}`, admin, { method: "PUT", body }).then(r => json(r, 201));
  await put(`unit-types/${prefix}`, { name: "Consent fixture" });
  for (const [unit, person] of [[ownerUnit, owner], [recipientUnit, reader], [outsideUnit, outsider]]) {
    await put(`units/${unit}`, { name: unit, unitType: prefix });
    await put(`units/${unit}/members/${person.id}`, { groups: [] });
  }

  const backend = await fixture.backend("app", owner, admin, tenant, true, undefined, redirectUri);
  const { app: { appId }, clientId, clientSecret } = backend;
  const appPath = `/v1/applications/${appId}`;
  await json(await request(appPath, admin, { method: "PATCH", headers: { "If-Match": backend.etag },
    body: { ownerUnit, deploymentUnits: units } }), 200);
  const assign = (unit, user, role) => request(`${appPath}/assignments`, admin,
    { method: "POST", body: { unit, targetType: "subject", target: user.id, role } }).then(r => json(r, 200));
  const login = user => fixture.login(user.username, user.password, clientId, clientSecret);
  // Approval configures the browser flow and can invalidate the pre-approval token.
  const actorToken = await backend.issueToken();
  const callExchange = subjectToken => request("/v1/token-exchange", actorToken, { method: "POST", body: { subjectToken } });
  const exchange = async source => (await json(await callExchange(source), 200)).access_token;
  assert.equal((await json(await callExchange(reader.token), 403)).error, "not_assigned_to_app");
  await assign(ownerUnit, owner, "manager");
  const readerAssignment = await assign(recipientUnit, reader, "viewer");
  await assign(outsideUnit, outsider, "viewer");
  const ownerSource = await login(owner);
  const readerSource = await login(reader);
  const outsiderSource = await login(outsider);
  const ownerToken = await exchange(ownerSource);
  await json(await request(`/v2/data-schemas/${prefix}`, ownerToken, { method: "PUT",
    body: { schema: { type: "object", properties: { label: { type: "string" } }, required: ["label"] },
      indexed: [], uniqueKey: null, searchable: [], sensitive: [] } }), 200);
  const record = await json(await request(recordPath, ownerToken, { method: "POST",
    headers: idempotency(), body: { data: { label: "Selected record" } } }), 201);
  const target = `${recordPath}/${record.id}`;
  const boundary = `consent${randomBytes(12).toString("hex")}`;
  const contents = "Selected object";
  const object = await json(await request("/v2/objects", ownerToken, { method: "POST",
    headers: { ...idempotency(), "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body: Buffer.from([`--${boundary}`, 'Content-Disposition: form-data; name="file"; filename="object.bin"',
      "Content-Type: application/octet-stream", "", contents, `--${boundary}`,
      'Content-Disposition: form-data; name="recordRef"', "Content-Type: application/json", "",
      JSON.stringify({ collection: prefix, id: record.id }), `--${boundary}--`, ""].join("\r\n")) }), 201);
  const objectPath = `/v2/objects/${object.id}`;

  const otherTenantLookup = await sql(`BEGIN;
    SET LOCAL ROLE junctura_app_owner;
    SELECT set_config('request.jwt.claims', '{"tenant_id":"tenant-b"}', true);
    SELECT (r.record_row).id IS NULL AND (o.object_row).id IS NULL
      FROM app_private.resource_consent_target('record',${q(record.id)},${q(prefix)}) r
      CROSS JOIN app_private.resource_consent_target('object',${q(object.id)},NULL) o;
    ROLLBACK;`);
  assert.equal(otherTenantLookup.split("\n").at(-1), "t");

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
  assert.deepEqual((await json(readRecord, 200)).data, record.data);
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
  assert.equal((await request(target, await exchange(ownerSource))).status, 200);

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
