// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { createApi } from "../src/api.mjs";
import { createAuthorizer } from "../src/platform/auth/auth.mjs";
import { tokenClaims } from "../src/platform/auth/delegation.mjs";
import { requestIdFor } from "../src/platform/http/http.mjs";

const issuer = "https://identity.example.invalid/realms/junctura";
const clientId = "app-x";
const appId = "940daf7c-515c-4768-8498-a9db1316e1c1";
const assignment = "junctura-assignment-ff09d55a-b7e2-4840-865c-7cc1419b6471";
const reader = ["core-reader"], writer = [...reader, "core-writer"];
const accessType = "urn:ietf:params:oauth:token-type:access_token";
const request = (token, url = "/v1/identity", method = "GET") => ({ method, url, headers: { authorization: `Bearer ${token}` } });

function fixture(t, { userRoles = writer, actorRoles = writer, userTenant = "tenant-a", actorExpiry = 120, userExpiry = 120 } = {}) {
  let now = 10_000;
  t.mock.method(Date, "now", () => now * 1000);
  const config = { issuer, identityUrl: issuer, clientSecret: "client-secret", dataUrl: "https://data.example.invalid",
    dataSecret: "data-secret", enforceAppAccess: true };
  const original = (sub, tenant, roles, ttl) => ({ iss: issuer, aud: ["junctura-core"], sub, typ: "Bearer", azp: clientId,
    exp: now + ttl, tenant_id: tenant, tenant_memberships: [`/${tenant}`],
    groups: [`/${tenant}/unit-a/reviewers`, `/${tenant}/unit-b/reviewers`],
    realm_access: { roles }, resource_access: { [clientId]: { roles: [assignment] } } });
  const keycloakToken = claims => `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
  const actorClaims = original("service-account", "tenant-a", actorRoles, actorExpiry);
  const userClaims = { ...original("login-subject", userTenant, userRoles, userExpiry), junctura_unit: "unit-a" };
  const actor = keycloakToken(actorClaims), user = keycloakToken(userClaims);
  const proof = "keycloak.access.proof";
  const permitted = { status: 200, value: { appId, unit: "unit-a", roles: ["manager"], human: true } };
  let proofActive = true, accessResponse = permitted;
  const entries = [];
  const introspection = new Map([
    [actor, { ...actorClaims, active: true, client_id: clientId, realm_access: { roles: writer } }],
    [user, { ...userClaims, active: true, client_id: clientId, realm_access: { roles: writer } }],
  ]);
  const fetcher = async (target, options) => {
    const path = new URL(target).pathname;
    if (path.endsWith("/introspect")) {
      const token = options.body.get("token");
      if (token === proof) return Response.json({ iss: issuer, aud: "junctura-core", sub: userClaims.sub,
        client_id: "junctura-core", exp: 10_060, active: proofActive });
      return Response.json(introspection.get(token) ?? { active: false });
    }
    if (path.endsWith("/token")) {
      assert.equal(options.body.get("grant_type"), "urn:ietf:params:oauth:grant-type:token-exchange");
      assert.equal(options.body.get("client_id"), "junctura-core");
      assert.equal(options.body.get("subject_token"), user);
      assert.equal(options.body.get("requested_token_type"), accessType);
      assert.equal(options.body.get("audience"), "junctura-core");
      entries.push({ path });
      return Response.json({ access_token: proof, issued_token_type: accessType });
    }
    const claims = tokenClaims(options.headers.Authorization.slice(7));
    const { payload } = JSON.parse(options.body);
    entries.push({ path, claims, payload });
    if (path.endsWith("/record_app_denial")) return Response.json({ status: 200 });
    assert.equal(path, "/rpc/delegation_access_check");
    return Response.json(accessResponse);
  };
  const authorize = createAuthorizer(config, fetcher);
  const exchangeRequest = request(actor, "/v1/token-exchange", "POST");
  return { authorize, config, fetcher, exchangeRequest, actor, user, proof, entries, exchange: () => authorize.exchange(exchangeRequest, user),
    clock: value => { now = value; }, lock: () => { proofActive = false; },
    revoke: () => { accessResponse = { status: 403, error: "not_assigned_to_app" }; } };
}

test("the exchange route accepts only a user access token and preserves the gateway request ID", async t => {
  const f = fixture(t);
  t.mock.method(globalThis, "fetch", f.fetcher);
  const api = createApi(f.config);
  async function call(body) {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), f.exchangeRequest);
    req.headers = { ...req.headers, "content-type": "application/json", "x-junctura-request-id": "123456781234123412341234567890ab" };
    const reply = { headers: {}, setHeader(key, value) { this.headers[key] = value; },
      writeHead(status) { this.status = status; }, end(value) { this.body = JSON.parse(value); } };
    await api(req, reply);
    return reply;
  }
  const refused = await call({ subjectToken: f.user, unit: "unit-b" });
  assert.equal(refused.status, 400);
  assert.equal(f.entries.length, 0);
  const issued = await call({ subjectToken: f.user });
  assert.equal(issued.status, 200);
  assert.equal(tokenClaims(issued.body.access_token).unit, "unit-a");
  assert.equal(issued.headers["X-Request-Id"], "12345678-1234-1234-1234-1234567890ab");
  assert.equal(f.entries.at(-1).payload.requestId, issued.headers["X-Request-Id"]);
});

test("delegation binds the application, login and unit, and uses the earliest expiry", async t => {
  const f = fixture(t, { userExpiry: 14, actorExpiry: 20 });
  const response = await f.exchange();
  assert.equal(response.expires_in, 14);
  assert.equal(Object.hasOwn(response, "refresh_token"), false);
  const { sub, act, exp, unit, groups } = tokenClaims(response.access_token);
  assert.deepEqual({ sub, act, exp, unit, groups }, { sub: "login-subject", act: { sub: "service-account", client_id: clientId },
    exp: 10_014, unit: "unit-a", groups: ["/unit-a/reviewers"] });
  const { claims, payload } = f.entries.at(-1);
  assert.equal(claims.tenant_id, "tenant-a");
  assert.equal(claims.sub, sub);
  assert.equal(claims.actor_sub, act.sub);
  assert.equal(claims.client_id, clientId);
  assert.deepEqual(claims.client_roles, [assignment]);
  assert.equal(payload.delegationEvent, "exchanged");
  assert.equal(payload.requestId, requestIdFor(f.exchangeRequest));
  assert.equal(payload.write, false);

  await f.authorize(request(response.access_token, "/internal/auth"), true);
  assert.equal(f.entries.at(-1).payload.delegationEvent, undefined);
  const identity = await f.authorize(request(response.access_token), true);
  assert.deepEqual(identity.actor, act);
  assert.deepEqual(identity.roles, writer);
  assert.deepEqual(identity.units, [unit]);
  assert.equal(identity.humanAppId, appId);
  assert.deepEqual(identity.assignmentRoles, [assignment]);
  assert.equal(f.entries.at(-1).payload.delegationEvent, "authorized");
  const [header, body, signature] = response.access_token.split(".");
  const forged = `${header}.${Buffer.from(JSON.stringify({ ...tokenClaims(response.access_token), unit: "unit-b" })).toString("base64url")}.${signature}`;
  await assert.rejects(f.authorize(request(forged), true), { status: 401, message: "invalid_token" });
  await assert.rejects(f.authorize(request(f.proof), true), { status: 401, message: "invalid_token" });
  await assert.rejects(f.authorize.exchange(request(response.access_token), f.user), { status: 401, message: "invalid_token" });
  f.clock(exp);
  await assert.rejects(f.authorize(request(response.access_token), true), { status: 401, message: "invalid_token" });
});

test("a read-only input stays read-only even if introspection and the app role allow writing", async t => {
  for (const roles of [{ userRoles: reader }, { actorRoles: reader }]) {
    const f = fixture(t, roles);
    const { access_token } = await f.exchange();
    const identity = await f.authorize(request(access_token), true);
    assert.deepEqual(identity.roles, reader);
    assert.deepEqual(identity.appRoles, ["viewer"]);
    assert.equal(f.entries.at(-1).claims.delegated_writer, false);
  }
});

test("delegated viewers can submit and cancel consent requests through the assignment check", async t => {
  const f = fixture(t, { userRoles: reader });
  const { access_token } = await f.exchange();
  const requests = "/v1/resource-consent-requests";
  for (const path of [requests, `${requests}/${appId}/cancel`]) {
    const identity = await f.authorize(request(access_token, path, "POST"), true);
    assert.deepEqual(identity.roles, reader);
    assert.equal(f.entries.at(-1).payload.userRoute, true);
    assert.equal(f.entries.at(-1).payload.write, false);
  }
  await f.authorize(request(access_token, "/v2/data/example", "POST"), true);
  assert.equal(f.entries.at(-1).payload.write, true);
  await f.authorize(request(access_token, `${requests}/../me/consents`, "POST"), true);
  assert.equal(f.entries.at(-1).payload.userRoute, false);
  assert.equal(f.entries.at(-1).payload.write, true);
});

test("only the three delegated workflow execution operations are user routes", async t => {
  const f = fixture(t);
  const { access_token } = await f.exchange();
  const cases = [
    ["/v1/workflows/executions", "POST", true],
    ["/v1/workflows/executions/run-1", "GET", true],
    ["/v1/workflows/executions/run-1/history", "GET", true],
    ["/v1/workflows/executions", "GET", false],
    ["/v1/workflows/executions/run-1", "DELETE", false],
    ["/v1/workflows/executions/run-1/complete", "POST", false],
    ["/v1/workflows/tasks", "GET", false],
    ["/v1/workflows/tasks/task-1/claim", "POST", false],
    ["/v1/workflows/tasks/task-1/release", "POST", false],
    ["/v1/workflows/definitions", "GET", false],
    ["/v1/workflows/definitions", "POST", false],
    ["/v1/workflows/summary", "GET", false],
  ];
  for (const [path, method, expected] of cases) {
    await f.authorize(request(access_token, path, method), true);
    assert.equal(f.entries.at(-1).payload.userRoute, expected, `${method} ${path}`);
  }
});

test("delegated calls recheck assignment and log an inactive user proof with both identities", async t => {
  const f = fixture(t);
  const { access_token } = await f.exchange();
  const req = request(access_token);
  f.revoke();
  await assert.rejects(f.authorize(req, true), { status: 403, message: "not_assigned_to_app" });
  assert.equal(f.entries.at(-1).path, "/rpc/delegation_access_check");
  f.lock();
  await assert.rejects(f.authorize(req, true), { status: 403, message: "delegation_not_allowed" });
  const { claims, path, payload } = f.entries.at(-1);
  assert.equal(path, "/rpc/record_app_denial");
  assert.equal(claims.sub, "login-subject");
  assert.equal(claims.actor_sub, "service-account");
  assert.equal(claims.client_id, clientId);
  assert.deepEqual(payload, { requestId: requestIdFor(req), code: "delegation_not_allowed" });
});

test("exchange stops before Keycloak exchange across tenants or without an assignment", async t => {
  const crossTenant = fixture(t, { userTenant: "tenant-b" });
  await assert.rejects(crossTenant.exchange(), { status: 403, message: "delegation_not_allowed" });
  assert.deepEqual(crossTenant.entries.map(entry => entry.path), ["/rpc/record_app_denial"]);
  assert.equal(crossTenant.entries[0].claims.tenant_id, "tenant-a");

  const unassigned = fixture(t);
  unassigned.revoke();
  await assert.rejects(unassigned.exchange(), { status: 403, message: "not_assigned_to_app" });
  assert.deepEqual(unassigned.entries.map(entry => entry.path), ["/rpc/delegation_access_check"]);
});
