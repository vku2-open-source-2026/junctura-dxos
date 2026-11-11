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
const root = `/junctura-app/tenant-a/${appOne}`;
const dirMode = 0x80000000 | 0o755;
const fileMode = 0o644;
const listing = new Map([
  [`/junctura-app/tenant-a/${appOne}/`, { Entries: [
    { FullPath: `${root}/ho-so`, Mode: dirMode },
    { FullPath: `${root}/giay-to`, Mode: dirMode },
    { FullPath: `${root}/0120b996-711d-526b-a836-69fee754b79e`, Mode: dirMode },
    { FullPath: `${root}/README`, Mode: fileMode, FileSize: 12, Mtime: "2026-01-02T00:00:00Z" },
  ], ShouldDisplayLoadMore: false }],
  [`${root}/ho-so/`, { Entries: [
    { FullPath: `${root}/ho-so/chung-tu`, Mode: dirMode },
    { FullPath: `${root}/ho-so/de-nghi`, Mode: dirMode },
  ], ShouldDisplayLoadMore: false }],
  [`${root}/ho-so/chung-tu/`, { Entries: [
    { FullPath: `${root}/ho-so/chung-tu/2026`, Mode: dirMode },
  ], ShouldDisplayLoadMore: false }],
  [`${root}/ho-so/chung-tu/2026/`, { Entries: [
    { FullPath: `${root}/ho-so/chung-tu/2026/chứng từ CT-0001.txt`, Mode: fileMode, FileSize: 100, Mtime: "2026-01-03T00:00:00Z" },
    { FullPath: `${root}/ho-so/chung-tu/2026/Ba\u0301o ca\u0301o.pdf`, Mode: fileMode, FileSize: 50, Mtime: "2026-01-04T00:00:00Z" },
  ], ShouldDisplayLoadMore: false }],
  [`${root}/ho-so/de-nghi/`, { Entries: [
    { FullPath: `${root}/ho-so/de-nghi/2026`, Mode: dirMode },
  ], ShouldDisplayLoadMore: false }],
  [`${root}/ho-so/de-nghi/2026/`, { Entries: [
    { FullPath: `${root}/ho-so/de-nghi/2026/giấy đề nghị PD-0001.txt`, Mode: fileMode, FileSize: 70, Mtime: "2026-01-05T00:00:00Z" },
  ], ShouldDisplayLoadMore: false }],
  [`${root}/giay-to/`, { Entries: [
    { FullPath: `${root}/giay-to/bien-ban`, Mode: dirMode },
  ], ShouldDisplayLoadMore: false }],
  [`${root}/giay-to/bien-ban/`, { Entries: [
    { FullPath: `${root}/giay-to/bien-ban/2026`, Mode: dirMode },
  ], ShouldDisplayLoadMore: false }],
  [`${root}/giay-to/bien-ban/2026/`, { Entries: [
    { FullPath: `${root}/giay-to/bien-ban/2026/biên bản BB-0001.txt`, Mode: fileMode, FileSize: 40, Mtime: "2026-01-06T00:00:00Z" },
  ], ShouldDisplayLoadMore: false }],
]);

const collectionsValue = {
  application: { id: appOne, name: "Đơn vị tiếp nhận" },
  collections: [
    {
      name: "nguoi-nop",
      records: 12,
      updatedAt: "2026-01-02T03:04:05.000Z",
      fields: [
        { name: "ma_nguoi_nop", type: "string", fillRate: 100 },
        { name: "tuoi", type: "number", fillRate: 75 },
        { name: "di_ung", type: "mixed", fillRate: 50 },
      ],
    },
  ],
};

let summaryReply = { applications: [{ id: appOne, name: "Đơn vị tiếp nhận" }, { id: appTwo, name: "Đơn vị xét duyệt" }] };
let collectionsReply = { status: 200, value: collectionsValue };
let filerUp = true;
let dataUp = true;
let data, filer, core, base;

const listen = (server) => new Promise((resolve) =>
  server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));

before(async () => {
  data = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    if (!dataUp) { response.writeHead(503); return response.end(); }
    const write = (status, value) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.url === "/rpc/storage_summary") return write(200, { status: 200, value: summaryReply });
    if (request.url === "/rpc/storage_collections") return write(200, collectionsReply);
    write(404, { error: "not_found" });
  });
  const dataUrl = await listen(data);
  filer = createServer((request, response) => {
    if (!filerUp) { response.writeHead(503); return response.end(); }
    if (request.headers.accept !== "application/json") { response.writeHead(400); return response.end(); }
    const pathname = decodeURIComponent(new URL(request.url, "http://filer").pathname);
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

const get = (path, method = "GET") => fetch(`${base}${path}`, { method });
const files = (query = "", method = "GET") => get(`/v1/storage/files?application=${appOne}${query}`, method);

function assertNoSecrets(text) {
  for (const secret of ["0120b996-711d-526b-a836-69fee754b79e", "chứng từ CT-0001.txt",
    "giấy đề nghị PD-0001.txt", "biên bản BB-0001.txt", "Ba\u0301o ca\u0301o.pdf"]) {
    assert.ok(!text.includes(secret), `${secret} must not be returned`);
  }
}

test("file listing shows one folder level and masks every file name", async () => {
  const response = await files();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.deepEqual(body.application, { id: appOne, name: "Đơn vị tiếp nhận" });
  assert.equal(body.path, "/");
  assert.deepEqual(body.folders.map((folder) => folder.name), ["giay-to", "ho-so"]);
  assert.deepEqual(body.folders.find((folder) => folder.name === "ho-so"), {
    name: "ho-so", files: 3, bytes: 220, updatedAt: "2026-01-05T00:00:00.000Z",
  });
  assert.deepEqual(body.folders.find((folder) => folder.name === "giay-to"), {
    name: "giay-to", files: 1, bytes: 40, updatedAt: "2026-01-06T00:00:00.000Z",
  });
  assert.deepEqual(body.files, [{
    name: "REA…ME", extension: "", bytes: 12, status: "clean", updatedAt: "2026-01-02T00:00:00.000Z",
  }]);
  assert.equal(body.truncated, false);
  assertNoSecrets(JSON.stringify(body));
});

test("navigating a folder returns masked names but never object keys or full paths", async () => {
  const response = await files("&path=/ho-so/chung-tu/2026/");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.path, "/ho-so/chung-tu/2026");
  assert.deepEqual(body.folders, []);
  assert.deepEqual(body.files.map((file) => file.name).sort(), ["Ba\u0301o\u2026a\u0301o.pdf", "chứ…01.txt"].sort());
  assert.deepEqual(body.files.map((file) => file.extension).sort(), ["pdf", "txt"]);
  assert.ok(body.files.every((file) => file.status === "clean"));
  assert.ok(body.files.every((file) => file.bytes > 0 && file.updatedAt));
  assertNoSecrets(JSON.stringify(body));
});

test("unsafe paths, repeated or unknown parameters and wrong methods are rejected", async () => {
  for (const query of ["&path=../secret", "&path=ho-so/../../secret", `&path=${"a".repeat(513)}`,
    "&path=%00", "&path=ho-so%5Cchung-tu", "&tenant=tenant-b", "&application=" + appOne]) {
    const response = await files(query);
    assert.equal(response.status, 400, query);
  }
  const post = await files("", "POST");
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET");
  assert.equal((await get("/v1/storage/files")).status, 400);
  assert.equal((await get(`/v1/storage/files?application=${appOne}&path=a&path=b`)).status, 400);
});

test("unknown applications, permission failures and filer outages fail closed", async () => {
  const missing = await get(`/v1/storage/files?application=${"33333333-3333-4333-8333-333333333333"}`);
  assert.equal(missing.status, 404);
  filerUp = false;
  try { assert.equal((await files()).status, 503); }
  finally { filerUp = true; }
  dataUp = false;
  try { assert.equal((await files()).status, 503); }
  finally { dataUp = true; }
});

test("an unverified client cannot read the catalogue", async () => {
  const withoutClient = createServer(async (request, response) => {
    try {
      await handleStorage(request, response, { ...identity, clientId: undefined },
        { dataUrl: base, dataSecret: "x".repeat(32), objectsUrl: base }, new URL(request.url, "http://core"));
    } catch (error) {
      json(response, error instanceof HttpError ? error.status : 500, { error: error.message });
    }
  });
  const url = await listen(withoutClient);
  try {
    assert.equal((await fetch(`${url}/v1/storage/files?application=${appOne}`)).status, 403);
    assert.equal((await fetch(`${url}/v1/storage/collections?application=${appOne}`)).status, 403);
  } finally { withoutClient.close(); }
});

test("collection structure exposes fields and fill rates but never values", async () => {
  const response = await get(`/v1/storage/collections?application=${appOne}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.deepEqual(body, collectionsValue);
  assert.ok(!JSON.stringify(body).includes("Nguyễn"));
  const extra = structuredClone(collectionsValue);
  extra.collections[0].fields[0].sample = "personal value";
  extra.collections[0].records = 1;
  extra.collections[0].values = ["secret"];
  collectionsReply = { status: 200, value: extra };
  const clean = await (await get(`/v1/storage/collections?application=${appOne}`)).json();
  assert.ok(!JSON.stringify(clean).includes("personal value"));
  assert.ok(!JSON.stringify(clean).includes("secret"));
  assert.equal(clean.collections[0].fields[0].name, "ma_nguoi_nop");
});

test("collections reject invalid shapes, unknown applications and errors from the database", async () => {
  const invalid = structuredClone(collectionsValue);
  invalid.collections[0].fields[0].fillRate = 101;
  collectionsReply = { status: 200, value: invalid };
  assert.equal((await get(`/v1/storage/collections?application=${appOne}`)).status, 503);
  collectionsReply = { status: 404, error: "application_not_found" };
  assert.equal((await get(`/v1/storage/collections?application=${appOne}`)).status, 404);
  collectionsReply = { status: 403, error: "storage_permission_required" };
  assert.equal((await get(`/v1/storage/collections?application=${appOne}`)).status, 403);
  collectionsReply = { status: 200, value: { application: { id: appOne, name: "x" }, collections: [{ name: "ok", records: 1, updatedAt: null, fields: [] }] } };
  assert.equal((await get(`/v1/storage/collections?application=${appOne}&path=/`)).status, 400);
  assert.equal((await get("/v1/storage/collections")).status, 400);
  collectionsReply = { status: 200, value: collectionsValue };
});

test("migration 026 uses a private read-only role and never returns values", () => {
  const sql = readFileSync(new URL("../infra/postgres/026-storage-collections.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE ROLE junctura_storage_collections_api NOLOGIN NOBYPASSRLS/);
  assert.match(sql, /p\.permissions @> ARRAY\['audit\.read'\]::text\[\]/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION core\.storage_collections\(jsonb\) TO junctura_storage_collections_api/);
  assert.match(sql, /LIMIT 200/);
  assert.match(sql, /INSERT INTO core\.schema_migrations\(version\) VALUES\(26\)/);
  assert.match(sql, /NOTIFY pgrst,'reload schema'/);
  assert.doesNotMatch(sql, /jsonb_build_object\('value'/);
});
