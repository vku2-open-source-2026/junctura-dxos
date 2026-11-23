// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseImport } from "../src/modules/data/archive/archives.mjs";

const id = "44444444-4444-4444-8444-444444444444";
const line = (data = {}) => JSON.stringify({ collection: "entries", id, data });

const rejects = (callback, lineNumber, keyword) => assert.throws(callback, error => {
  assert.equal(error.status, 400);
  assert.equal(error.message, "invalid_request");
  assert.equal(error.details.issues.length, 1);
  assert.equal(error.details.issues[0].line, lineNumber);
  if (keyword) assert.equal(error.details.issues[0].keyword, keyword);
  return true;
});

test("an import body is required and blank lines are rejected with their line number", () => {
  rejects(() => parseImport(""), 1, "type");
  rejects(() => parseImport("\n"), 1, "type");
  rejects(() => parseImport(`${line()}\n\n${line()}\n`), 2, "type");
});

test("a leading BOM is not stripped and fails the first line", () => {
  rejects(() => parseImport(`\uFEFF${line()}\n`), 1, "type");
});

test("CRLF framing and syntax failures publish the failing one-based line", () => {
  rejects(() => parseImport(`${line()}\r\n`), 1, "type");
  rejects(() => parseImport(`${line()}\n{"broken"\n`), 2, "type");
});

test("malformed envelopes publish the line as an issue", () => {
  rejects(() => parseImport(`{"collection":"entries","id":"${id}"}\n`), 1, "properties");
  rejects(() => parseImport(`${line()}\n${JSON.stringify({ collection: "entries", id, data: {}, extra: true })}\n`), 2, "properties");
});

test("valid NDJSON keeps record order and IDs", () => {
  const second = "55555555-5555-4555-8555-555555555555";
  const text = `${line({ code: "A-1" })}\n${JSON.stringify({ collection: "entries2", id: second, data: { code: "B-1" } })}\n`;
  assert.deepEqual(parseImport(text), [
    { collection: "entries", id, data: { code: "A-1" } },
    { collection: "entries2", id: second, data: { code: "B-1" } },
  ]);
});

const archiveSql = readFileSync(new URL("../infra/postgres/034-record-archives.sql", import.meta.url), "utf8");

test("archive SQL validates the snapshot and page in one statement with a storage budget", () => {
  assert.match(archiveSql, /line_count bigint NOT NULL DEFAULT 0/);
  assert.match(archiveSql, /byte_count bigint NOT NULL DEFAULT 0/);
  assert.match(archiveSql, /PERFORM pg_advisory_xact_lock/);
  assert.match(archiveSql, /exportSnapshots/);
  assert.match(archiveSql, /exportBytes/);
  const pageStart = archiveSql.indexOf("CREATE FUNCTION app_private.record_export_page");
  const pageEnd = archiveSql.indexOf("CREATE FUNCTION app_private.record_export_end");
  const page = archiveSql.slice(pageStart, pageEnd);
  assert.match(page, /WITH snapshot AS \(/);
  assert.match(page, /JOIN snapshot s USING \(snapshot_id\)/);
  assert.match(page, /INTO valid, page_json, next_after/);
});

test("import SQL locks collections in sorted order and reports line issues", () => {
  const start = archiveSql.indexOf("CREATE FUNCTION app_private.record_import");
  const end = archiveSql.indexOf("CREATE FUNCTION core.record_archive");
  const body = archiveSql.slice(start, end);
  const lockAt = body.indexOf("FOR name IN SELECT DISTINCT");
  const writeAt = body.indexOf("FOR item IN SELECT value");
  assert.ok(lockAt > 0 && writeAt > lockAt);
  assert.match(body, /ORDER BY collection/);
  assert.match(body, /jsonb_build_object\('path', '', 'keyword', 'type', 'line', line_number\)/);
  assert.match(body, /jsonb_build_object\('path', '', 'keyword', 'properties', 'line', line_number\)/);
});

test("archive RPCs pin pg_temp last in search_path", () => {
  const paths = archiveSql.match(/SET search_path = [^\n]+/g);
  assert.ok(paths.length > 0 && paths.every(line => line.includes("pg_temp")));
});
