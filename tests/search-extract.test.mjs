// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { test } from "node:test";
import { extractText } from "../src/modules/search/extract.mjs";
import { createMeilisearch } from "../src/modules/search/meilisearch.mjs";
import { decodeSearchCursor, encodeSearchCursor } from "../src/modules/search/search.mjs";

const identity = { tenantId: "tenant-a", appId: "22222222-2222-4222-8222-222222222222" };

function pdfDocument(...streams) {
  const parts = [Buffer.from("%PDF-1.4\n", "latin1")];
  for (const content of streams) {
    const stream = deflateSync(content);
    parts.push(Buffer.from(`3 0 obj << /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, "latin1"),
      stream, Buffer.from("\nendstream\nendobj\n", "latin1"));
  }
  parts.push(Buffer.from("%%EOF\n", "latin1"));
  return Buffer.concat(parts);
}

test("text extraction covers plain, markdown, csv, json and PDF text layers", () => {
  assert.equal(extractText(Buffer.from("plain notes\nsecond line")), "plain notes\nsecond line");
  assert.equal(extractText(Buffer.from("### Title\n\n- item **bold**\n")), "Title\nitem bold");
  assert.equal(extractText(Buffer.from('name,note\n"junctura, core",ok\n')), "name note\njunctura core ok");
  assert.equal(extractText(Buffer.from('{"report":{"title":"Quarterly","score":4},"tags":["a","b"]}')),
    "report\ntitle\nQuarterly\nscore\n4\ntags\na\nb");
  assert.match(extractText(pdfDocument(Buffer.from("BT /F1 12 Tf 72 720 Td (Quarterly review) Tj 0 -20 Td (second line) Tj ET"))),
    /Quarterly review[\n ]+second line/s);
  // Hexadecimal strings are the second PDF text encoding.
  assert.match(extractText(pdfDocument(Buffer.from("BT /F1 12 Tf 72 720 Td <517561727465726C79 20726576696577> Tj ET"))),
    /^Quarterly review/);
  assert.equal(extractText(pdfDocument(Buffer.from("BT /F1 12 Tf 72 720 Td <41424> Tj ET"))), "AB@");
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

test("pdf extraction is bounded per stream, per document and in output", () => {
  // A decompression bomb yields no text at all instead of exhausting memory.
  const bomb = pdfDocument(Buffer.concat([
    Buffer.from("BT /F1 12 Tf 72 720 Td (quarterly) Tj ET"), Buffer.alloc(4_000_000, 0x20)]));
  assert.equal(extractText(bomb), null);
  // Many text streams still answer, bounded to the shared output ceiling.
  const page = "BT /F1 12 Tf 72 720 Td (".concat("word ".repeat(8192), ") Tj ET");
  const text = extractText(pdfDocument(page, page, page, page));
  assert.equal(text.length, 65_536);
});

test("extracted text is bounded", () => {
  const long = Buffer.from("x".repeat(100_000));
  assert.equal(extractText(long).length, 65_536);
});

test("meilisearch adapter creates the tenant index once and confirms tasks", async () => {
  const calls = [];
  const state = { index: false, tasks: {} };
  let nextTask = 1;
  const uid = "junctura-search-tenant-a";
  const fetcher = async (url, options = {}) => {
    const path = new URL(url).pathname;
    const method = options.method ?? "GET";
    calls.push([path, method]);
    if (method === "GET" && path === `/indexes/${uid}`) {
      return Response.json({}, { status: state.index ? 200 : 404 });
    }
    if (method === "POST" && path === "/indexes") {
      state.index = true;
      const taskUid = nextTask++;
      state.tasks[taskUid] = "enqueued";
      return Response.json({ taskUid }, { status: 202 });
    }
    if ((method === "PATCH" && path === `/indexes/${uid}/settings`) ||
        (method === "POST" && path === `/indexes/${uid}/documents`)) {
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
  await meili.upsert(uid, { id: "record:1", text: "hello" });
  await meili.upsert(uid, { id: "record:2", text: "again" });
  assert.deepEqual(calls, [
    [`/indexes/${uid}`, "GET"],
    ["/indexes", "POST"],
    ["/tasks/1", "GET"],
    [`/indexes/${uid}/settings`, "PATCH"],
    ["/tasks/2", "GET"],
    [`/indexes/${uid}/documents`, "POST"],
    ["/tasks/3", "GET"],
    [`/indexes/${uid}/documents`, "POST"],
    ["/tasks/4", "GET"],
  ]);
});

test("meilisearch adapter fails closed on transport and task errors", async () => {
  const failing = async () => { throw new Error("down"); };
  const uid = "junctura-search-tenant-a";
  const meili = createMeilisearch({ searchUrl: "http://search.test", searchKey: "master" }, failing);
  await assert.rejects(meili.search(uid, "q", 10, 0), /search_unavailable/);
  let polls = 0;
  const routing = async (url, options = {}) => {
    const path = new URL(url).pathname;
    const method = options.method ?? "GET";
    if (method === "GET" && path === `/indexes/${uid}`) return Response.json({}, { status: 200 });
    if (method === "POST" && path === `/indexes/${uid}/documents`) {
      return Response.json({ taskUid: 7 }, { status: 202 });
    }
    if (path === "/tasks/7") {
      polls++;
      return Response.json({ status: polls >= 2 ? "failed" : "enqueued" });
    }
    return Response.json({}, { status: 400 });
  };
  const other = createMeilisearch({ searchUrl: "http://search.test", searchKey: "master" }, routing);
  await assert.rejects(other.upsert(uid, { id: "record:1", text: "x" }), /search_unavailable/);
  assert.throws(() => createMeilisearch({ searchUrl: "http://search.test", searchKey: undefined }, failing),
    /search_unavailable/);
});

test("search cursors bind to the query, tenant, caller, scope and generation, and expire", () => {
  const secret = "s".repeat(32);
  const generation = "11111111-1111-4111-8111-111111111111";
  const scope = { generation, management: ["22222222-2222-4222-8222-222222222222"], shares: [] };
  const cursor = encodeSearchCursor("review", identity, scope, generation, 51, secret);
  assert.deepEqual(decodeSearchCursor(cursor, "review", identity, scope, secret), { offset: 51, generation });
  assert.throws(() => decodeSearchCursor(cursor, "other", identity, scope, secret));
  assert.throws(() => decodeSearchCursor(cursor, "review", { ...identity, subject: "other" }, scope, secret));
  assert.throws(() => decodeSearchCursor(cursor, "review", { ...identity, clientId: "other" }, scope, secret));
  assert.throws(() => decodeSearchCursor(cursor, "review", identity,
    { ...scope, management: [] }, secret), "a changed read scope expires the cursor");
  assert.throws(() => decodeSearchCursor("broken", "review", identity, scope, secret));
  const expired = `${Buffer.from(JSON.stringify({ o: 0, g: generation, f: "x", e: Date.now() - 1 })).toString("base64url")}.aaaa`;
  assert.throws(() => decodeSearchCursor(expired, "review", identity, scope, secret));
});
