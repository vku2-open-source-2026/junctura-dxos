// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createApi } from "../src/api.mjs";
import { APPLICATION_STATS_PATH, handleApplicationStats } from "../src/modules/applications/stats.mjs";
import { HttpError, json } from "../src/platform/http/http.mjs";

const identity = {
  tenantId: "tenant-a", subject: "auditor", issuer: "https://identity.example.invalid",
  clientId: "management", roles: ["core-reader"],
};
const appOne = "11111111-1111-4111-8111-111111111111";
const appTwo = "22222222-2222-4222-8222-222222222222";
const config = {
  dataUrl: "https://data.example.invalid", dataSecret: "x".repeat(32),
  objectsUrl: "https://objects.example.invalid",
};
const stats = {
  totals: { applications: 2, activeApplications: 1, activeLast24h: 1, activeLast7d: 1, activeConnections: 2 },
  applications: [
    {
      id: appOne, name: "Đơn vị tiếp nhận", state: "active",
      registeredAt: "2026-11-01T03:04:05.123456+00:00", lastActivityAt: "2026-11-17T03:04:05+00:00",
      calls: { outgoing: { last24h: 2, last7d: 4 }, incoming: { last24h: 3, last7d: 6 } },
      capabilities: { published: 2 }, connections: { given: 2, received: 1 }, data: { collections: 2, records: 12 },
    },
    {
      id: appTwo, name: "Đơn vị xét duyệt", state: "pending",
      registeredAt: "2026-11-02T03:04:05Z", lastActivityAt: null,
      calls: { outgoing: { last24h: 0, last7d: 0 }, incoming: { last24h: 0, last7d: 0 } },
      capabilities: { published: 0 }, connections: { given: 0, received: 0 }, data: { collections: 0, records: 0 },
    },
  ],
};
const root = `/junctura-app/${identity.tenantId}/${appOne}`;
const listing = new Map([
  [`${root}/`, { Entries: [
    { FullPath: `${root}/private-object`, Mode: 0x80000000 | 0o755 },
    { FullPath: `${root}/private-file`, Mode: 0o644, FileSize: 7 },
  ] }],
  [`${root}/private-object/`, { Entries: [
    { FullPath: `${root}/private-object/old-version`, Mode: 0o644, FileSize: 10, Mtime: "2026-11-01T00:00:00Z" },
    { FullPath: `${root}/private-object/new-version`, Mode: 0o644, FileSize: 15, Mtime: "2026-11-09T00:00:00Z" },
  ] }],
]);

function fakeFetch(reply = { status: 200, value: stats }) {
  const seen = [];
  const request = async (url, options) => {
    seen.push({ url, options });
    if (url === `${config.dataUrl}/rpc/application_stats`) return Response.json(reply);
    const path = new URL(url).pathname;
    assert.ok(path.startsWith(`/junctura-app/${identity.tenantId}/`), "only the caller tenant application roots are listed");
    const value = listing.get(path);
    return value ? Response.json(value) : new Response(null, { status: 404 });
  };
  return { request, seen };
}

function captureResponse() {
  return {
    headers: new Headers(),
    setHeader(name, value) { this.headers.set(name, value); },
    writeHead(status, headers) {
      this.status = status;
      for (const [name, value] of Object.entries(headers)) this.headers.set(name, String(value));
    },
    end(body) { this.body = JSON.parse(body); },
  };
}

async function invoke({ path = APPLICATION_STATS_PATH, method = "GET", caller = identity,
  settings = config, request = fakeFetch().request } = {}) {
  const response = captureResponse();
  try {
    await handleApplicationStats({ method }, response, caller, settings, new URL(path, "http://core"), { request });
  } catch (error) {
    json(response, error instanceof HttpError ? error.status : 500, { error: error.message });
  }
  return response;
}

test("application stats returns exactly the contract with tenant-scoped file aggregates", async () => {
  const { request, seen } = fakeFetch();
  const before = Date.now();
  const response = await invoke({ request });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.ok(Date.parse(response.body.generatedAt) >= before && Date.parse(response.body.generatedAt) <= Date.now());
  const expected = structuredClone(stats);
  expected.applications[0].registeredAt = "2026-11-01T03:04:05.123Z";
  expected.applications[0].lastActivityAt = "2026-11-17T03:04:05.000Z";
  expected.applications[0].files = { count: 2, bytes: 22 };
  expected.applications[1].registeredAt = "2026-11-02T03:04:05.000Z";
  expected.applications[1].files = { count: 0, bytes: 0 };
  assert.deepEqual(response.body, { generatedAt: response.body.generatedAt, ...expected });
  assert.equal(seen.length, 4);
  assert.equal(seen[0].url, `${config.dataUrl}/rpc/application_stats`);
  const { options } = seen[0];
  assert.equal(options.method, "POST");
  assert.equal(options.redirect, "error");
  assert.ok(options.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(options.body), { payload: {} });
  assert.equal(options.headers["Content-Type"], "application/json");
  const claims = JSON.parse(Buffer.from(options.headers.Authorization.split(".")[1], "base64url"));
  assert.equal(claims.role, "junctura_application_stats_api");
  assert.deepEqual([claims.tenant_id, claims.sub, claims.iss, claims.client_id],
    [identity.tenantId, identity.subject, identity.issuer, identity.clientId]);
});

test("application stats drops extra fields at every level", async () => {
  const value = structuredClone(stats);
  value.subjects = ["secret-subject"];
  value.totals.proposal = "secret-proposal";
  const app = value.applications[0];
  for (const key of ["input", "output", "manifest", "proposal", "reason", "subject", "collections", "files"]) app[key] = "private-value";
  app.calls.reason = "secret-reason";
  app.calls.incoming.input = "secret-input";
  app.calls.outgoing.output = "secret-output";
  app.capabilities.manifest = "secret-manifest";
  app.connections.proposal = "secret-proposal";
  app.data.data = "secret-data";
  const response = await invoke({ request: fakeFetch({ status: 200, value }).request });
  const clean = await invoke();
  assert.equal(response.status, 200);
  assert.deepEqual({ ...response.body, generatedAt: clean.body.generatedAt }, clean.body);
  const text = JSON.stringify(response.body);
  for (const secret of ["private-", "secret-", "old-version", "new-version", "updatedAt"]) assert.ok(!text.includes(secret));
});

test("RPC permission failure is returned as stats_permission_required", async () => {
  const response = await invoke({ request: fakeFetch({ status: 403, error: "stats_permission_required" }).request });
  assert.equal(response.status, 403);
  assert.deepEqual(response.body, { error: "stats_permission_required" });
});

test("malformed RPC fields fail closed", async () => {
  const patches = [
    (v) => { v.applications = {}; },
    (v) => { v.totals = []; },
    (v) => { delete v.totals.activeConnections; },
    (v) => { v.totals.activeLast7d = Number.MAX_SAFE_INTEGER + 1; },
    (v) => { v.applications[0] = null; },
    (v) => { v.applications[0].id = "not-a-uuid"; },
    (v) => { v.applications[0].state = "deleted"; },
    (v) => { v.applications[0].name = ""; },
    (v) => { v.applications[0].name = "x".repeat(201); },
    (v) => { v.applications[0].name = "private\nname"; },
    (v) => { v.applications[0].name = "\ud800"; },
    (v) => { v.applications[0].registeredAt = null; },
    (v) => { v.applications[0].registeredAt = "2026-02-31T00:00:00Z"; },
    (v) => { v.applications[0].registeredAt = "2026-11-01"; },
    (v) => { v.applications[0].lastActivityAt = "yesterday"; },
    (v) => { v.applications[0].lastActivityAt = "2026-11-01T24:00:00Z"; },
    (v) => { delete v.applications[0].lastActivityAt; },
    (v) => { v.applications[0].calls = []; },
    (v) => { v.applications[0].calls.outgoing.last24h = -1; },
    (v) => { v.applications[0].calls.incoming.last7d = "2"; },
    (v) => { v.applications[0].capabilities.published = 0.5; },
    (v) => { v.applications[0].connections.given = Number.MAX_SAFE_INTEGER + 1; },
    (v) => { v.applications[0].data.records = null; },
    (v) => { delete v.applications[0].data.collections; },
  ];
  for (const patch of patches) {
    const value = structuredClone(stats);
    patch(value);
    const response = await invoke({ request: fakeFetch({ status: 200, value }).request });
    assert.equal(response.status, 503, patch.toString());
    assert.deepEqual(response.body, { error: "application_stats_unavailable" });
  }
  for (const reply of [null, [], {}, { status: 201, value: stats }, { status: 200, value: null },
    { status: "403", error: "stats_permission_required" }]) {
    const response = await invoke({ request: fakeFetch(reply).request });
    assert.equal(response.status, 503);
  }
});

test("method, any query string, missing data and unverified clients are rejected before RPC", async () => {
  const { request, seen } = fakeFetch();
  for (const path of [`${APPLICATION_STATS_PATH}?tenant=tenant-b`, `${APPLICATION_STATS_PATH}?`]) {
    const response = await invoke({ path, request });
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: "invalid_query" });
  }
  const post = await invoke({ method: "POST", request });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET");
  assert.deepEqual(post.body, { error: "method_not_allowed" });
  const missingData = await invoke({ settings: { ...config, dataUrl: undefined }, request });
  assert.equal(missingData.status, 503);
  assert.deepEqual(missingData.body, { error: "application_stats_unavailable" });
  const noClient = await invoke({ caller: { ...identity, clientId: undefined }, request });
  assert.equal(noClient.status, 403);
  assert.deepEqual(noClient.body, { error: "verified_client_required" });
  assert.equal(seen.length, 0);
});

test("unconfigured objects report files:null and empty application lists are valid", async () => {
  const { request, seen } = fakeFetch();
  const response = await invoke({ settings: { ...config, objectsUrl: undefined }, request });
  assert.equal(response.status, 200);
  assert.ok(response.body.applications.every((app) => app.files === null));
  assert.equal(seen.length, 1);
  const value = { totals: Object.fromEntries(Object.keys(stats.totals).map((key) => [key, 0])), applications: [] };
  const empty = await invoke({ request: fakeFetch({ status: 200, value }).request });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.applications, []);
  assert.deepEqual(empty.body.totals, value.totals);
});

test("transport, HTTP, invalid JSON and filer failures use application_stats_unavailable", async () => {
  for (const request of [
    async () => { throw Error("connection unavailable"); },
    async () => new Response(null, { status: 503 }),
    async () => new Response("invalid JSON"),
    async (url, options) => {
      if (url.startsWith(config.objectsUrl)) throw Error("filer unavailable");
      return fakeFetch().request(url, options);
    },
    async (url, options) => {
      if (url.startsWith(config.objectsUrl)) return Response.json({ Entries: {} });
      return fakeFetch().request(url, options);
    },
    async (url, options) => {
      if (url.startsWith(config.objectsUrl)) return Response.json({ Entries: [{ Mode: 0o644, FileSize: Number.MAX_SAFE_INTEGER + 1 }] });
      return fakeFetch().request(url, options);
    },
  ]) {
    const response = await invoke({ request });
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, { error: "application_stats_unavailable" });
  }
});

test("Core routes stats before application IDs and returns correlated errors", async (t) => {
  const { request, seen } = fakeFetch();
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url.endsWith("/token/introspect")) return Response.json({
      active: true, iss: identity.issuer, aud: "junctura-core", sub: identity.subject,
      exp: Date.now() / 1000 + 30, client_id: identity.clientId, tenant_id: identity.tenantId,
      tenant_memberships: [`/${identity.tenantId}`], realm_access: { roles: identity.roles },
    });
    return request(url, options);
  });
  const api = createApi({ ...config, issuer: identity.issuer, identityUrl: identity.issuer, clientSecret: "fixture" });
  const response = captureResponse();
  await api({ method: "GET", url: APPLICATION_STATS_PATH, headers: { authorization: "Bearer fixture" } }, response);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);
  assert.equal(seen[0].url, `${config.dataUrl}/rpc/application_stats`);

  for (const [method, url, headers, status, error] of [
    ["GET", `${APPLICATION_STATS_PATH}?x=1`, { authorization: "Bearer fixture" }, 400, "invalid_query"],
    ["POST", APPLICATION_STATS_PATH, { authorization: "Bearer fixture" }, 405, "method_not_allowed"],
    ["GET", APPLICATION_STATS_PATH, {}, 401, "bearer_token_required"],
    ["GET", "/v1/applications/invalid", { authorization: "Bearer fixture" }, 400, "invalid_application_path"],
  ]) {
    const failure = captureResponse();
    await api({ method, url, headers }, failure);
    assert.equal(failure.status, status);
    assert.deepEqual(failure.body, { error, requestId: failure.headers.get("x-request-id") });
    if (status === 405) assert.equal(failure.headers.get("allow"), "GET");
  }
});

test("migration 027 exposes only a private SECURITY DEFINER aggregate with audit.read", () => {
  const sql = readFileSync(new URL("../infra/postgres/027-application-stats.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE ROLE junctura_application_stats_api NOLOGIN NOBYPASSRLS/);
  assert.match(sql, /GRANT junctura_application_stats_api TO junctura_data/);
  assert.match(sql, /LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,app_private/);
  assert.match(sql, /SET LOCAL ROLE junctura_app_owner/);
  assert.match(sql, /p\.tenant_id=tenant AND p\.issuer=iss AND p\.subject=who/);
  assert.match(sql, /p\.management_client=client AND p\.enabled/);
  assert.match(sql, /p\.permissions @> ARRAY\['audit\.read'\]::text\[\]/);
  assert.match(sql, /REVOKE ALL ON FUNCTION core\.application_stats\(jsonb\) FROM PUBLIC/);
  assert.match(sql, /ALTER FUNCTION core\.application_stats\(jsonb\) OWNER TO junctura_app_owner/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION core\.application_stats\(jsonb\) TO junctura_application_stats_api/);
  assert.match(sql, /INSERT INTO core\.schema_migrations\(version\) VALUES\(27\)/);
  assert.match(sql, /NOTIFY pgrst,'reload schema'/);
  assert.doesNotMatch(sql, /DISABLE ROW LEVEL SECURITY|NO FORCE/i);
  assert.doesNotMatch(sql, /\b(?:au|e|cv|g|r)\.(?:input|output|manifest|proposal|reason|data|subject)\b/);
});
