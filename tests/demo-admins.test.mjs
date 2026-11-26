// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  ADMIN_PERMISSIONS, DEFAULT_JUDGE_EXPIRY, DEMO_ACCOUNT, DEMO_ADMINS, DEMO_INSPECTOR,
  ENVIRONMENT_ACCOUNTS, JUDGE_ACCOUNT, READER_PERMISSIONS,
  accountsFor, buildDisablePrincipalStatement, buildPrincipalStatement, buildUserUpdate,
  disableJudge, disableLegacyViewer, knownPasswords, main, mergeCredentials,
  parseCredentials, parseHints, parseJudgeExpiry, parseOptions, parseTenants,
  planPasswords, provisionTenant, publicAccounts, toLoginHints,
} from "../scripts/provision-demo-admins.mjs";
import { ensureTenantGroup } from "../scripts/lib/demo-stack.mjs";

const NOW = new Date("2026-11-17T12:00:00Z");
const ISSUER = "https://demo.example/identity/realms/junctura";
const credential = (account, password = `simulated-${account.username}`) => ({
  username: account.username, password, label: account.label, tenant: account.tenant,
});

test("environment profiles keep demo public and all production accounts private", () => {
  assert.deepEqual(accountsFor(["demo"]), [DEMO_ACCOUNT, DEMO_INSPECTOR]);
  assert.deepEqual(accountsFor(["production"]), [...DEMO_ADMINS, JUDGE_ACCOUNT]);
  assert.deepEqual(accountsFor(), ENVIRONMENT_ACCOUNTS);
  assert.deepEqual(DEMO_ADMINS.map(account => account.username), ["admin1", "admin2", "admin3"]);
  for (const account of accountsFor(["production"])) {
    assert.equal(account.tenant, "production");
    assert.equal(account.public, false);
  }
  assert.equal(DEMO_ACCOUNT.label, "Tài khoản demo (chỉ xem)");
  assert.equal(DEMO_INSPECTOR.public, false);
  assert.equal(JUDGE_ACCOUNT.displayName, "Giám khảo");
  assert.equal(JUDGE_ACCOUNT.jobTitle, "Chỉ xem");
});

test("parseTenants accepts only nonempty demo/production lists and deduplicates", () => {
  assert.deepEqual(parseTenants(), ["demo", "production"]);
  assert.deepEqual(parseTenants("demo,production"), ["demo", "production"]);
  assert.deepEqual(parseTenants(" production, demo,production "), ["production", "demo"]);
  for (const text of ["", " ", "tenant-a", "unknown", "demo,unknown", "demo,", ",production", "Demo", null]) {
    assert.throws(() => parseTenants(text), /Unknown environment tenant/);
  }
  assert.throws(() => accountsFor(["tenant-a"]), /Unknown environment tenant/);
});

test("options default to both environments and reject legacy tenant/public-admins flags", () => {
  const options = parseOptions([], NOW, {});
  assert.deepEqual(options.tenants, ["demo", "production"]);
  assert.deepEqual(options.judgeExpiry, { date: DEFAULT_JUDGE_EXPIRY, enabled: true });
  assert.equal(options.credentials, ".junctura/demo-accounts.json");
  assert.throws(() => parseOptions(["--tenant", "tenant-a"], NOW, {}), /--tenant.*use --tenants/);
  assert.throws(() => parseOptions(["--tenant"], NOW, {}), /--tenant.*use --tenants/);
  assert.throws(() => parseOptions(["--tenant=demo"], NOW, {}), /--tenant.*use --tenants/);
  assert.throws(() => parseOptions(["--public-admins"], NOW, {}), /Unknown option/);
  assert.throws(() => parseOptions(["--tenants", "tenant-a"], NOW, {}), /Unknown environment tenant/);
  assert.throws(() => parseOptions(["--judge-expires", "2026-02-29"], NOW, {}), /Invalid --judge-expires/);
  assert.throws(() => parseOptions(["--disable-judge", "--judge-expires", "2026-02-29"], NOW, {}), /Invalid --judge-expires/);
  assert.deepEqual(parseOptions(["--judge-expires", "2026-11-16"], NOW, {}).judgeExpiry, { date: "2026-11-16", enabled: false });
  for (const option of ["--base", "--admin-base"]) {
    assert.throws(() => parseOptions([option, " "], NOW, {}), /must not be empty/);
  }
});

test("judge expiry is a strict calendar date, inclusive of the final UTC day", () => {
  assert.deepEqual(parseJudgeExpiry(undefined, NOW), { date: "2026-12-15", enabled: true });
  assert.deepEqual(parseJudgeExpiry("2026-12-15", new Date("2026-12-15T23:59:59.999Z")), { date: "2026-12-15", enabled: true });
  assert.deepEqual(parseJudgeExpiry("2026-12-15", new Date("2026-12-16T00:00:00Z")), { date: "2026-12-15", enabled: false });
  assert.equal(parseJudgeExpiry("2028-02-29", NOW).enabled, true);
  for (const text of ["2026-02-29", "2026-04-31", "2026-00-01", "2026-13-01", "2026-12-00", "2026-2-01", "2026-12-15T00:00:00Z", " 2026-12-15", "", null]) {
    assert.throws(() => parseJudgeExpiry(text, NOW), /Invalid --judge-expires/);
  }
});

test("parseHints ignores malformed and empty entries", () => {
  const passwords = parseHints(JSON.stringify({ accounts: [
    { username: " admin1 ", password: "simulated-one" },
    { username: " ", password: "ignored" },
    { username: "admin2" },
    { username: "admin3", password: "" },
    null,
  ] }));
  assert.deepEqual([...passwords], [["admin1", "simulated-one"]]);
  for (const text of ["not json", "null", "{}", '{"accounts":{}}']) assert.equal(parseHints(text).size, 0);
});

test("legacy private credentials infer the new tenant to survive partial provisioning", () => {
  const legacy = JSON.stringify({ accounts: [
    { username: "admin1", password: "simulated-private", label: "Admin 1" },
    { username: "demo", password: "simulated-public" },
  ] });
  assert.deepEqual(parseCredentials(legacy), [credential(DEMO_ADMINS[0], "simulated-private"), credential(DEMO_ACCOUNT, "simulated-public")]);
  assert.deepEqual(parseCredentials("invalid"), []);
});

test("password planning reuses private passwords, generates missing ones and rotates on reset", () => {
  const existing = new Map([["admin1", "simulated-kept"]]);
  const generated = ["simulated-new2", "simulated-new3"];
  const reused = planPasswords(DEMO_ADMINS, existing, () => generated.shift());
  assert.deepEqual(reused.map(account => account.password), ["simulated-kept", "simulated-new2", "simulated-new3"]);
  assert.equal(planPasswords(DEMO_ADMINS.slice(0, 1), existing, () => "simulated-rotated", true)[0].password, "simulated-rotated");
});

test("public hints contain only demo and exactly the browser-facing fields", () => {
  const accounts = ENVIRONMENT_ACCOUNTS.map(account => ({ ...account, password: "simulated" }));
  assert.deepEqual(publicAccounts(accounts).map(account => account.username), ["demo"]);
  assert.deepEqual(toLoginHints(accounts), { accounts: [{ username: "demo", password: "simulated", label: DEMO_ACCOUNT.label }] });
  assert.deepEqual(publicAccounts(accountsFor(["production"]).map(account => ({ ...account, public: true }))), []);
});

test("non-public passwords in public hints are disclosed even when also stored privately", () => {
  const published = new Map([["admin1", "simulated-leaked"], ["giamkhao", "simulated-judge"], ["demo", "simulated-public"]]);
  assert.deepEqual([...knownPasswords(new Map(), published)], [["demo", "simulated-public"]]);
  const privatePasswords = new Map([["admin1", "simulated-private"], ["giamkhao", "simulated-judge"], ["admin2", "simulated-public"]]);
  const known = knownPasswords(privatePasswords, published);
  assert.equal(known.get("admin1"), "simulated-private");
  assert.equal(known.has("giamkhao"), false);
  assert.equal(known.has("admin2"), false);
  assert.equal(planPasswords([JUDGE_ACCOUNT], known, () => "simulated-regenerated")[0].password, "simulated-regenerated");
  assert.equal(privatePasswords.get("giamkhao"), "simulated-judge");
});

test("credential merging preserves other tenants and emits private fields only", () => {
  const existing = ENVIRONMENT_ACCOUNTS.map(account => credential(account));
  const snapshot = structuredClone(existing);
  const provisioned = [{ ...DEMO_ACCOUNT, password: "simulated-new" }];
  const merged = mergeCredentials(existing, provisioned, ["demo"]);
  assert.deepEqual(merged.filter(account => account.tenant === "production"), existing.filter(account => account.tenant === "production"));
  assert.deepEqual(merged.find(account => account.username === "demo"), credential(DEMO_ACCOUNT, "simulated-new"));
  for (const account of merged) assert.deepEqual(Object.keys(account), ["username", "password", "label", "tenant"]);
  assert.deepEqual(existing, snapshot);
  const production = mergeCredentials(existing, [...DEMO_ADMINS, JUDGE_ACCOUNT].map(account => credential(account, "simulated-new")), ["production"]);
  assert.deepEqual(production.find(account => account.username === "demo"), existing[0]);
  const migrated = mergeCredentials([{ ...credential(DEMO_ADMINS[0]), tenant: "tenant-a" }], [credential(DEMO_ADMINS[0])], ["production"]);
  assert.deepEqual(migrated, [credential(DEMO_ADMINS[0])]);
});

test("admin principal SQL grants the full permission set and escapes every text field", () => {
  const statement = buildPrincipalStatement({
    tenant: "production'", issuer: "https://example.invalid/'issuer", subject: "subject'id",
    profile: { ...DEMO_ADMINS[0], displayName: "Quản trị 'viên'", jobTitle: "Admin's title" },
  });
  for (const literal of ["'production'''", "'https://example.invalid/''issuer'", "'subject''id'", "'Quản trị ''viên'''", "'Admin''s title'"]) assert.ok(statement.includes(literal));
  assert.match(statement, /ON CONFLICT \(tenant_id,issuer,subject,management_client\) DO UPDATE/);
  for (const permission of ADMIN_PERMISSIONS) assert.ok(statement.includes(`'${permission}'`));
  assert.match(statement, /enabled=EXCLUDED.enabled/);
});

test("demo and judge principal SQL grants audit.read only and preserves disabled expiry state", () => {
  assert.deepEqual(READER_PERMISSIONS, ["audit.read"]);
  for (const profile of [DEMO_ACCOUNT, DEMO_INSPECTOR, JUDGE_ACCOUNT]) {
    const statement = buildPrincipalStatement({ tenant: profile.tenant, issuer: ISSUER, subject: `${profile.username}-id`, profile });
    assert.ok(statement.includes("ARRAY['audit.read']::text[]"));
    for (const permission of ADMIN_PERMISSIONS.filter(name => name !== "audit.read")) assert.ok(!statement.includes(`'${permission}'`));
  }
  const statement = buildPrincipalStatement({ tenant: "production", issuer: ISSUER, subject: "judge-id", profile: { ...JUDGE_ACCOUNT, enabled: false } });
  assert.match(statement, /'admin',false\)/);
});

test("disable SQL is restricted to the judge subject in production and escapes text", () => {
  const statement = buildDisablePrincipalStatement({ tenant: "tenant-a", issuer: "issuer'", subject: "giamkhao'id" });
  assert.match(statement, /^UPDATE app_private.principals SET enabled=false/);
  assert.ok(statement.includes("WHERE tenant_id='production' AND issuer='issuer''' AND subject='giamkhao''id'"));
  for (const other of ["tenant-a", "tenant-b", "admin1", "INSERT", "password"]) assert.ok(!statement.includes(other));
});

test("user updates merge tenant attributes while retaining the full existing representation", () => {
  const original = { id: "judge-id", username: "giamkhao", emailVerified: true, requiredActions: ["VERIFY_EMAIL"], attributes: { tenant_id: ["tenant-a"], custom: ["keep"] } };
  const snapshot = structuredClone(original);
  const update = buildUserUpdate(original, { ...JUDGE_ACCOUNT, enabled: false, accessExpiresAt: "2026-12-15" });
  assert.deepEqual(update, { ...original, enabled: false, attributes: { ...original.attributes, tenant_id: ["production"], access_expires_at: ["2026-12-15"] } });
  assert.deepEqual(original, snapshot);
});

// Keycloak and filesystem operations below stay in memory. No running stack or
// credential file is contacted, and every password is a simulated fixture.
function fakeStack({ tenant = "demo", users = [], memberships = {}, consoleScopes = ["basic", "roles"] } = {}) {
  const calls = [];
  const statements = [];
  const records = new Map(users.map(user => [user.id, structuredClone(user)]));
  const groups = structuredClone(memberships);
  const consoleRoles = ["console-admin", "console-viewer"].map(name => ({ id: `${name}-role`, name }));
  const availableScopes = ["basic", "roles", "profile"].map(name => ({ id: `${name}-scope`, name }));
  const defaultScopes = new Set(consoleScopes);
  const response = (value, status = 200, headers) => new Response(value === undefined ? null : JSON.stringify(value), { status, headers });
  const stack = {
    calls, statements, records, defaultScopes,
    group: { id: `${tenant}-group`, name: tenant },
    roles: [{ id: "reader-role", name: "core-reader" }, { id: "writer-role", name: "core-writer" }],
    idFrom: result => result.headers.get("location").split("/").at(-1),
    sql: async statement => { statements.push(statement); return ""; },
    admin: async (path, body, method = body === undefined ? "GET" : "POST") => {
      calls.push({ path, body: structuredClone(body), method });
      if (path === "clients?clientId=junctura-console") return response([{ id: "console-id", clientId: "junctura-console" }]);
      if (path === "clients/console-id/roles") return response(consoleRoles);
      if (path === "client-scopes") return response(availableScopes);
      if (path === "clients/console-id/default-client-scopes") return response(availableScopes.filter(scope => defaultScopes.has(scope.name)));
      if (path.startsWith("clients/console-id/default-client-scopes/") && method === "PUT") {
        const scope = availableScopes.find(candidate => path.endsWith(`/${candidate.id}`));
        if (!scope) throw new Error(`Unexpected simulated scope: ${path}`);
        defaultScopes.add(scope.name);
        return response(undefined, 204);
      }
      if (path.startsWith("users?")) {
        const username = new URLSearchParams(path.split("?")[1]).get("username");
        return response([...records.values()].filter(user => user.username === username));
      }
      if (path === "users" && method === "POST") {
        const id = `${body.username}-id`;
        records.set(id, { ...structuredClone(body), id });
        return response(undefined, 201, { location: `/users/${id}` });
      }
      const [, id, action, groupId] = path.split("/");
      if (!records.has(id)) throw new Error(`Unexpected simulated user request: ${path}`);
      if (!action && method === "GET") return response(records.get(id));
      if (!action && method === "PUT") {
        records.set(id, { ...records.get(id), ...structuredClone(body) });
        return response(undefined, 204);
      }
      if (action === "groups") {
        if (method === "GET") return response(groups[id] ?? []);
        if (method === "PUT") (groups[id] ??= []).push({ id: groupId, name: groupId.replace(/-group$/, "") });
        if (method === "DELETE") groups[id] = (groups[id] ?? []).filter(group => group.id !== groupId);
        return response(undefined, 204);
      }
      if (action === "role-mappings" && groupId === "clients" && method === "GET") return response([]);
      if (["reset-password", "role-mappings", "logout"].includes(action)) return response(undefined, 204);
      throw new Error(`Unexpected simulated request: ${method} ${path}`);
    },
  };
  return stack;
}

test("existing admins migrate attributes and environment membership without changing CI tenant rows", async () => {
  const original = { id: "admin-id", username: "admin1", emailVerified: true, attributes: { tenant_id: ["tenant-a"], custom: ["keep"] } };
  const stack = fakeStack({ tenant: "production", users: [original], memberships: { "admin-id": [
    { id: "tenant-a-group", name: "tenant-a" }, { id: "tenant-b-group", name: "tenant-b" }, { id: "demo-group", name: "demo" },
  ] } });
  const result = await provisionTenant(stack, { tenant: "production", accounts: [{ ...DEMO_ADMINS[0], password: "simulated-kept" }], existing: new Map([["admin1", "simulated-kept"]]), issuer: ISSUER });
  assert.deepEqual(result, { created: [], reset: [] });
  assert.deepEqual(stack.records.get("admin-id"), { ...original, enabled: true, attributes: { tenant_id: ["production"], custom: ["keep"] } });
  assert.deepEqual(stack.calls.filter(call => call.method === "DELETE").map(call => call.path), ["users/admin-id/groups/tenant-a-group", "users/admin-id/groups/tenant-b-group", "users/admin-id/groups/demo-group"]);
  assert.ok(stack.calls.some(call => call.path === "users/admin-id/groups/production-group" && call.method === "PUT"));
  assert.ok(!stack.calls.some(call => call.path.endsWith("reset-password")));
  assert.deepEqual(stack.calls.find(call => call.path.endsWith("role-mappings/realm")).body, stack.roles);
  assert.deepEqual(stack.calls.find(call => call.path.endsWith("role-mappings/clients/console-id") && call.method === "POST").body,
    [{ id: "console-admin-role", name: "console-admin" }]);
  assert.equal(stack.statements.length, 1);
  assert.ok(stack.statements[0].includes("VALUES ('production',"));
  assert.ok(!stack.statements[0].includes("tenant-a"));
  assert.ok(!stack.statements[0].includes("tenant-b"));
});

test("provisioning adds missing Console subject and role scopes once while keeping existing scopes", async () => {
  const stack = fakeStack({ consoleScopes: ["profile"] });
  const options = { tenant: "demo", accounts: [{ ...DEMO_INSPECTOR, password: "simulated" }],
    existing: new Map([[DEMO_INSPECTOR.username, "simulated"]]), issuer: ISSUER };
  await provisionTenant(stack, options);
  await provisionTenant(stack, options);
  assert.deepEqual([...stack.defaultScopes], ["profile", "basic", "roles"]);
  assert.deepEqual(stack.calls.filter(call => call.method === "PUT" && call.path.includes("default-client-scopes"))
    .map(call => call.path.split("/").at(-1)), ["basic-scope", "roles-scope"]);
});

test("read-only accounts receive only core-reader and have writer roles removed", async () => {
  for (const profile of [DEMO_ACCOUNT, DEMO_INSPECTOR, JUDGE_ACCOUNT]) {
    const stack = fakeStack({ tenant: profile.tenant });
    const account = { ...profile, password: "simulated", accessExpiresAt: "2026-12-15" };
    const result = await provisionTenant(stack, { tenant: profile.tenant, accounts: [account], existing: new Map(), issuer: ISSUER });
    assert.deepEqual(result, { created: [profile.username], reset: [] });
    const roleCalls = stack.calls.filter(call => call.path.endsWith("role-mappings/realm"));
    assert.deepEqual(roleCalls.map(call => [call.method, call.body.map(role => role.name)]), [["POST", ["core-reader"]], ["DELETE", ["core-writer"]]]);
    assert.deepEqual(stack.calls.find(call => call.path.endsWith("role-mappings/clients/console-id") && call.method === "POST").body,
      [{ id: "console-viewer-role", name: "console-viewer" }]);
    const user = stack.records.get(`${profile.username}-id`);
    assert.deepEqual(user.attributes.tenant_id, [profile.tenant]);
    if (profile === JUDGE_ACCOUNT) assert.deepEqual(user.attributes.access_expires_at, ["2026-12-15"]);
    assert.ok(stack.statements[0].includes("ARRAY['audit.read']::text[]"));
  }
});

test("existing passwords reset only when missing from trusted storage or explicitly requested", async () => {
  for (const resetPasswords of [false, true]) {
    const stack = fakeStack({ tenant: "production", users: [{ id: "admin-id", username: "admin1" }] });
    const existing = resetPasswords ? new Map([["admin1", "simulated-old"]]) : new Map();
    const result = await provisionTenant(stack, { tenant: "production", accounts: [{ ...DEMO_ADMINS[0], password: "simulated-new" }], existing, resetPasswords, issuer: ISSUER });
    assert.deepEqual(result.reset, ["admin1"]);
    assert.deepEqual(stack.calls.find(call => call.path.endsWith("reset-password")).body, { type: "password", value: "simulated-new", temporary: false });
  }
});

test("API errors omit response bodies that could contain submitted credentials", async () => {
  const stack = fakeStack();
  const admin = stack.admin;
  stack.admin = (path, ...args) => path === "users" ? new Response("simulated-sensitive-body", { status: 400 }) : admin(path, ...args);
  await assert.rejects(provisionTenant(stack, { tenant: "demo", accounts: [{ ...DEMO_ACCOUNT, password: "simulated-sensitive-body" }], existing: new Map(), issuer: ISSUER }), error => {
    assert.equal(error.message, "Create demo failed (400)");
    return true;
  });
});

test("legacy viewer cleanup only disables that account and emits one fixed line", async () => {
  const stack = fakeStack({ users: [{ id: "viewer-id", username: "viewer", attributes: { custom: ["keep"] } }] });
  const logs = [];
  await disableLegacyViewer(stack, message => logs.push(message));
  assert.deepEqual(stack.calls.filter(call => call.method !== "GET"), [{ path: "users/viewer-id", body: { enabled: false }, method: "PUT" }]);
  assert.deepEqual(logs, ["legacy viewer disabled"]);
  assert.deepEqual(stack.statements, []);
  await disableLegacyViewer(fakeStack(), message => logs.push(message));
  assert.equal(logs.length, 1);
});

test("disableJudge uses exact lookup, disables only the judge and ends its sessions", async () => {
  const stack = fakeStack({ tenant: "production", users: [
    { id: "judge-id", username: "giamkhao", enabled: true }, { id: "admin-id", username: "admin1", enabled: true },
  ] });
  assert.equal(await disableJudge(stack, { issuer: ISSUER }), true);
  assert.deepEqual(stack.calls, [
    { path: "users?username=giamkhao&exact=true", body: undefined, method: "GET" },
    { path: "users/judge-id", body: { enabled: false }, method: "PUT" },
    { path: "users/judge-id/logout", body: undefined, method: "POST" },
  ]);
  assert.deepEqual(stack.statements, [buildDisablePrincipalStatement({ issuer: ISSUER, subject: "judge-id" })]);
  assert.equal(stack.records.get("admin-id").enabled, true);
  const missing = fakeStack();
  assert.equal(await disableJudge(missing, { issuer: ISSUER }), false);
  assert.equal(missing.calls.length, 1);
  assert.deepEqual(missing.statements, []);
});

function memoryRun({ privateAccounts = [], hints = [], stacks = new Map(), now = NOW } = {}) {
  const connections = [];
  const writes = [];
  const modes = [];
  const logs = [];
  const files = new Map([
    ["simulated-private.json", JSON.stringify({ accounts: privateAccounts })],
    ["simulated-hints.json", JSON.stringify({ accounts: hints })],
  ]);
  return {
    connections, writes, modes, logs, files, stacks,
    args: ["--credentials", "simulated-private.json", "--hints", "simulated-hints.json", "--base", "https://demo.example", "--admin-base", "http://keycloak.invalid"],
    dependencies: {
      now, log: message => logs.push(message),
      connect: async options => {
        connections.push(options);
        if (!stacks.has(options.tenant)) stacks.set(options.tenant, fakeStack({ tenant: options.tenant }));
        return stacks.get(options.tenant);
      },
      read: path => { assert.ok(files.has(path)); return files.get(path); },
      mkdir: () => {},
      write: (path, content, options) => { files.set(path, content); writes.push({ path, mode: options.mode }); },
      chmod: (path, mode) => modes.push({ path, mode }),
    },
  };
}

test("demo-only run retains production credentials, publishes only demo and logs no passwords", async () => {
  const privateAccounts = ENVIRONMENT_ACCOUNTS.map(account => credential(account));
  const run = memoryRun({ privateAccounts });
  await main([...run.args, "--tenants", "demo"], run.dependencies);
  assert.deepEqual(run.connections, [{ tenant: "demo", base: "http://keycloak.invalid", createGroup: true }]);
  const saved = JSON.parse(run.files.get("simulated-private.json")).accounts;
  assert.deepEqual(saved.filter(account => account.tenant === "production"), privateAccounts.filter(account => account.tenant === "production"));
  assert.deepEqual(JSON.parse(run.files.get("simulated-hints.json")), { accounts: [{ username: "demo", password: "simulated-demo", label: DEMO_ACCOUNT.label }] });
  assert.deepEqual(run.writes, [{ path: "simulated-private.json", mode: 0o600 }, { path: "simulated-hints.json", mode: 0o644 }]);
  assert.deepEqual(run.modes, run.writes);
  for (const { password } of saved) assert.ok(!run.logs.join("\n").includes(password));
});

test("production-only run leaves hints untouched and provisions an expired judge disabled", async () => {
  const run = memoryRun({ privateAccounts: [credential(DEMO_ACCOUNT)], now: new Date("2026-12-16T00:00:00Z") });
  const oldHints = run.files.get("simulated-hints.json");
  await main([...run.args, "--tenants", "production"], run.dependencies);
  assert.deepEqual(run.connections, [{ tenant: "production", base: "http://keycloak.invalid", createGroup: true }]);
  assert.equal(run.files.get("simulated-hints.json"), oldHints);
  assert.deepEqual(run.writes, [{ path: "simulated-private.json", mode: 0o600 }]);
  const stack = run.stacks.get("production");
  assert.equal(stack.records.get("giamkhao-id").enabled, false);
  assert.deepEqual(stack.records.get("giamkhao-id").attributes.access_expires_at, ["2026-12-15"]);
  assert.ok(stack.statements.find(statement => statement.includes("'giamkhao-id'")).includes("'admin',false)"));
  const saved = JSON.parse(run.files.get("simulated-private.json")).accounts;
  assert.deepEqual(saved.find(account => account.username === "demo"), credential(DEMO_ACCOUNT));
  for (const { password } of saved) assert.ok(!run.logs.join("\n").includes(password));
});

test("default provisioning connects both environments and never publishes production passwords", async () => {
  const run = memoryRun();
  await main(run.args, run.dependencies);
  assert.deepEqual(run.connections.map(options => [options.tenant, options.createGroup]), [["demo", true], ["production", true]]);
  const saved = JSON.parse(run.files.get("simulated-private.json")).accounts;
  assert.deepEqual(saved.map(account => account.username), ["demo", "audit-inspector", "admin1", "admin2", "admin3", "giamkhao"]);
  assert.deepEqual(JSON.parse(run.files.get("simulated-hints.json")).accounts.map(account => account.username), ["demo"]);
  for (const { password } of saved) assert.ok(!run.logs.join("\n").includes(password));
});

test("disable-only mode never reads/writes account files, resets passwords or touches another user", async () => {
  const stack = fakeStack({ tenant: "production", users: [{ id: "judge-id", username: "giamkhao" }, { id: "viewer-id", username: "viewer" }] });
  const run = memoryRun({ stacks: new Map([["production", stack]]) });
  for (const name of ["read", "write", "mkdir", "chmod"]) run.dependencies[name] = () => assert.fail(`Unexpected filesystem ${name}`);
  await main([...run.args, "--disable-judge", "--reset-passwords"], run.dependencies);
  assert.deepEqual(run.connections, [{ tenant: "production", base: "http://keycloak.invalid" }]);
  assert.deepEqual(stack.calls.filter(call => call.method !== "GET").map(call => [call.method, call.path]), [["PUT", "users/judge-id"], ["POST", "users/judge-id/logout"]]);
  assert.equal(stack.calls.some(call => call.path.includes("viewer")), false);
});

test("tenant group creation is opt-in and handles creation races by re-reading", async () => {
  const must = async (response, expected) => { assert.ok(expected.includes(response.status)); return response; };
  for (const status of [201, 409]) {
    const calls = [];
    let reads = 0;
    const admin = async (path, body) => {
      calls.push({ path, body });
      if (body) return new Response(null, { status });
      return Response.json(++reads === 1 ? [] : [{ id: "group-id", name: "demo" }]);
    };
    const group = await ensureTenantGroup({ tenant: "demo", admin, must, createGroup: true });
    assert.equal(group.id, "group-id");
    assert.deepEqual(calls, [
      { path: "groups?search=demo&exact=true", body: undefined },
      { path: "groups", body: { name: "demo" } },
      { path: "groups?search=demo&exact=true", body: undefined },
    ]);
  }
  let reads = 0;
  const missing = async (_path, body) => { assert.equal(body, undefined); reads += 1; return Response.json([]); };
  await assert.rejects(ensureTenantGroup({ tenant: "production", admin: missing, must }), /Tenant group production does not exist/);
  assert.equal(reads, 1);
  const existing = { id: "existing", name: "production" };
  assert.deepEqual(await ensureTenantGroup({ tenant: "production", admin: async (_path, body) => { assert.equal(body, undefined); return Response.json([existing]); }, must, createGroup: true }), existing);
});

test("realm retains CI tenants and includes both environment groups", () => {
  const realm = JSON.parse(readFileSync(new URL("../infra/keycloak/realm.json", import.meta.url), "utf8"));
  assert.deepEqual(realm.groups, [{ name: "tenant-a" }, { name: "tenant-b" }, { name: "demo" }, { name: "production" }]);
  for (const account of ENVIRONMENT_ACCOUNTS) assert.ok(!realm.users.some(user => user.username === account.username));
  const consoleClient = realm.clients.find(client => client.clientId === "junctura-console");
  assert.deepEqual(consoleClient.defaultClientScopes, ["basic", "roles"]);
});

test("only an explicit judge expiry may re-enable a locked judge", () => {
  const now = new Date("2026-12-13T00:00:00Z");
  assert.equal(parseOptions([], now, {}).judgeExplicit, false);
  assert.equal(parseOptions([], now, {}).judgeExpiry.date, "2026-12-15");
  assert.equal(parseOptions(["--judge-expires", "2026-12-20"], now, {}).judgeExplicit, true);
});
