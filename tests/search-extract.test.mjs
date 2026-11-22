// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { test } from "node:test";
import { extractText } from "../src/modules/search/extract.mjs";
import { createMeilisearch } from "../src/modules/search/meilisearch.mjs";
import { decodeSearchCursor, encodeSearchCursor } from "../src/modules/search/search.mjs";

const identity = { tenantId: "tenant-a", appId: "22222222-2222-4222-8222-222222222222" };

function pdfDocument(content) {
  const stream = deflateSync(content);
  const objects = [
    "1 0 obj << /Type /Catalog >> endobj",
    "2 0 obj << /Type /Page /Contents 3 0 R >> endobj",
    `3 0 obj << /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`,
  ];
  const head = objects.join("\n");
  return Buffer.concat([
    Buffer.from(`%PDF-1.4\n${head}`, "latin1"),
    stream,
    Buffer.from("\nendstream\nendobj\n%%EOF\n", "latin1"),
  ]);
}

test("text extraction covers plain, markdown, csv, json and PDF text layers", () => {
  assert.equal(extractText(Buffer.from("plain notes\nsecond line")), "plain notes\nsecond line");
  assert.equal(extractText(Buffer.from("### Title\n\n- item **bold**\n")), "Title\nitem bold");
  assert.equal(extractText(Buffer.from('name,note\n"junctura, core",ok\n')), "name note\njunctura core ok");
  assert.equal(extractText(Buffer.from('{"report":{"title":"Quarterly","score":4},"tags":["a","b"]}')),
    "report\ntitle\nQuarterly\nscore\n4\ntags\na\nb");
  assert.match(extractText(pdfDocument(Buffer.from("BT /F1 12 Tf 72 720 Td (Quarterly review) Tj 0 -20 Td (second line) Tj ET"))),
    /Quarterly review[\n ]+second line/s);
});

test("binary content and PDFs without text yield nothing", () => {
  assert.equal(extractText(Buffer.alloc(0)), null);
  assert.equal(extractText(Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe])), null);
  assert.equal(extractText(Buffer.from("%PDF-1.4\nempty")), null);
  const broken = Buffer.concat([Buffer.from("%PDF-1.4\n3 0 obj << /Filter /FlateDecode >> stream\n", "latin1"),
    Buffer.from([1, 2, 3, 4]), Buffer.from("\nendstream\nendobj\n", "latin1")]);
  assert.equal(extractText(broken), null);
  // A UTF-8 byte-order mark is tolerated; near-JSON bytes stay indexable text.
  assert.equal(extractText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("after bom")])).trim(), "after bom");
  assert.equal(extractText(Buffer.from('{"broken": ')), '{"broken":');
});

test("extracted text is bounded", () => {
  const long = Buffer.from("x".repeat(100_000));
  assert.equal(extractText(long).length, 65_536);
});

test("meilisearch adapter creates the tenant index once and confirms tasks", async () => {
  const calls = [];
  const state = { index: false, tasks: {} };
  let nextTask = 1;
  const fetcher = async (url, options = {}) => {
    const path = new URL(url).pathname;
    const method = options.method ?? "GET";
    calls.push([path, method]);
    if (method === "GET" && path === "/indexes/junctura-search-tenant-a") {
      return Response.json({}, { status: state.index ? 200 : 404 });
    }
    if (method === "POST" && path === "/indexes") {
      state.index = true;
      const taskUid = nextTask++;
      state.tasks[taskUid] = "enqueued";
      return Response.json({ taskUid }, { status: 202 });
    }
    if ((method === "PATCH" && path === "/indexes/junctura-search-tenant-a/settings") ||
        (method === "POST" && path === "/indexes/junctura-search-tenant-a/documents")) {
      const taskUid = nextTask++;
      state.tasks[taskUid] = "enqueued";
      return Response.json({ taskUid }, { status: 202 });
    }
    if (method === "GET" && path.startsWith("/tasks/")) {
      const taskUid = Number(path.split("/").at(-1));
      if (state.tasks[taskUid] === "enqueued") state.tasks[taskUid] = "succeeded";
      return Response.json({ status: state.tasks[taskUid] });
    }
    return Response.json({}, { status: 400 });
  };
  const meili = createMeilisearch({ searchUrl: "http://search.test", searchKey: "master" }, fetcher);
  await meili.upsert("tenant-a", { id: "record:1", text: "hello" });
  await meili.upsert("tenant-a", { id: "record:2", text: "again" });
  assert.deepEqual(calls, [
    ["/indexes/junctura-search-tenant-a", "GET"],
    ["/indexes", "POST"],
    ["/tasks/1", "GET"],
    ["/indexes/junctura-search-tenant-a/settings", "PATCH"],
    ["/tasks/2", "GET"],
    ["/indexes/junctura-search-tenant-a/documents", "POST"],
    ["/tasks/3", "GET"],
    ["/indexes/junctura-search-tenant-a/documents", "POST"],
    ["/tasks/4", "GET"],
  ]);
});

test("meilisearch adapter fails closed on transport and task errors", async () => {
  const failing = async () => { throw new Error("down"); };
  const meili = createMeilisearch({ searchUrl: "http://search.test", searchKey: "master" }, failing);
  await assert.rejects(meili.search("tenant-a", "q", 10, 0), /search_unavailable/);
  let polls = 0;
  const routing = async (url, options = {}) => {
    const path = new URL(url).pathname;
    const method = options.method ?? "GET";
    if (method === "GET" && path === "/indexes/junctura-search-tenant-a") return Response.json({}, { status: 200 });
    if (method === "POST" && path === "/indexes/junctura-search-tenant-a/documents") {
      return Response.json({ taskUid: 7 }, { status: 202 });
    }
    if (path === "/tasks/7") {
      polls++;
      return Response.json({ status: polls >= 2 ? "failed" : "enqueued" });
    }
    return Response.json({}, { status: 400 });
  };
  const other = createMeilisearch({ searchUrl: "http://search.test", searchKey: "master" }, routing);
  await assert.rejects(other.upsert("tenant-a", { id: "record:1", text: "x" }), /search_unavailable/);
  assert.throws(() => createMeilisearch({ searchUrl: "http://search.test", searchKey: undefined }, failing),
    /search_unavailable/);
});

test("search cursors bind to the query, caller and generation, and expire", () => {
  const generation = "11111111-1111-4111-8111-111111111111";
  const cursor = encodeSearchCursor("review", identity, generation, 51);
  assert.deepEqual(decodeSearchCursor(cursor, "review", identity), { offset: 51, generation });
  assert.throws(() => decodeSearchCursor(cursor, "other", identity));
  assert.throws(() => decodeSearchCursor(cursor, "review", { ...identity, appId: "33333333-3333-4333-8333-333333333333" }));
  assert.throws(() => decodeSearchCursor(cursor, "review", { tenantId: "tenant-a", clientOnly: true }));
  assert.throws(() => decodeSearchCursor("broken", "review", identity));
  const expired = Buffer.from(JSON.stringify({ o: 0, g: generation, f: "x", e: Date.now() - 1 })).toString("base64url");
  assert.throws(() => decodeSearchCursor(expired, "review", identity));
});
