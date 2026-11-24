// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { verifyContracts } from "./contract.mjs";
import { resourceConsentFixture } from "./fixtures/resource-consent.mjs";
import { jsonResult as json } from "./record-test-support.mjs";

const { setup, request, sql, q, tenant, recipientUnit, outsideUnit } =
  resourceConsentFixture("consent-requests", { includeRequesters: true });
const requests = "/v1/resource-consent-requests";
const inbox = "/v1/me/resource-consent-requests";
const grants = "/v1/me/resource-consents";
const post = (path, token, body) => request(path, token, { method: "POST", body });
const submit = (token, body) => post(requests, token, body);
const decide = (token, item, operation, body = {}) => post(`${inbox}/${item.requestId}/${operation}`, token, body);
const status = (token, item) => request(`${requests}/${item.requestId}`, token);
const cancel = (token, item) => post(`${requests}/${item.requestId}/cancel`, token, {});
const revoke = (token, consentId) => post(`${grants}/${consentId}/revoke`, token, {});

test("resource consent requests scope, settle and audit access to records and objects", { timeout: 120_000 }, async () => {
  const { owner, admin, reader, outsider, foreignSubject, record, object, appId, exchange,
    ownerSource, readerSource, outsiderSource, peerSource, target, objectPath, contents } = await setup();
  let requester = await exchange(readerSource);
  const peerToken = await exchange(peerSource);
  const outsideToken = await exchange(outsiderSource);
  const body = { resourceType: "record", resourceId: record.id, purpose: "Review the selected record",
    expiresAt: new Date(Date.now() + 600_000).toISOString() };

  assert.equal((await json(await submit(readerSource, body), 403)).error, "application_access_required");
  assert.equal((await json(await submit(requester, { ...body, recipientUnit: outsideUnit }), 400)).error, "invalid_consent_request");
  assert.equal((await json(await submit(requester, { ...body, expiresAt: "2000-01-01T00:00:00Z" }), 400)).error, "invalid_consent_expiry");
  assert.equal((await submit(requester, { ...body, resourceId: randomUUID() })).status, 404);
  assert.equal((await request(target, requester)).status, 403);

  const attempts = await Promise.all([submit(requester, body), submit(requester, body)]);
  const created = attempts.find(response => response.status === 201);
  const duplicate = attempts.find(response => response.status === 409);
  assert.ok(created && duplicate, attempts.map(response => response.status).join(", "));
  const pending = await json(created, 201);
  assert.equal(created.headers.get("location"), `${requests}/${pending.requestId}`);
  assert.equal((await json(duplicate, 409)).error, "consent_request_already_pending");
  assert.equal((await json(await submit(peerToken, body), 409)).error, "consent_request_already_pending");
  assert.equal(pending.status, "pending");
  assert.equal(pending.recipientUnit, recipientUnit);
  assert.equal(Date.parse(pending.expiresAt), Date.parse(body.expiresAt));
  assert.deepEqual(await json(await status(requester, pending), 200), pending);
  for (const unauthorized of [peerToken, outsideToken]) {
    assert.equal((await status(unauthorized, pending)).status, 404);
    assert.equal((await cancel(unauthorized, pending)).status, 404);
  }
  const outsideRequest = await json(await submit(outsideToken, body), 201);
  assert.equal(outsideRequest.recipientUnit, outsideUnit);
  assert.equal((await status(requester, outsideRequest)).status, 404);
  assert.equal((await json(await cancel(outsideToken, outsideRequest), 200)).status, "cancelled");
  for (const unauthorized of [outsider, foreignSubject]) {
    assert.deepEqual(await json(await request(inbox, unauthorized), 200), { requests: [] });
    assert.equal((await decide(unauthorized, pending, "accept")).status, 404);
    assert.equal((await decide(unauthorized, pending, "decline")).status, 404);
  }
  const delegatedOwner = await exchange(ownerSource);
  assert.equal((await json(await decide(delegatedOwner, pending, "accept"), 403)).error, "verified_subject_required");
  assert.deepEqual(await json(await request(inbox, owner), 200), { requests: [pending] });

  const accepted = await json(await decide(owner, pending, "accept"), 200);
  assert.equal(accepted.status, "accepted");
  assert.ok(accepted.consentId);
  assert.deepEqual(await json(await status(requester, pending), 200), accepted);
  assert.equal((await json(await decide(owner, pending, "accept"), 409)).error, "consent_request_not_pending");
  assert.equal((await json(await cancel(requester, pending), 409)).error, "consent_request_not_pending");
  const objectRequest = await json(await submit(requester, { ...body, resourceType: "object", resourceId: object.id }), 201);
  const acceptedObject = await json(await decide(owner, objectRequest, "accept"), 200);
  const listed = await json(await request(grants, owner), 200);
  assert.equal(listed.consents.length, 2);
  for (const item of [accepted, acceptedObject]) {
    const grant = listed.consents.find(value => value.consentId === item.consentId);
    for (const key of ["requestId", "resourceType", "resourceId", "recipientUnit", "purpose", "expiresAt"]) {
      assert.equal(grant?.[key], item[key], key);
    }
  }
  assert.deepEqual((await json(await request(target, requester), 200)).data, record.data);
  const objectRead = await request(objectPath, requester);
  assert.equal(objectRead.status, 200);
  assert.equal(await objectRead.text(), contents);
  assert.equal((await json(await revoke(owner, accepted.consentId), 200)).requestId, pending.requestId);
  await json(await revoke(owner, acceptedObject.consentId), 200);
  for (const resourcePath of [target, objectPath]) {
    assert.equal((await json(await request(resourcePath, requester), 403)).error, "consent_revoked");
  }
  assert.deepEqual(await json(await status(requester, pending), 200), accepted);

  requester = await exchange(readerSource);
  const proposed = await json(await submit(requester, body), 201);
  const reason = "The proposed duration is too long.";
  const declined = await json(await decide(owner, proposed, "decline", { reason }), 200);
  assert.equal(declined.status, "declined");
  assert.equal(declined.declineReason, reason);
  assert.equal(declined.consentId, null);
  assert.deepEqual(await json(await status(requester, proposed), 200), declined);
  const expiring = await json(await submit(requester, body), 201);
  await sql(`BEGIN;
    SELECT set_config('request.jwt.claims', ${q(JSON.stringify({ tenant_id: tenant }))}, true);
    UPDATE app_private.resource_consent_requests SET expires_at=now()-interval '1 second'
      WHERE (tenant_id,request_id)=(${q(tenant)},${q(expiring.requestId)});
    COMMIT;`);
  const replacement = await json(await submit(requester, body), 201);
  assert.equal((await json(await status(requester, expiring), 200)).status, "expired");
  assert.equal((await json(await decide(owner, expiring, "accept"), 409)).error, "consent_request_not_pending");
  const cancelled = await json(await cancel(requester, replacement), 200);
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(await json(await status(requester, replacement), 200), cancelled);

  const stale = await json(await submit(requester, { ...body, resourceType: "object", resourceId: object.id }), 201);
  assert.equal((await request(objectPath, await exchange(ownerSource), { method: "DELETE" })).status, 204);
  assert.equal((await json(await decide(owner, stale, "accept"), 409)).error, "consent_request_target_changed");
  const staleDecision = await json(await decide(owner, stale, "decline"), 200);
  assert.equal(staleDecision.declineReason, null);
  assert.deepEqual(await json(await request(inbox, owner), 200), { requests: [] });

  const pendingAudit = "audit.resource_consent_request_";
  const statuses = ["pending", "accepted", "declined", "expired", "cancelled"];
  const events = (await Promise.all(statuses.map(action =>
    request(`/v1/audit-events?action=${pendingAudit}${action}&limit=100`, admin).then(response => json(response, 200)))))
    .flatMap(page => page.items);
  for (const [item, action, actor] of [[accepted, "accepted", owner], [acceptedObject, "accepted", owner],
    [declined, "declined", owner], [expiring, "expired", reader], [cancelled, "cancelled", reader], [stale, "declined", owner]]) {
    const transitions = events.filter(event => event.resourceId === item.requestId);
    assert.equal(transitions.length, 2);
    const started = transitions.find(event => event.event === pendingAudit + "pending");
    assert.equal(started?.subject, reader.id);
    assert.equal(started?.actorAppId, appId);
    assert.equal(transitions.find(event => event.event === pendingAudit + action)?.subject, actor.id);
  }
  assert.equal((await json(await post("/v1/audit-events/verify", admin, {}), 200)).verified, true);
  await verifyContracts("consent-requests");
});
