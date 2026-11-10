// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { handleDirectory } from "../src/modules/directory/directory.mjs";
import { HttpError, json } from "../src/platform/http/http.mjs";

const identity = {
  tenantId: "tenant-a",
  subject: "auditor",
  issuer: "https://identity.example.invalid",
  clientId: "management",
  roles: ["core-reader"],
};
const appId = "11111111-1111-4111-8111-111111111111";
const principals = {
  items: [
    { subject: "admin1", issuer: "https://identity.example.invalid", managementClient: "management",
      permissions: ["audit.read", "trust.approve"], enabled: true, displayName: "Quản trị viên 1",
      organization: "Junctura", jobTitle: "Quản trị nền tảng", kind: "admin" },
    { subject: "admin2", issuer: "https://identity.example.invalid", managementClient: "management",
      permissions: ["applications.register"], enabled: false, displayName: null,
      organization: null, jobTitle: null, kind: null },
  ],
  truncated: false,
};
const organizations = {
  root: {
    id: "tenant-a",
    name: "tenant-a",
    kind: "platform",
    children: [
      { id: appId, name: "Trạm y tế", kind: "application", children: [] },
    ],
  },
  relations: [
    { from: appId, to: "22222222-2222-4222-8222-222222222222", label: "Tra cứu bệnh nhân" },
  ],
  truncated: false,
};

let reply = { status: 200, value: principals };
let seen = [];
let data, core, base;
const listen = (server) => new Promise((resolve) =>
  server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));

before(async () => {
  data = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    seen.push({ url: request.url, authorization: request.headers.authorization,
      body: Buffer.concat(chunks).toString() });
    if (reply === "down") { response.writeHead(503); return response.end(); }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(reply));
  });
  const dataUrl = await listen(data);
  core = createServer(async (request, response) => {
    try {
      await handleDirectory(request, response, identity,
        { dataUrl, dataSecret: "x".repeat(32) }, new URL(request.url, "http://core"));
    } catch (error) {
      json(response, error instanceof HttpError ? error.status : 500, { error: error.message });
    }
  });
  base = await listen(core);
});
after(() => { data.close(); core.close(); });

const get = (path = "/v1/directory/principals", method = "GET") =>
  fetch(`${base}${path}`, { method });

test("principals assert only the private directory role and are never cached", async () => {
  seen = [];
  reply = { status: 200, value: principals };
  const response = await get();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), principals);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "/rpc/directory_principals");
  assert.deepEqual(JSON.parse(seen[0].body), { payload: {} });
  const claims = JSON.parse(Buffer.from(seen[0].authorization.split(".")[1], "base64url"));
  assert.equal(claims.role, "junctura_directory_api");
  assert.deepEqual([claims.tenant_id, claims.sub, claims.iss, claims.client_id],
    ["tenant-a", "auditor", "https://identity.example.invalid", "management"]);
});

test("organizations reuse the same private role and return the real tree", async () => {
  seen = [];
  reply = { status: 200, value: organizations };
  const response = await get("/v1/directory/organizations");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), organizations);
  assert.equal(seen[0].url, "/rpc/directory_organizations");
  const claims = JSON.parse(Buffer.from(seen[0].authorization.split(".")[1], "base64url"));
  assert.equal(claims.role, "junctura_directory_api");
});

test("permission errors, bad requests and outages fail closed", async () => {
  reply = { status: 403, error: "directory_permission_required" };
  const denied = await get();
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error, "directory_permission_required");

  reply = { status: 200, value: principals };
  assert.equal((await get("/v1/directory/principals?tenant=tenant-b")).status, 400,
    "no caller-chosen scope");
  assert.equal((await get("/v1/directory/unknown")).status, 404);
  const post = await get("/v1/directory/principals", "POST");
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET");

  reply = "down";
  assert.equal((await get()).status, 503);

  reply = { status: 200, value: { items: "x" } };
  assert.equal((await get()).status, 503, "malformed principals answer is rejected");

  const profileWithoutKind = structuredClone(principals);
  delete profileWithoutKind.items[0].kind;
  reply = { status: 200, value: profileWithoutKind };
  assert.equal((await get()).status, 503, "a missing profile field is rejected");

  const badProfile = structuredClone(principals);
  badProfile.items[0].displayName = "x".repeat(201);
  reply = { status: 200, value: badProfile };
  assert.equal((await get()).status, 503, "an oversized display name is rejected");

  const badKind = structuredClone(principals);
  badKind.items[0].kind = "root";
  reply = { status: 200, value: badKind };
  assert.equal((await get()).status, 503, "an unknown principal kind is rejected");

  reply = { status: 200, value: { root: { id: "tenant-a" }, relations: [] } };
  assert.equal((await get("/v1/directory/organizations")).status, 503,
    "malformed organization tree is rejected");

  reply = { status: 200, value: principals };
});

test("a principal without a verified client id fails closed", async () => {
  reply = { status: 200, value: principals };
  const server = createServer(async (request, response) => {
    try {
      await handleDirectory(request, response, { ...identity, clientId: undefined },
        { dataUrl: base, dataSecret: "x".repeat(32) }, new URL(request.url, "http://core"));
    } catch (error) {
      json(response, error instanceof HttpError ? error.status : 500, { error: error.message });
    }
  });
  const url = await listen(server);
  try {
    const response = await fetch(`${url}/v1/directory/principals`);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "verified_client_required");
  } finally {
    server.close();
  }
});

test("organization relations come only from active, unexpired grants", () => {
  const sql = readFileSync(
    new URL("../infra/postgres/024-directory-active-only.sql", import.meta.url), "utf8");
  const definition = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION core.directory_organizations"));
  assert.match(definition, /g\.state='active'/,
    "only active grants are published");
  assert.doesNotMatch(definition, /g\.state<>'revoked'/,
    "pending and other non-active grants must not appear");
  assert.match(definition, /g\.expires_at>statement_timestamp\(\)/,
    "expired active grants stay hidden");
  assert.match(sql, /INSERT INTO core\.schema_migrations\(version\) VALUES\(24\)/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION core\.directory_organizations\(jsonb\) TO junctura_directory_api/);
  assert.match(sql, /NOTIFY pgrst,'reload schema'/);
});
