// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { handleStorage } from "../src/modules/storage/storage.mjs";
import { HttpError, json } from "../src/platform/http/http.mjs";

const identity = {
  tenantId: "tenant-a",
  subject: "auditor",
  issuer: "https://identity.example.invalid",
  clientId: "management",
  roles: ["core-reader"],
};
const appOne = "11111111-1111-4111-8111-111111111111";
const appTwo = "22222222-2222-4222-8222-222222222222";
const summary = {
  applications: [
    {
      id: appOne,
      name: "Trạm Y tế xã",
      state: "active",
      collections: [
        { name: "benh-nhan", records: 12, updatedAt: "2026-01-02T03:04:05.000Z" },
      ],
    },
    {
      id: appTwo,
      name: "Bệnh viện",
      state: "active",
      collections: [],
    },
  ],
  totals: {
    collections: [
      { name: "benh-nhan", records: 12, updatedAt: "2026-01-02T03:04:05.000Z" },
      { name: "chuyen-tuyen", records: 3, updatedAt: "2026-01-03T03:04:05.000Z" },
    ],
  },
};
const dirMode = 0x80000000 | 0o755;
const fileMode = 0o644;
const listing = new Map([
  ["/junctura-app/tenant-a/" + appOne + "/", { Entries: [
    { FullPath: "/junctura-app/tenant-a/" + appOne + "/obj-one", Mode: dirMode },
    { FullPath: "/junctura-app/tenant-a/" + appOne + "/obj-two", Mode: dirMode },
    { FullPath: "/junctura-app/tenant-a/" + appOne + "/orphan-file", Mode: fileMode, FileSize: 7, Mtime: "2026-01-05T00:00:00Z" },
  ], ShouldDisplayLoadMore: false }],
  ["/junctura-app/tenant-a/" + appOne + "/obj-one/", { Entries: [
    { FullPath: "/junctura-app/tenant-a/" + appOne + "/obj-one/v1", Mode: fileMode, FileSize: 10, Mtime: "2026-01-04T00:00:00Z" },
    { FullPath: "/junctura-app/tenant-a/" + appOne + "/obj-one/v2", Mode: fileMode, FileSize: 15, Mtime: "2026-01-09T00:00:00Z" },
  ], ShouldDisplayLoadMore: false }],
  ["/junctura-app/tenant-a/" + appOne + "/obj-two/", { Entries: [
    { FullPath: "/junctura-app/tenant-a/" + appOne + "/obj-two/v1", Mode: fileMode, FileSize: 20, Mtime: "2026-01-06T00:00:00Z" },
  ], ShouldDisplayLoadMore: false }],
  ["/junctura-quarantine/tenant-a/", { Entries: [
    { FullPath: "/junctura-quarantine/tenant-a/quarantine-one", Mode: dirMode },
    { FullPath: "/junctura-quarantine/tenant-a/empty-one", Mode: dirMode },
  ], ShouldDisplayLoadMore: false }],
  ["/junctura-quarantine/tenant-a/quarantine-one/", { Entries: [
    { FullPath: "/junctura-quarantine/tenant-a/quarantine-one/v1", Mode: fileMode, FileSize: 3, Mtime: "2026-01-07T00:00:00Z" },
  ], ShouldDisplayLoadMore: false }],
  ["/junctura-quarantine/tenant-a/empty-one/", { Entries: null, ShouldDisplayLoadMore: false }],
  ["/junctura/tenant-a/", { Entries: [
    { FullPath: "/junctura/tenant-a/legacy-one", Mode: fileMode, FileSize: 5, Mtime: "2026-01-08T00:00:00Z" },
  ], ShouldDisplayLoadMore: false }],
]);

let reply = { status: 200, value: summary };
let seen = [];
let data, filer, core, base, dataUrl;

const listen = (server) => new Promise((resolve) =>
  server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));

before(async () => {
  data = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    seen.push({ url: request.url, authorization: request.headers.authorization,
      body: Buffer.concat(chunks).toString() });
    if (reply === "down") { response.writeHead(503); return response.end(); }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(reply));
  });
  dataUrl = await listen(data);
  filer = createServer((request, response) => {
    if (request.headers.accept !== "application/json") { response.writeHead(400); return response.end(); }
    const pathname = new URL(request.url, "http://filer").pathname;
    const path = pathname.endsWith("/") ? pathname : `${pathname}/`;
    const value = listing.get(path);
    if (!value) { response.writeHead(404); return response.end(); }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(value));
  });
  const objectsUrl = await listen(filer);
  core = createServer(async (request, response) => {
    try {
      await handleStorage(request, response, identity,
        { dataUrl, dataSecret: "x".repeat(32), objectsUrl }, new URL(request.url, "http://core"));
    } catch (error) {
      json(response, error instanceof HttpError ? error.status : 500, { error: error.message });
    }
  });
  base = await listen(core);
});
after(() => { data.close(); filer.close(); core.close(); });

const get = (path = "/v1/storage/summary", method = "GET") => fetch(`${base}${path}`, { method });

test("summary aggregates records and object metadata without names or content", async () => {
  seen = [];
  reply = { status: 200, value: summary };
  const response = await get();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "/rpc/storage_summary");
  const claims = JSON.parse(Buffer.from(seen[0].authorization.split(".")[1], "base64url"));
  assert.equal(claims.role, "junctura_storage_api");
  assert.deepEqual([claims.tenant_id, claims.sub, claims.iss, claims.client_id],
    ["tenant-a", "auditor", "https://identity.example.invalid", "management"]);
  assert.deepEqual(body.applications[0].files, {
    count: 3, bytes: 42, quarantined: 0, updatedAt: "2026-01-09T00:00:00.000Z",
  });
  assert.deepEqual(body.applications[1].files, {
    count: 0, bytes: 0, quarantined: 0, updatedAt: null,
  });
  assert.deepEqual(body.totals.files, {
    count: 4, bytes: 47, quarantined: 1, updatedAt: "2026-01-09T00:00:00.000Z",
  });
  const text = JSON.stringify(body);
  for (const secret of ["obj-one", "obj-two", "orphan-file", "legacy-one", "quarantine-one", "v1"]) {
    assert.ok(!text.includes(secret), `${secret} must not be returned`);
  }
});

test("query, method and unverified client are rejected", async () => {
  reply = { status: 200, value: summary };
  assert.equal((await get("/v1/storage/summary?tenant=tenant-b")).status, 400);
  const post = await get("/v1/storage/summary", "POST");
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET");
  const noClient = createServer(async (request, response) => {
    try {
      await handleStorage(request, response, { ...identity, clientId: undefined },
        { dataUrl, dataSecret: "x".repeat(32), objectsUrl: base }, new URL(request.url, "http://core"));
    } catch (error) {
      json(response, error instanceof HttpError ? error.status : 500, { error: error.message });
    }
  });
  const url = await listen(noClient);
  try {
    assert.equal((await fetch(`${url}/v1/storage/summary`)).status, 403);
  } finally {
    noClient.close();
  }
});

test("permission failures, malformed answers and outages fail closed", async () => {
  reply = { status: 403, error: "storage_permission_required" };
  const denied = await get();
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error, "storage_permission_required");

  reply = "down";
  assert.equal((await get()).status, 503);

  reply = { status: 200, value: { applications: [{ id: "not-a-uuid" }], totals: { collections: [] } } };
  assert.equal((await get()).status, 503);

  const leaks = structuredClone(summary);
  leaks.applications[0].collections[0].content = "secret";
  reply = { status: 200, value: leaks };
  const clean = await get();
  assert.equal(clean.status, 200);
  assert.ok(!JSON.stringify(await clean.json()).includes("secret"));
});

test("a filer outage fails closed and an unconfigured filer reports files:null", async () => {
  reply = { status: 200, value: summary };
  const broken = createServer(async (request, response) => {
    try {
      await handleStorage(request, response, identity,
        { dataUrl: base, dataSecret: "x".repeat(32), objectsUrl: "http://127.0.0.1:1" },
        new URL(request.url, "http://core"));
    } catch (error) {
      json(response, error instanceof HttpError ? error.status : 500, { error: error.message });
    }
  });
  const brokenUrl = await listen(broken);
  try {
    assert.equal((await fetch(`${brokenUrl}/v1/storage/summary`)).status, 503);
  } finally {
    broken.close();
  }

  const noObjects = createServer(async (request, response) => {
    try {
      await handleStorage(request, response, identity,
        { dataUrl, dataSecret: "x".repeat(32) }, new URL(request.url, "http://core"));
    } catch (error) {
      json(response, error instanceof HttpError ? error.status : 500, { error: error.message });
    }
  });
  const noObjectsUrl = await listen(noObjects);
  try {
    const response = await fetch(`${noObjectsUrl}/v1/storage/summary`);
    const body = await response.json();
    assert.equal(body.applications[0].files, null);
    assert.equal(body.totals.files, null);
  } finally {
    noObjects.close();
  }
});

test("migration 025 uses private read-only roles and a tenant-scoped record policy", () => {
  const sql = readFileSync(new URL("../infra/postgres/025-storage-summary.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE ROLE junctura_storage_api NOLOGIN NOBYPASSRLS/);
  assert.match(sql, /CREATE ROLE junctura_workflow_audit_api NOLOGIN NOBYPASSRLS/);
  assert.match(sql, /CREATE POLICY operator_read ON core\.records FOR SELECT TO junctura_app_owner/);
  assert.match(sql, /p\.permissions @> ARRAY\['audit\.read'\]::text\[\]/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION core\.storage_summary\(jsonb\) TO junctura_storage_api/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION core\.workflow_audit_access\(jsonb\) TO junctura_workflow_audit_api/);
  assert.match(sql, /INSERT INTO core\.schema_migrations\(version\) VALUES\(25\)/);
  assert.match(sql, /NOTIFY pgrst,'reload schema'/);
  assert.doesNotMatch(sql, /'content'|'bytes'|'objectKey'|'fileName'/);
});
