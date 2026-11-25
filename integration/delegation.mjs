// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { main as provisionDirectory } from "../scripts/provision-directory.mjs";
import { verifyContracts } from "./contract.mjs";
import { createAuthorityFixture } from "./fixtures/authority.mjs";
import { base, issuer, jsonResult as json, recordTestSupport } from "./record-test-support.mjs";

const prefix = `delegation-${randomBytes(6).toString("hex")}`;
const tenant = "tenant-a";
const unitA = `${prefix}-a`, unitB = `${prefix}-b`;
const clientIds = [], users = [];
const { api: request, sql, q } = recordTestSupport(prefix);
const fixture = createAuthorityFixture({ base, prefix, sql, q, clientIds, users,
  api: (path, who, body, headers, method = body === undefined ? "GET" : "POST") => request(path, who, { method, body, headers }) });
const tokenEndpoint = `${issuer}/protocol/openid-connect/token`;
const exchangePath = "/v1/token-exchange";
const claims = token => JSON.parse(Buffer.from(token.split(".")[1], "base64url"));

after(async () => {
  if (!clientIds.length) return;
  const subjects = users.map(q).join(",") || "NULL";
  const apps = `SELECT app_id FROM app_private.applications WHERE tenant_id=${q(tenant)} AND owner_subject IN (${subjects})`;
  const units = [unitA, unitB].map(q).join(",");
  try {
    await sql(`BEGIN;
      SELECT set_config('request.jwt.claims', ${q(JSON.stringify({ tenant_id: tenant }))}, true);
      DELETE FROM core.app_records WHERE tenant_id=${q(tenant)} AND owner_app_id IN (${apps});
      DELETE FROM app_private.record_collections WHERE tenant_id=${q(tenant)} AND owner_app_id IN (${apps});
      DELETE FROM app_private.idempotency_results WHERE concrete_path LIKE ${q(`%${prefix}%`)};
      DELETE FROM app_private.app_assignments WHERE tenant_id=${q(tenant)} AND app_id IN (${apps});
      DELETE FROM app_private.approvals WHERE tenant_id=${q(tenant)} AND app_id IN (${apps});
      UPDATE app_private.applications SET state='revoked',owner_unit=NULL,deployment_units='{}'
        WHERE tenant_id=${q(tenant)} AND app_id IN (${apps});
      DELETE FROM app_private.enrollments WHERE tenant_id=${q(tenant)} AND owner_subject IN (${subjects});
      DELETE FROM app_private.principals WHERE tenant_id=${q(tenant)} AND subject IN (${subjects});
      DELETE FROM app_private.directory_memberships WHERE tenant_id=${q(tenant)} AND unit IN (${units});
      DELETE FROM app_private.directory_members WHERE tenant_id=${q(tenant)} AND unit IN (${units});
      DELETE FROM app_private.directory_units WHERE tenant_id=${q(tenant)} AND unit IN (${units});
      DELETE FROM app_private.directory_unit_types WHERE tenant_id=${q(tenant)} AND unit_type=${q(prefix)};
      COMMIT;`);
  } finally {
    await fixture.operatorToken();
    for (const id of clientIds) await fixture.admin(`clients/${id}`, undefined, "DELETE");
    for (const id of users) await fixture.admin(`users/${id}`, undefined, "DELETE");
    const roots = await json(await fixture.admin(`groups?search=${tenant}&exact=true`), 200);
    const root = roots.find(group => group.path === `/${tenant}`);
    if (root) for (const group of await json(await fixture.admin(`groups/${root.id}/children`), 200)) {
      if ([unitA, unitB].includes(group.name)) await fixture.admin(`groups/${group.id}`, undefined, "DELETE");
    }
  }
});

test("delegation uses the current user assignment and the narrower authority of both parties", { timeout: 120_000 }, async () => {
  await provisionDirectory([], { log: () => {} });
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
  const owner = await fixture.human("owner", tenant, ["applications.register"]);
  const admin = await fixture.human("admin", tenant, ["applications.approve", "trust.approve", "audit.read", "directory.write"]);
  const userA = await fixture.human("user-a", tenant, []);
  const userB = await fixture.human("user-b", tenant, []);
  const reader = await fixture.human("reader", tenant, []);
  const coreWriter = await json(await fixture.admin("roles/core-writer"), 200);
  assert.equal((await fixture.admin(`users/${reader.id}/role-mappings/realm`, [coreWriter], "DELETE")).status, 204);
  const put = (path, body) => request(`/v1/directory/${path}`, admin, { method: "PUT", body }).then(r => json(r, 201));
  await put(`unit-types/${prefix}`, { name: "Delegation fixture" });
  await put(`units/${unitA}`, { name: "Unit A", unitType: prefix });
  await put(`units/${unitB}`, { name: "Unit B", unitType: prefix });
  for (const [unit, user] of [[unitA, userA], [unitB, userB], [unitA, reader]]) {
    await put(`units/${unit}/members/${user.id}`, { groups: [] });
  }

  const backend = await fixture.backend("app", owner, admin, tenant, true, undefined, redirectUri);
  const { app: { appId }, clientId, clientSecret, subject: actorSubject } = backend;
  const appPath = `/v1/applications/${appId}`;
  await json(await request(appPath, admin, { method: "PATCH", headers: { "If-Match": backend.etag },
    body: { ownerUnit: unitA, deploymentUnits: [unitA, unitB] } }), 200);
  const assign = (unit, user, role) => request(`${appPath}/assignments`, admin,
    { method: "POST", body: { unit, targetType: "subject", target: user.id, role } }).then(r => json(r, 200));
  const login = user => fixture.login(user.username, user.password, clientId, clientSecret);
  const actorToken = async () => (await json(await fetch(tokenEndpoint, { method: "POST", body: new URLSearchParams({
    grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret,
  }) }), 200)).access_token;
  const callExchange = (actor, subjectToken) => request(exchangePath, actor, { method: "POST", body: { subjectToken } });
  const audit = [];
  async function denial(response, code, user) {
    assert.equal(response.status, 403, code);
    const body = await response.json();
    assert.deepEqual(body, { error: code, requestId: response.headers.get("x-request-id") });
    audit.push({ event: "authorization.denied", reasonCode: code, requestId: body.requestId, user });
  }
  async function exchange(actor, user, sourceToken) {
    const response = await callExchange(actor, sourceToken);
    const token = await json(response, 200);
    assert.deepEqual(Object.keys(token).sort(), ["access_token", "expires_in", "token_type"]);
    assert.equal(token.token_type, "Bearer");
    assert.ok(token.expires_in > 0 && token.expires_in <= 60);
    const delegated = claims(token.access_token);
    assert.equal(delegated.sub, user.id);
    assert.deepEqual(delegated.act, { sub: actorSubject, client_id: clientId });
    assert.equal(delegated.tenant_id, tenant);
    assert.ok(delegated.exp <= Math.min(claims(sourceToken).exp, claims(actor).exp, delegated.iat + 60));
    audit.push({ event: "delegation.exchanged", reasonCode: null, requestId: response.headers.get("x-request-id"), user });
    return token.access_token;
  }

  const actorWrite = await actorToken();
  await denial(await callExchange(actorWrite, userB.token), "not_assigned_to_app", userB);
  const assignmentA = await assign(unitA, userA, "manager");
  await assign(unitB, userB, "editor");
  await assign(unitA, reader, "manager");
  const sourceA = await login(userA), sourceB = await login(userB), sourceRead = await login(reader);
  const writerA = await exchange(actorWrite, userA, sourceA);
  const writerB = await exchange(actorWrite, userB, sourceB);
  const readerA = await exchange(actorWrite, reader, sourceRead);
  const identityResponse = await request("/v1/identity", writerA);
  const identity = await json(identityResponse, 200);
  assert.equal(identity.subject, userA.id);
  assert.equal(identity.tenantId, tenant);
  assert.deepEqual(identity.units, [unitA]);
  assert.deepEqual(identity.unitPaths, [{ id: unitA, path: `/${tenant}/${unitA}` }]);
  assert.deepEqual(identity.roles, ["core-reader", "core-writer"]);
  audit.push({ event: "delegation.authorized", reasonCode: null, requestId: identityResponse.headers.get("x-request-id"), user: userA });

  const recordPath = `/v2/data/${prefix}`;
  const definition = { schema: { type: "object", properties: { label: { type: "string" } }, required: ["label"] },
    indexed: [], uniqueKey: null, searchable: [], sensitive: [] };
  await json(await request(`/v2/data-schemas/${prefix}`, writerA, { method: "PUT", body: definition }), 200);
  const insert = (token, label) => request(recordPath, token, { method: "POST", body: { data: { label } },
    headers: { "Idempotency-Key": randomUUID() } });
  const recordA = await json(await insert(writerA, "A"), 201);
  const recordB = await json(await insert(writerB, "B"), 201);
  await denial(await request(`${recordPath}/${recordB.id}`, writerA), "unit_mismatch", userA);
  assert.deepEqual((await json(await request(recordPath, readerA), 200)).items.map(row => row.id), [recordA.id]);
  await denial(await insert(readerA, "Denied"), "capability_not_granted", reader);
  await denial(await request("/v1/applications", writerA), "capability_not_granted", userA);

  assert.equal((await fixture.admin(`users/${actorSubject}/role-mappings/realm`, [coreWriter], "DELETE")).status, 204);
  const actorRead = await actorToken();
  const appLimited = await exchange(actorRead, userA, sourceA);
  assert.deepEqual((await json(await request("/v1/identity", appLimited), 200)).roles, ["core-reader"]);
  await denial(await insert(appLimited, "Denied"), "capability_not_granted", userA);
  assert.equal((await request("/v1/identity", claims(writerA).proof)).status, 401);
  assert.equal((await callExchange(writerA, sourceA)).status, 401);

  assert.equal((await request(`${appPath}/assignments/${assignmentA.assignmentId}`, admin, { method: "DELETE" })).status, 204);
  await denial(await request("/v1/identity", appLimited), "not_assigned_to_app", userA);
  await denial(await callExchange(actorRead, sourceA), "not_assigned_to_app", userA);
  const beforeLock = await exchange(actorRead, userB, sourceB);
  assert.equal((await fixture.admin(`users/${userB.id}`, { enabled: false }, "PUT")).status, 204);
  await denial(await request("/v1/identity", beforeLock), "delegation_not_allowed", userB);

  const events = (await json(await request("/v1/audit-events?limit=100", admin), 200)).items;
  for (const { event, reasonCode, requestId, user } of audit) {
    const entries = events.filter(row => row.reason === requestId && row.event === event);
    assert.equal(entries.length, 1, `${event} ${requestId}`);
    const [entry] = entries;
    assert.equal(entry.reasonCode, reasonCode);
    assert.equal(entry.subject, user.id);
    assert.equal(entry.actorAppId, appId);
    assert.equal(entry.managementClient, clientId);
    assert.equal(entry.tenantId, tenant);
  }
  await verifyContracts("delegation");
});
