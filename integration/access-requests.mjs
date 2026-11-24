// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { grantDigest } from "../src/modules/capability/trust/trust.mjs";
import { verifyContracts } from "./contract.mjs";
import { createAuthorityFixture } from "./fixtures/authority.mjs";
import { base, issuer, jsonResult as json, recordTestSupport } from "./record-test-support.mjs";

const prefix = `access-req-${randomBytes(6).toString("hex")}`;
const tenants = ["tenant-a", "tenant-b"];
const clientIds = [], users = [], cases = [];
const { api: request, sql, q } = recordTestSupport(prefix);
const api = (path, who, body, headers, method = body === undefined ? "GET" : "POST") =>
  request(path, who, { body, headers, method });
const fixture = createAuthorityFixture({ base, prefix, sql, q, api, clientIds, users });
const manifest = JSON.parse(readFileSync(new URL("../docs/contracts/examples/capability-manifest.json", import.meta.url)));
const catalogPath = "/v1/capabilities/catalog";
const requestsPath = "/v1/trust/access-requests";
const requestPath = id => `${requestsPath}/${id}`;
let owner, administrator, publisher, provider, consumer, other, foreign, capabilityId, extraId;

async function observe(response, status, schema) {
  const value = await json(response, status);
  cases.push({ schema, value });
  return value;
}

async function publish(capabilityId, version, visibility) {
  const versions = `/v1/capabilities/${encodeURIComponent(capabilityId)}/versions`;
  const path = `${versions}/${version}`;
  const created = await api(versions, owner, { ...manifest, capabilityId, version, providerAppId: provider.app.appId,
    requiredPermissions: [`urn:junctura:permission:${provider.app.appId}:invoke`] });
  const draft = await json(created, 201);
  const headers = { "If-Match": created.headers.get("etag") };
  await json(await api(`${path}/validate`, owner, {}, headers), 200);
  const approval = await json(await api("/v1/approvals", administrator, {
    resourceType: "capability-version", resourceId: `${capabilityId}@${version}`, resourceDigest: draft.digest,
    resourceRevision: draft.revision, requesterSubject: owner.id, requesterAppId: provider.app.appId,
    decision: "approve", expiresAt: new Date(Date.now() + 120000).toISOString(),
  }), 201);
  const published = await api(`${path}/publish`, publisher, { approvalId: approval.approvalId }, headers);
  await json(published, 200);
  await json(await api(`${path}/visibility`, publisher, visibility,
    { "If-Match": published.headers.get("etag") }, "PUT"), 200);
}

before(async () => {
  await fixture.operatorToken();
  const [template] = await (await fixture.admin("clients?clientId=tenant-a")).json();
  const source = await (await fixture.admin(`clients/${template.id}`)).json();
  for (const tenant of tenants) {
    const protocolMappers = source.protocolMappers.map(({ id, ...mapper }) => structuredClone(mapper));
    protocolMappers.find(mapper => mapper.name === "tenant").config["claim.value"] = tenant;
    const response = await fixture.admin("clients", { clientId: `${prefix}-management-${tenant}`, enabled: true,
      protocol: "openid-connect", publicClient: true, standardFlowEnabled: true, directAccessGrantsEnabled: false,
      redirectUris: ["http://127.0.0.1:9876/callback"], attributes: { "pkce.code.challenge.method": "S256" }, protocolMappers }, "POST");
    assert.equal(response.status, 201);
    clientIds.push(response.headers.get("location").split("/").at(-1));
  }
  owner = await fixture.human("owner", tenants[0], ["applications.register", "capabilities.write", "trust.write", "trust.approve"]);
  administrator = await fixture.human("administrator", tenants[0], ["applications.approve", "capabilities.approve", "trust.approve", "audit.read"]);
  publisher = await fixture.human("publisher", tenants[0], ["capabilities.publish"]);
  const foreignOwner = await fixture.human("foreign-owner", tenants[1], ["applications.register", "trust.write"]);
  const foreignAdmin = await fixture.human("foreign-admin", tenants[1], ["applications.approve", "trust.approve"]);
  provider = await fixture.backend("provider", owner, administrator);
  consumer = await fixture.backend("consumer", owner, administrator);
  other = await fixture.backend("other", owner, administrator);
  foreign = await fixture.backend("foreign", foreignOwner, foreignAdmin, tenants[1]);
  capabilityId = `urn:junctura:capability:${provider.app.appId}:echo`;
  extraId = `urn:junctura:capability:${provider.app.appId}:sample`;
  await publish(capabilityId, "1.10.0", { visibility: "tenant" });
  await publish(capabilityId, "1.9.0", { visibility: "tenant" });
  await publish(extraId, "1.0.0", { visibility: "applications", applications: [consumer.app.appId] });
});

after(async () => {
  if (!clientIds.length) return;
  const subjects = users.map(q).join(",") || "NULL";
  try {
    const cleanup = await Promise.allSettled(tenants.map(tenant => {
      const apps = `SELECT app_id FROM app_private.applications WHERE tenant_id=${q(tenant)} AND owner_subject IN (${subjects})`;
      return sql(`BEGIN;
        SELECT set_config('request.jwt.claims', ${q(JSON.stringify({ tenant_id: tenant }))}, true);
        DELETE FROM trust_private.access_requests WHERE tenant_id=${q(tenant)} AND provider_app_id IN (${apps});
        UPDATE trust_private.grants SET activation_approval_id=NULL WHERE tenant_id=${q(tenant)} AND provider_app_id IN (${apps});
        DELETE FROM trust_private.approvals WHERE tenant_id=${q(tenant)} AND grant_id IN (
          SELECT grant_id FROM trust_private.grants WHERE tenant_id=${q(tenant)} AND provider_app_id IN (${apps}));
        DELETE FROM trust_private.grants WHERE tenant_id=${q(tenant)} AND provider_app_id IN (${apps});
        DELETE FROM app_private.capability_publication_approvals WHERE tenant_id=${q(tenant)} AND requester_app_id IN (${apps});
        DELETE FROM app_private.capability_versions WHERE tenant_id=${q(tenant)} AND provider_app_id IN (${apps});
        DELETE FROM app_private.approvals WHERE tenant_id=${q(tenant)} AND app_id IN (${apps});
        UPDATE app_private.applications SET state='revoked' WHERE tenant_id=${q(tenant)} AND app_id IN (${apps});
        DELETE FROM app_private.enrollments WHERE tenant_id=${q(tenant)} AND owner_subject IN (${subjects});
        DELETE FROM app_private.principals WHERE tenant_id=${q(tenant)} AND subject IN (${subjects});
        COMMIT;`);
    }));
    const errors = cleanup.filter(item => item.status === "rejected").map(item => item.reason);
    if (errors.length) throw new AggregateError(errors, "Could not clean access request fixtures");
  } finally {
    await fixture.operatorToken();
    for (const id of clientIds) assert.equal((await fixture.admin(`clients/${id}`, undefined, "DELETE")).status, 204);
    for (const id of users) assert.equal((await fixture.admin(`users/${id}`, undefined, "DELETE")).status, 204);
  }
});

test("catalog pages the highest visible published version with discover-gated manifest", async () => {
  const all = await observe(await api(catalogPath, consumer), 200, "CapabilityCatalogPage");
  const versions = all.items.filter(item => item.capabilityId === capabilityId);
  assert.deepEqual(versions.map(item => item.version), ["1.10.0"]);
  assert.equal(versions[0].myAccess, "none");
  assert.equal(Object.hasOwn(versions[0], "manifest"), false);
  assert.equal(Object.hasOwn(versions[0], "inputSchema"), false);
  assert.ok(all.items.some(item => item.capabilityId === extraId));
  const otherPage = await json(await api(catalogPath, other), 200);
  assert.equal(otherPage.items.some(item => item.capabilityId === extraId), false);
  const page = await json(await api(`${catalogPath}?limit=1`, consumer), 200);
  assert.ok(page.nextCursor);
  assert.equal(page.items.length, 1);
  const next = await json(await api(`${catalogPath}?limit=1&cursor=${page.nextCursor}`, consumer), 200);
  assert.equal(next.items.length, 1);
  assert.notEqual(next.items[0].capabilityId, page.items[0].capabilityId);
  assert.equal((await api(`${catalogPath}?cursor=${page.nextCursor}`, other)).status, 400);
  const foreignPage = await json(await api(catalogPath, foreign), 200);
  assert.equal(foreignPage.items.some(item => [capabilityId, extraId].includes(item.capabilityId)), false);
});

test("request lifecycle is isolated and acceptance proposes one grant for independent approval", async () => {
  const body = { capabilityId, version: "1.10.0", purpose: "Verify interoperability with the published echo capability." };
  const key = () => ({ "Idempotency-Key": randomUUID() });
  const send = (headers = key(), patch = {}, actor = consumer) => api(requestsPath, actor, { ...body, ...patch }, headers);
  const transition = (id, action, actor, body) => api(`${requestPath(id)}/${action}`, actor, body, {}, "POST");
  const checkCatalog = async (access, discover = false) => {
    const page = await observe(await api(catalogPath, consumer), 200, "CapabilityCatalogPage");
    const item = page.items.find(item => item.capabilityId === capabilityId);
    assert.equal(item.myAccess, access);
    assert.equal(Object.hasOwn(item, "manifest"), discover);
    if (discover) assert.deepEqual(item.manifest.inputSchema, manifest.inputSchema);
  };
  cases.push({ schema: "CapabilityAccessRequestCreate", value: body });
  const retryKey = key();
  const first = await send(retryKey);
  const pending = await observe(first, 201, "CapabilityAccessRequest");
  assert.equal(first.headers.get("location"), requestPath(pending.requestId));
  assert.equal(pending.state, "pending");
  assert.equal(pending.consumerAppId, consumer.app.appId);
  assert.deepEqual(await json(await send(retryKey), 200), pending);
  assert.equal((await send(retryKey, { purpose: "Changed purpose" })).status, 409);
  assert.equal((await send(key(), {}, foreign)).status, 404);
  assert.equal((await api(requestPath(pending.requestId), foreign)).status, 404);
  assert.equal((await api(requestPath(pending.requestId), other)).status, 404);
  assert.deepEqual(await json(await api(requestPath(pending.requestId), owner), 200), pending);
  assert.deepEqual(await json(await api(requestPath(pending.requestId), consumer), 200), pending);
  assert.equal((await json(await api(`${requestsPath}?direction=outgoing`, foreign), 200)).items.length, 0);
  const foreignCount = await sql(`BEGIN;
    SELECT set_config('request.jwt.claims', ${q(JSON.stringify({ tenant_id: tenants[1] }))}, true);
    SET LOCAL ROLE junctura_app_owner;
    SELECT count(*) FROM trust_private.access_requests WHERE request_id=${q(pending.requestId)};
    COMMIT;`);
  assert.equal(foreignCount.split("\n").at(-1), "0");
  const outgoing = await observe(await api(`${requestsPath}?direction=outgoing&state=pending`, consumer), 200, "CapabilityAccessRequestPage");
  assert.deepEqual(outgoing.items, [pending]);
  const incoming = await json(await api(`${requestsPath}?direction=incoming&state=pending`, owner), 200);
  assert.deepEqual(incoming.items, [pending]);
  await checkCatalog("requested");

  assert.equal((await transition(pending.requestId, "accept", consumer)).status, 403);
  assert.equal((await transition(pending.requestId, "withdraw", owner)).status, 403);
  assert.equal((await observe(await transition(pending.requestId, "withdraw", consumer), 200, "CapabilityAccessRequest")).state, "withdrawn");
  assert.equal((await transition(pending.requestId, "accept", owner)).status, 409);
  assert.equal((await json(await send(retryKey), 200)).state, "withdrawn");
  await checkCatalog("none");

  const second = await json(await send(), 201);
  const reason = "The provider cannot support the requested use.";
  const declined = await observe(await transition(second.requestId, "decline", owner, { reason }), 200, "CapabilityAccessRequest");
  assert.equal(declined.state, "declined");
  assert.equal(declined.reason, reason);
  assert.equal((await transition(second.requestId, "decline", owner, { reason })).status, 409);
  await checkCatalog("none");

  const third = await json(await send(), 201);
  const acceptedResponses = await Promise.all([
    transition(third.requestId, "accept", owner),
    transition(third.requestId, "accept", owner),
  ]);
  assert.deepEqual(acceptedResponses.map(response => response.status).sort(), [200, 409]);
  const accepted = await observe(acceptedResponses.find(response => response.ok), 200, "CapabilityAccessRequest");
  assert.equal(accepted.state, "accepted");
  assert.ok(accepted.grantId);
  assert.equal((await transition(third.requestId, "withdraw", consumer)).status, 409);
  await checkCatalog("requested");

  const grantPath = `/v1/trust/grants/${accepted.grantId}`;
  const grantResponse = await api(grantPath, owner);
  const grant = await observe(grantResponse, 200, "Grant");
  assert.equal(grant.state, "pending");
  assert.equal(grant.createdBy, owner.id);
  assert.deepEqual(grant.proposal.capabilities, [{ capabilityId, version: body.version, manifestDigest: third.manifestDigest }]);
  assert.deepEqual(grant.proposal.subjectIds, [consumer.subject]);
  assert.equal(grant.digest, grantDigest(grant.grantId, { tenantId: grant.tenantId, issuer, subject: owner.id }, grant.proposal));
  const decision = {
    resourceType: "grant", resourceId: grant.grantId, resourceDigest: grant.digest, resourceRevision: grant.revision,
    requesterSubject: owner.id, requesterAppId: provider.app.appId, decision: "approve",
    expiresAt: new Date(Date.now() + 120000).toISOString(),
  };
  const selfApproval = await json(await api("/v1/approvals", owner, decision), 403);
  assert.equal(selfApproval.error, "independent_approver_required");
  const approved = await json(await api("/v1/approvals", administrator, decision), 201);
  const activated = await api(`${grantPath}/activate`, administrator, { approvalId: approved.approvalId },
    { "If-Match": grantResponse.headers.get("etag") });
  assert.equal((await json(activated, 200)).state, "active");
  await checkCatalog("granted", true);

  const page = await json(await api(`${requestsPath}?direction=incoming&limit=1`, owner), 200);
  assert.deepEqual(page.items, [accepted]);
  assert.ok(page.nextCursor);
  const next = await json(await api(`${requestsPath}?direction=incoming&limit=1&cursor=${page.nextCursor}`, owner), 200);
  assert.deepEqual(next.items, [declined]);
  assert.equal((await api(`${requestsPath}?direction=incoming&state=declined&cursor=${page.nextCursor}`, owner)).status, 400);

  const revoked = await api(`${grantPath}/revoke`, owner, { reason: "Fixture grant completed." }, { "If-Match": activated.headers.get("etag") });
  assert.equal((await json(revoked, 200)).state, "revoked");
  await checkCatalog("none");
  const audit = await json(await api("/v1/audit-events?limit=100", administrator), 200);
  for (const row of [pending, declined, accepted]) {
    const expected = row === pending ? "withdrawn" : row.state;
    assert.deepEqual(audit.items.filter(event => event.resourceId === row.requestId).map(event => event.event).sort(),
      [`capability.access_request_${expected}`, "capability.access_request_created"].sort());
  }
  assert.equal(audit.items.filter(event => event.resourceId === accepted.grantId && event.event === "grant.proposed").length, 1);
  await verifyContracts("access-requests", cases, "--capability-runtime");
});
