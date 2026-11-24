// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { test } from "node:test";
import { createApi } from "../src/api.mjs";
import { HttpError } from "../src/platform/http/http.mjs";
import { handleApplications } from "../src/modules/applications/applications.mjs";
import { accessFlows, consoleAccessRoles, createApplicationProvider } from "../src/modules/applications/keycloak.mjs";
import { handleApplicationManagement, parseAppList, validateAppMetadata, validateAssignment } from "../src/modules/applications/management.mjs";
import { createAuthorizer } from "../src/platform/auth/auth.mjs";
import { DIRECTORY_SYNC_ROLES } from "../scripts/provision-directory.mjs";

const appId = "11111111-1111-4111-8111-111111111111";
const assignmentId = "22222222-2222-4222-8222-222222222222";
const rotationId = "33333333-3333-4333-8333-333333333333";
const appPath = `/v1/applications/${appId}`;
const issuer = "https://identity.example.invalid/realms/junctura";
const config = { dataUrl: "http://data.invalid", dataSecret: "x".repeat(32), identityUrl: issuer, issuer, clientSecret: "test" };
const url = value => new URL(value, "http://core");
const response = () => ({
  headers: {},
  setHeader(key, value) { this.headers[key] = value; },
  writeHead(status) { this.statusCode = status; },
  end(body) { this.body = body === undefined ? body : JSON.parse(body); },
});
function request(method, payload, headers = {}) {
  const req = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))]);
  req.method = method;
  req.headers = { "content-type": "application/json", ...headers };
  return req;
}
const jsonResponse = value => Response.json(value);

test("application lists validate filters, duplicate keys and opaque cursors", () => {
  assert.deepEqual(parseAppList(url(`/v1/applications?cursor=${appId}&q=App+X&state=active&limit=1&unit=unit-a`)),
    { limit: 1, after: appId, state: "active", q: "App X", unit: "unit-a" });
  for (const query of ["state=other", "limit=0", "limit=101", "cursor=wrong", "q=", "unit=*", "q=a&q=b", "tenant=tenant-b"]) {
    assert.throws(() => parseAppList(url(`/v1/applications?${query}`)), { status: 400, message: "invalid_query" });
  }
});

test("metadata patch and assignments validate closed fields and preserve the ETag", async () => {
  const patch = { displayName: "App X", ownerUnit: "unit-a", deploymentUnits: ["unit-b", "unit-a"] };
  for (const input of [{}, { ownerSubject: "caller" }, { deploymentUnits: ["unit-a", "unit-a"] }]) {
    assert.throws(() => validateAppMetadata(input), { status: 400 });
  }
  for (const targetType of ["unit", "group", "subject"]) {
    const input = { unit: "unit-a", targetType, target: targetType === "unit" ? "unit-a" : "reviewer", role: "viewer" };
    assert.equal(validateAssignment(input), input);
    assert.throws(() => validateAssignment({ ...input, role: "core-writer" }), { status: 400 });
  }
  const reply = response();
  await handleApplicationManagement(request("PATCH", patch, { "if-match": `"application-${appId}-1"` }),
    reply, {}, config, url(appPath), async (operation, payload) => {
      assert.equal(operation, "update");
      assert.deepEqual(payload, { ...patch, appId, etag: `"application-${appId}-1"` });
      return { value: { ...patch, appId, revision: 2 } };
    });
  assert.equal(reply.statusCode, 200);
  assert.equal(reply.headers.ETag, `"application-${appId}-2"`);
});

test("both client flows check the client role after authenticating the user", () => {
  const [browser, direct] = accessFlows("example", "app-x");
  for (const flow of [browser, direct]) {
    assert.equal(flow.children[0].requirement, undefined);
    const gate = flow.children.at(-1);
    assert.equal(gate.requirement, "CONDITIONAL");
    assert.deepEqual(gate.children[0].config, { condUserRole: "app-x.junctura-access", negate: "true" });
    assert.equal(gate.children[1].config.denyErrorMessage, "not_assigned_to_app");
  }
  const realm = JSON.parse(readFileSync(new URL("../infra/keycloak/realm.json", import.meta.url)));
  const console = realm.clients.find(client => client.clientId === "junctura-console");
  for (const id of Object.values(console.authenticationFlowBindingOverrides)) {
    assert.ok(realm.authenticationFlows.some(flow => flow.id === id && flow.topLevel));
  }
  assert.deepEqual(realm.roles.client[console.clientId].filter(role => role.composite).map(role => role.name), consoleAccessRoles);
});

test("imported and provisioned Console flows enforce the same OTP policy", () => {
  const realm = JSON.parse(readFileSync(new URL("../infra/keycloak/realm.json", import.meta.url)));
  const configs = new Map(realm.authenticatorConfig.map(({ alias, config }) => [alias, config]));
  const flows = new Map(realm.authenticationFlows.map(flow => [flow.alias, flow.authenticationExecutions]));
  function imported(alias) {
    return flows.get(alias).toSorted((a, b) => a.priority - b.priority).map(execution => ({
      name: execution.flowAlias ?? execution.authenticator, requirement: execution.requirement,
      ...(execution.flowAlias ? { children: imported(execution.flowAlias) } : {}),
      ...(execution.authenticatorConfig ? { config: configs.get(execution.authenticatorConfig) } : {}),
    }));
  }
  function provisioned(children) {
    return children.map(({ priority, ...child }, index) => ({ priority: priority ?? index * 10, child }))
      .sort((a, b) => a.priority - b.priority)
      .map(({ child: { name, requirement = "REQUIRED", config, children } }) => ({ name, requirement,
        ...(config ? { config } : {}), ...(children ? { children: provisioned(children) } : {}),
      }));
  }
  for (const flow of accessFlows("junctura-junctura-console", "junctura-console")) {
    assert.deepEqual(imported(flow.alias), provisioned(flow.children));
  }
});

test("realm import grants the app-sync service account its management permissions", () => {
  const realm = JSON.parse(readFileSync(new URL("../infra/keycloak/realm.json", import.meta.url)));
  const client = realm.clients.find(entry => entry.clientId === "junctura-app-sync");
  assert.equal(client.enabled, "${APP_SYNC_CLIENT_ENABLED:false}");
  assert.equal(client.secret, "${APP_SYNC_CLIENT_SECRET:}");
  assert.equal(client.serviceAccountsEnabled, true);
  assert.equal(client.publicClient, false);
  assert.equal(client.standardFlowEnabled, false);
  assert.equal(client.directAccessGrantsEnabled, false);
  const account = realm.users.find(entry => entry.serviceAccountClientId === client.clientId);
  assert.equal(account.username, "service-account-junctura-app-sync");
  assert.equal(account.enabled, true);
  assert.deepEqual(account.clientRoles, {
    "realm-management": [...DIRECTORY_SYNC_ROLES, "manage-clients", "manage-realm"],
  });
});

test("Keycloak updates supported client fields and leaves unrelated scopes alone", async () => {
  const clientId = "app-x";
  const client = { id: "client-key", clientId, type: "oidc", standardFlowEnabled: false,
    redirectUris: ["https://app.example.invalid/callback"], attributes: { custom: "keep" } };
  const flows = accessFlows(`junctura-${appId}`, clientId);
  const executions = new Map();
  function seed(alias, children) {
    executions.set(alias, children.map(({ name, requirement = "REQUIRED", config, children }) => {
      if (children) seed(name, children);
      return { id: name, level: 0, requirement, displayName: name, providerId: name,
        authenticationConfig: config ? name : undefined };
    }));
  }
  for (const flow of flows) seed(flow.alias, flow.children);
  const writes = [];
  let stored = client;
  const provider = createApplicationProvider({ ...config, appSyncClientId: "sync", appSyncSecret: "test" }, undefined,
    async (input, options) => {
      const path = url(input).pathname;
      if (path.endsWith("/token")) return jsonResponse({ access_token: "admin", expires_in: 60 });
      if (path.endsWith("/clients")) return jsonResponse([client]);
      if (path.endsWith("/roles/junctura-access")) return jsonResponse({ id: "role" });
      if (path.endsWith("/authentication/flows")) return jsonResponse(flows.map(({ alias }) => ({ id: alias, alias })));
      if (path.endsWith("/executions")) return jsonResponse(executions.get(path.split("/").at(-2)));
      if (path.includes("/authentication/config/")) return jsonResponse({ id: "config",
        config: path.endsWith("conditional-user-role") ? { condUserRole: "app-x.junctura-access", negate: "true" }
          : { denyErrorMessage: "not_assigned_to_app" } });
      if (path.endsWith("/optional-client-scopes")) return jsonResponse([{ name: "offline_access", id: "offline" }]);
      if (path.endsWith("/protocol-mappers/models") && options.method === "GET") return jsonResponse([]);
      if (path.endsWith("/clients/client-key") && options.method === "GET") return jsonResponse(stored);
      writes.push([path.split("/clients/").at(-1), options.method]);
      if (path.endsWith("/clients/client-key")) {
        const update = JSON.parse(options.body);
        assert.deepEqual(Object.keys(update).sort(), ["attributes", "authenticationFlowBindingOverrides", "clientId",
          "id", "implicitFlowEnabled", "standardFlowEnabled", "type"].sort());
        assert.equal(update.clientId, clientId);
        assert.equal(update.standardFlowEnabled, false);
        assert.equal(update.attributes["oidc.ciba.grant.enabled"], "false");
        assert.equal(update.attributes["oauth2.device.authorization.grant.enabled"], "false");
        assert.equal(update.attributes.custom, "keep");
        stored = { ...client, ...update };
      }
      return new Response(null, { status: 204 });
    });
  await provider.configure(clientId, appId);
  assert.deepEqual(writes, [["client-key", "PUT"], ["client-key/optional-client-scopes/offline", "DELETE"],
    ["client-key/protocol-mappers/models", "POST"]]);
});

test("approval reports invalid SQL preconditions before calling the provider", async t => {
  const phases = [];
  t.mock.method(globalThis, "fetch", async (input, options) => {
    const path = url(input).pathname;
    const { operation, payload } = JSON.parse(options.body);
    phases.push(operation);
    assert.equal(payload.appId, appId);
    if (path.endsWith("/application_command") && operation === "approve_check" && !payload.etag) {
      return jsonResponse({ status: 428, error: "if_match_required" });
    }
    if (operation === "lease") return jsonResponse({ status: 200, value: { providerReady: true, oauthClientId: "app-x" } });
    return jsonResponse({ status: 200, value: { appId, revision: 2 } });
  });
  const approve = headers => handleApplications(request("POST", { approvalId: assignmentId }, headers), response(),
    { tenantId: "tenant-a", issuer, subject: "approver", clientId: "management", roles: [] },
    { ...config, appSyncClientId: "sync", appSyncSecret: "test" }, url(`${appPath}/approve`));
  await assert.rejects(approve({}), { status: 428, message: "if_match_required" });
  assert.deepEqual(phases, ["approve_check"]);
  await approve({ "if-match": `"application-${appId}-1"` });
  assert.deepEqual(phases, ["approve_check", "approve_check", "lease", "approve", "release"]);
});

test("only application management routes send a target to the access check", async () => {
  let target;
  const authorize = createAuthorizer({ ...config, enforceAppAccess: true }, async (path, options) => {
    if (path.endsWith("/introspect")) return jsonResponse({
      active: true, iss: issuer, aud: "junctura-core", exp: Date.now() / 1000 + 120,
      sub: "owner", tenant_id: "tenant-a", tenant_memberships: ["/tenant-a"],
      realm_access: { roles: ["core-reader"] }, client_id: "app-x",
    });
    target = JSON.parse(options.body).payload.managementAppId;
    return jsonResponse({ status: 200, value: null });
  });
  for (const [method, url, expected] of [
    ["GET", "/internal/auth", null],
    ["GET", "/v1/applications?limit=10", null],
    ["GET", appPath, appId],
    ["PATCH", appPath, appId],
    ["GET", `${appPath}/assignments`, appId],
    ["POST", `${appPath}/assignments`, appId],
    ["DELETE", `${appPath}/assignments/${assignmentId}`, appId],
    ["GET", `${appPath}/oidc-keys`, appId],
    ["POST", `${appPath}/oidc-keys`, appId],
    ["POST", `${appPath}/approve`, undefined],
    ["DELETE", `${appPath}/oidc-keys/${rotationId}`, undefined],
    ["GET", "/v1/applications/stats", undefined],
    ["GET", "/v1/identity", undefined],
  ]) {
    await authorize({ method, url, headers: { authorization: "Bearer a.b.c" } });
    assert.equal(target, expected, `${method} ${url}`);
  }
});

test("authorizer carries selected units and current role decisions, including denied old tokens", async () => {
  const claims = { active: true, iss: issuer, aud: "junctura-core", exp: Date.now() / 1000 + 120,
    sub: "subject", tenant_id: "tenant-a", tenant_memberships: ["/tenant-a"],
    groups: ["/tenant-a/unit-a/reviewers", "/tenant-a/unit-b/reviewers"], junctura_unit: "unit-a",
    realm_access: { roles: ["core-reader", "core-writer"] }, client_id: "app-x",
    resource_access: { "app-x": { roles: [`junctura-assignment-${assignmentId}`] } } };
  let result = { status: 200, value: { appId, unit: "unit-a", roles: ["viewer"], human: true } };
  const authorize = createAuthorizer({ ...config, enforceAppAccess: true }, async (path, options) => {
    if (path.endsWith("/introspect")) return jsonResponse(claims);
    assert.ok(path.endsWith("/rpc/app_access_check"));
    const assertion = JSON.parse(Buffer.from(options.headers.Authorization.split(".")[1], "base64url"));
    assert.deepEqual(assertion.client_roles, [`junctura-assignment-${assignmentId}`]);
    assert.equal(assertion.app_unit, "unit-a");
    const { payload } = JSON.parse(options.body);
    assert.equal(payload.userRoute, true);
    assert.match(payload.requestId, /^[0-9a-f-]{36}$/);
    return jsonResponse(result);
  });
  const req = { method: "GET", url: "/v2/data/records", headers: { authorization: "Bearer a.b.c" } };
  const identity = await authorize(req, true);
  assert.deepEqual(identity.units, ["unit-a"]);
  assert.deepEqual(identity.groups, ["/unit-a/reviewers"]);
  assert.deepEqual(identity.roles, ["core-reader"]);
  assert.equal(identity.humanAppId, appId);
  result = { status: 403, error: "not_assigned_to_app" };
  await assert.rejects(authorize(req, true), { status: 403, message: "not_assigned_to_app" });
});

test("rotation reuses the staged secret after Keycloak fails and returns only receipts", async t => {
  let staged, applied, failUpdate = true, committed = false;
  const phases = [];
  const client = { id: "client-key", clientId: "app-x", publicClient: false, clientAuthenticatorType: "client-secret" };
  t.mock.method(globalThis, "fetch", async (input, options) => {
    const path = url(input).pathname;
    if (path.endsWith("/token")) return jsonResponse({ access_token: "admin", expires_in: 60 });
    if (path.includes("/oidc-clients/")) {
      if (options.method === "GET") return staged ? jsonResponse({ data: { data: { clientSecret: staged } } }) : new Response(null, { status: 404 });
      assert.equal(JSON.parse(options.body).options.cas, 0);
      assert.equal(staged, undefined);
      staged = JSON.parse(options.body).data.clientSecret;
      return jsonResponse({ data: { version: 1 } });
    }
    if (path.endsWith("/clients")) return jsonResponse([client]);
    if (path.endsWith("/client-secret")) return jsonResponse({ value: applied });
    if (path.endsWith("/client-secret/rotated")) return new Response(null, { status: 204 });
    assert.ok(path.endsWith("/clients/client-key"));
    if (options.method === "GET") return jsonResponse(client);
    if (failUpdate) return new Response(null, { status: 503 });
    applied = JSON.parse(options.body).secret;
    return new Response(null, { status: 204 });
  });
  const isolated = { ...config, appSyncClientId: "sync", appSyncSecret: "test", secretsUrl: "http://bao.invalid", secretsToken: "test" };
  const command = async (operation, payload) => {
    phases.push(operation);
    assert.equal(payload.appId, appId);
    if (operation === "lease") return { value: { oauthClientId: "app-x" } };
    if (operation === "rotation_start") return { value: { applied: committed } };
    if (operation === "rotation_confirm") committed = true;
    if (operation === "rotation_history") return { value: { items: [{ rotationId, appliedAt: "2026-11-23T00:00:00Z" }] } };
    return {};
  };
  function run(reply) {
    return handleApplicationManagement(request("POST", {}, { "idempotency-key": rotationId }), reply,
      { tenantId: "tenant-a" }, isolated, url(`${appPath}/oidc-keys`), command);
  }
  await assert.rejects(run(response()), { status: 503, message: "app_provider_unavailable" });
  assert.ok(staged);
  assert.equal(committed, false);
  const retry = response();
  failUpdate = false;
  await run(retry);
  assert.equal(applied, staged);
  assert.equal(committed, true);
  assert.deepEqual(retry.body.items, [{ rotationId, appliedAt: "2026-11-23T00:00:00Z" }]);
  assert.equal(phases.filter(value => value === "rotation_confirm").length, 1);
  assert.equal(phases.filter(value => value === "release").length, 2);
});

test("Console reuses roles for three seconds and refuses old tokens at expiry", async t => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const claims = { active: true, iss: issuer, aud: "junctura-core", exp: Date.now() / 1000 + 120,
    sub: "subject", tenant_id: "tenant-a", tenant_memberships: ["/tenant-a"],
    realm_access: { roles: ["core-reader"] }, client_id: "junctura-console",
    resource_access: { "junctura-console": { roles: ["console-viewer"] } } };
  let live = ["console-viewer"], unavailable = false, lookups = 0, accessChecks = 0;
  const authorize = createAuthorizer({ ...config, enforceAppAccess: true, async currentConsoleRoles(subject) {
    lookups++;
    if (unavailable) throw new Error("provider unavailable");
    return subject === "subject" ? live : [];
  } }, async (path, options) => {
    if (path.endsWith("/introspect")) return jsonResponse(claims);
    accessChecks++;
    const assertion = JSON.parse(Buffer.from(options.headers.Authorization.split(".")[1], "base64url"));
    return jsonResponse(assertion.console_role === "viewer"
      ? { status: 200, value: null }
      : { status: 403, error: "not_assigned_to_app" });
  });
  const input = { method: "GET", url: "/v1/identity", headers: { authorization: "Bearer a.b.c" } };
  assert.equal((await authorize(input, true)).consoleRole, "viewer");
  assert.equal(lookups, 1);
  live = [];
  now = 2999;
  assert.equal((await authorize(input, true)).consoleRole, "viewer");
  assert.equal(lookups, 1);
  claims.sub = "other-subject";
  await assert.rejects(authorize(input, true), { status: 403, message: "not_assigned_to_app" });
  claims.sub = "subject";
  now = 3000;
  unavailable = true;
  await assert.rejects(authorize(input, true), { status: 503, message: "identity_unavailable" });
  unavailable = false;
  await assert.rejects(authorize(input, true), { status: 403, message: "not_assigned_to_app" });
  assert.equal(lookups, 4);
  assert.equal(accessChecks, 4);
});

test("gateway authorization and the public route use the same audit request ID", async t => {
  const calls = [];
  let result = { status: 200, value: null };
  t.mock.method(globalThis, "fetch", async (path, options) => {
    if (path.endsWith("/introspect")) return jsonResponse({
      active: true, iss: issuer, aud: "junctura-core", exp: Date.now() / 1000 + 120,
      sub: "subject", tenant_id: "tenant-a", tenant_memberships: ["/tenant-a"],
      realm_access: { roles: ["core-reader"] }, client_id: "app-x",
    });
    assert.ok(path.endsWith("/rpc/app_access_check"));
    calls.push(JSON.parse(options.body).payload);
    return jsonResponse(result);
  });
  const api = createApi({ ...config, enforceAppAccess: true });
  const gatewayId = "123456781234123412341234567890ab";
  const requestId = "12345678-1234-1234-1234-1234567890ab";
  async function call(method, url) {
    const input = request(method, undefined, { authorization: "Bearer a.b.c", "x-junctura-request-id": gatewayId });
    input.url = url;
    const reply = response();
    await api(input, reply);
    return reply;
  }
  assert.equal((await call("GET", "/internal/auth")).statusCode, 204);
  result = { status: 403, error: "capability_not_granted" };
  const main = await call("POST", `${appPath}/assignments`);
  assert.deepEqual(main.body, { error: result.error, requestId });
  assert.deepEqual(calls.map(({ requestId, write }) => [requestId, write]), [[requestId, false], [requestId, true]]);
  result = { status: 403, error: "not_assigned_to_app" };
  const refused = await call("GET", "/internal/auth");
  assert.equal(refused.headers["X-Junctura-Auth-Error"], result.error);
  assert.deepEqual(refused.body, { error: result.error, requestId });
  assert.equal(calls.at(-1).requestId, requestId);
});

test("capability denials are audited once with the public code and request ID, with or without the app access gate", async t => {
  const audited = [];
  t.mock.method(globalThis, "fetch", async (path, options) => {
    if (path.endsWith("/introspect")) return jsonResponse({
      active: true, iss: issuer, aud: "junctura-core", exp: Date.now() / 1000 + 120,
      sub: "subject", tenant_id: "tenant-a", tenant_memberships: ["/tenant-a"],
      realm_access: { roles: ["core-reader", "core-writer"] }, client_id: "app-x",
    });
    if (path.endsWith("/rpc/app_access_check")) return jsonResponse({ status: 200, value: null });
    assert.ok(path.endsWith("/rpc/record_app_denial"));
    audited.push(JSON.parse(options.body).payload);
    return jsonResponse({ status: 200 });
  });
  for (const accessConfig of [{}, { enforceAppAccess: true }]) {
    for (const [failure, code] of [
      ["invoke_not_authorized", "capability_not_granted"],
      ["consent_required", "consent_required"], ["consent_expired", "consent_expired"], ["consent_revoked", "consent_revoked"],
    ]) {
      const api = createApi({ ...config, ...accessConfig,
        executionRuntime: { handle() { throw new HttpError(403, failure); } } });
      const input = request("POST", {}, { authorization: "Bearer a.b.c" });
      input.url = "/v1/capability-executions";
      const reply = response();
      const before = audited.length;
      await api(input, reply);
      assert.equal(reply.statusCode, 403);
      assert.deepEqual(reply.body, { error: code, requestId: reply.headers["X-Request-Id"] });
      assert.deepEqual(audited.slice(before), [{ code, requestId: reply.body.requestId }]);
    }
  }
});
