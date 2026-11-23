// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  ensureAggregateGroupLimit,
  MAX_AGGREGATE_GROUPS,
  parseAggregateQuery,
  parseListQuery,
  utcDay,
} from "../src/modules/data/query/query.mjs";
import { createQueryCursor } from "../src/modules/data/query/cursor.mjs";

const owner = "33333333-3333-4333-8333-333333333333";
const recordId = "44444444-4444-4444-8444-444444444444";
const indexed = ["status", "code", "quantity", "createdOn", "secret"];
const sensitive = ["secret"];
const fields = { indexed, sensitive };
const params = entries => new URLSearchParams(entries);
const rejects = (code, callback) => assert.throws(callback, error => error.status === 400 && error.message === code);

test("list query defaults to the legacy order and an empty filter", () => {
  assert.deepEqual(parseListQuery(params([]), fields), {
    limit: 100, order: "asc", sort: null, where: [], ownerAppId: null, cursor: null,
  });
  assert.deepEqual(parseListQuery(params([["limit", "1"], ["order", "desc"]]), fields), {
    limit: 1, order: "desc", sort: null, where: [], ownerAppId: null, cursor: null,
  });
});

test("list query parses every operator with typed JSON operands", () => {
  const query = parseListQuery(params([
    ["where[status]", "eq:\"open\""],
    ["where[code]", "in:[\"A-1\",2,true,null]"],
    ["where[quantity]", "gte:-1.5"],
    ["where[createdOn]", "lte:\"2030-01-01\""],
    ["where[secret]", "prefix:\"ab\""],
  ]), fields);
  assert.deepEqual(query.where, [
    { field: "status", op: "eq", value: "open" },
    { field: "code", op: "in", value: ["A-1", 2, true, null] },
    { field: "quantity", op: "gte", value: -1.5 },
    { field: "createdOn", op: "lte", value: "2030-01-01" },
    { field: "secret", op: "prefix", value: "ab" },
  ]);
  assert.equal(query.ownerAppId, null);
});

test("list query accepts scalar equality values including null and booleans", () => {
  for (const [operand, expected] of [["null", null], ["true", true], ["-2", -2], ["\"x\"", "x"]]) {
    assert.deepEqual(parseListQuery(params([["where[status]", `eq:${operand}`]]), fields).where,
      [{ field: "status", op: "eq", value: expected }]);
  }
});

test("list query rejects unknown, mistyped and repeated filters", () => {
  const invalid = [
    [["where[status]", "between:1"]],
    [["where[status]", "eq"]],
    [["where[status]", "eq:"]],
    [["where[status]", "eq:{\"a\":1}"]],
    [["where[status]", "eq:[1]"]],
    [["where[status]", "eq:1e999"]],
    [["where[status]", "in:[]"]],
    [["where[status]", "in:{}"]],
    [["where[status]", "in:[[1]]"]],
    [["where[status]", "gte:true"]],
    [["where[status]", "lte:null"]],
    [["where[status]", "prefix:1"]],
    [["where[missing]", "eq:1"]],
    [["where[bad-field]", "eq:1"]],
    [["where[status]", "eq:1"], ["where[status]", "eq:2"]],
    [["where[status", "eq:1"]],
    [["where[]", "eq:1"]],
    [["where[status]x", "eq:1"]],
  ];
  for (const entries of invalid) rejects("invalid_query", () => parseListQuery(params(entries), fields));
});

test("list query applies the declared index and management masking rules to filters and sort", () => {
  rejects("invalid_query", () => parseListQuery(params([["where[missing]", "eq:1"]]), fields));
  rejects("invalid_query", () => parseListQuery(params([["sort", "missing.asc"]]), fields));
  rejects("invalid_query", () => parseListQuery(params([["where[secret]", "eq:\"x\""]]), { ...fields, management: true }));
  rejects("invalid_query", () => parseListQuery(params([["sort", "secret.desc"]]), { ...fields, management: true }));
  assert.deepEqual(parseListQuery(params([["where[missing]", "eq:1"]]), {}).where, [{ field: "missing", op: "eq", value: 1 }]);
});

test("list query checks operands against declared field kinds", () => {
  const typed = { indexed: [...indexed, "flag", "count"], sensitive,
    types: { status: "string", code: "string", quantity: "number", createdOn: "date-time", secret: "string", flag: "boolean", count: "integer" } };
  assert.deepEqual(parseListQuery(params([
    ["where[status]", "eq:\"open\""], ["where[quantity]", "in:[1,2]"], ["where[flag]", "eq:true"],
    ["where[createdOn]", "gte:\"2030-01-02T02:00:00+07:00\""], ["where[code]", "prefix:\"A-\""],
  ]), typed).where.length, 5);
  for (const entries of [
    [["where[status]", "eq:1"]],
    [["where[quantity]", "eq:\"1\""]],
    [["where[flag]", "eq:\"false\""]],
    [["where[count]", "eq:1.5"]],
    [["where[createdOn]", "eq:\"2030-01-02\""]],
    [["where[createdOn]", "eq:\"2030-02-30T00:00:00Z\""]],
    [["where[quantity]", "in:[1,\"2\"]"]],
    [["where[missing]", "eq:1"]],
  ]) rejects("invalid_query", () => parseListQuery(params(entries), typed));
  assert.throws(() => parseListQuery(params([]), { types: { status: "object" } }), TypeError);
});

test("numeric operands keep the parser's exact decimal precision", () => {
  const typed = { indexed: ["quantity", "count"], types: { quantity: "number", count: "integer" } };
  for (const entries of [
    [["where[quantity]", "eq:1.0000000000000001"]],
    [["where[quantity]", "in:[1.0000000000000001]"]],
    [["where[count]", "eq:1.0000000000000001"]],
    [["where[count]", "in:[2.0000000000000001]"]],
    [["where[count]", "gte:1.5"]],
  ]) rejects("invalid_query", () => parseListQuery(params(entries), typed));
  assert.deepEqual(parseListQuery(params([["where[count]", "gte:1"]]), typed).where,
    [{ field: "count", op: "gte", value: 1 }]);
  assert.deepEqual(parseListQuery(params([["where[quantity]", "eq:1e3"]]), typed).where,
    [{ field: "quantity", op: "eq", value: 1000 }]);
});

test("aggregate day buckets require a date or date-time field", () => {
  const typed = { ...fields, types: { status: "string", createdOn: "date-time" } };
  assert.deepEqual(parseAggregateQuery(params([["count", ""], ["groupBy", "day(createdOn)"]]), typed).groupBy,
    [{ field: "createdOn", day: true }]);
  rejects("invalid_query", () => parseAggregateQuery(params([["count", ""], ["groupBy", "day(status)"]]), typed));
});

test("list query parses sort and rejects the order conflict", () => {
  assert.deepEqual(parseListQuery(params([["sort", "status.desc"]]), fields).sort, { field: "status", direction: "desc" });
  for (const source of ["status", "status.ASC", "status.up", ".asc", "bad-field.asc", "status.asc.desc"]) {
    rejects("invalid_query", () => parseListQuery(params([["sort", source]]), fields));
  }
  rejects("invalid_query", () => parseListQuery(params([["sort", "status.asc"], ["order", "asc"]]), fields));
  rejects("invalid_query", () => parseListQuery(params([["order", "asc"], ["sort", "status.asc"]]), fields));
});

test("list query validates closed keys, limits, owner and cursor shape", () => {
  for (const source of ["limit=0", "limit=101", "limit=-1", "limit=1.5", "limit=abc", "limit=", "order=", "order=ASC",
    "order=other", "offset=1", "where=status", "ownerAppId=not-a-uuid", "where[status]=eq%3A1&where[status]=eq%3A2"]) {
    rejects("invalid_query", () => parseListQuery(new URLSearchParams(source), fields));
  }
  for (const source of ["limit=1&limit=2", "order=asc&order=desc", "cursor=x&cursor=y", "sort=status.asc&sort=status.desc",
    "ownerAppId=33333333-3333-4333-8333-333333333333&ownerAppId=33333333-3333-4333-8333-333333333333"]) {
    rejects("invalid_query", () => parseListQuery(new URLSearchParams(source), fields));
  }
  for (const cursor of ["", "!", "a b", "a".repeat(513), "abc="]) {
    rejects("invalid_cursor", () => parseListQuery(params([["cursor", cursor]]), fields));
  }
  assert.equal(parseListQuery(params([["ownerAppId", owner]]), {}).ownerAppId, owner);
  assert.equal(parseListQuery(params([["cursor", "opaque_next-cursor"]]), {}).cursor, "opaque_next-cursor");
});

test("aggregate query requires an explicit count and parses one or two dimensions", () => {
  assert.deepEqual(parseAggregateQuery(params([["count", ""]]), fields), { count: true, groupBy: [], where: [], ownerAppId: null });
  assert.deepEqual(parseAggregateQuery(params([["count", "true"], ["groupBy", "status"], ["groupBy", "day(createdOn)"]]), fields), {
    count: true,
    groupBy: [{ field: "status", day: false }, { field: "createdOn", day: true }],
    where: [],
    ownerAppId: null,
  });
  assert.deepEqual(parseAggregateQuery(params([
    ["count", "true"], ["where[status]", "eq:\"open\""], ["ownerAppId", owner],
  ]), fields).where, [{ field: "status", op: "eq", value: "open" }]);
});

test("aggregate query enforces count, dimension count and field eligibility", () => {
  for (const source of ["", "count=false", "count=True", "count=true&count=true", "count&count", "unknown=1",
    "groupBy=", "groupBy=bad-field", "groupBy=day()", "groupBy=day(bad-field)", "groupBy=day (createdOn)",
    "groupBy=status&groupBy=status", "groupBy=status&groupBy=code&groupBy=quantity",
    "groupBy=missing", "ownerAppId=bad", "ownerAppId=33333333-3333-4333-8333-333333333333&ownerAppId=33333333-3333-4333-8333-333333333333",
    "where[status]=eq"]) {
    rejects("invalid_query", () => parseAggregateQuery(new URLSearchParams(source), fields));
  }
  rejects("invalid_query", () => parseAggregateQuery(params([["count", ""], ["groupBy", "secret"]]), { ...fields, management: true }));
  rejects("invalid_query", () => parseAggregateQuery(params([["count", ""], ["groupBy", "day(secret)"]]), { ...fields, management: true }));
  rejects("invalid_query", () => parseAggregateQuery(params([["count", ""], ["where[secret]", "eq:1"]]), { ...fields, management: true }));
  assert.deepEqual(parseAggregateQuery(params([["count", ""], ["groupBy", "missing"]]), {}).groupBy, [{ field: "missing", day: false }]);
});

test("aggregate grouping stops at the public group limit", () => {
  assert.equal(ensureAggregateGroupLimit(0), 0);
  assert.equal(ensureAggregateGroupLimit(MAX_AGGREGATE_GROUPS), MAX_AGGREGATE_GROUPS);
  rejects("invalid_query", () => ensureAggregateGroupLimit(MAX_AGGREGATE_GROUPS + 1));
  assert.throws(() => ensureAggregateGroupLimit(1.5), TypeError);
  assert.throws(() => ensureAggregateGroupLimit(-1), TypeError);
});

test("UTC day buckets convert offsets and reject impossible dates", () => {
  assert.equal(utcDay("2030-01-02"), "2030-01-02");
  assert.equal(utcDay("2030-01-02T02:00:00+07:00"), "2030-01-01");
  assert.equal(utcDay("2030-01-01T23:30:00-02:00"), "2030-01-02");
  assert.equal(utcDay("2024-02-29T00:00:00Z"), "2024-02-29");
  for (const value of ["2030-02-30", "2030-01-02Tbad", "2030-1-2", "", null, 1]) assert.throws(() => utcDay(value), TypeError);
});

const codecFor = secret => createQueryCursor(secret);
const secret = "synthetic-query-cursor-secret-value";
const binding = (overrides = {}) => ({
  ownerAppId: owner,
  where: [{ field: "status", op: "eq", value: "open" }],
  sort: "data.status.asc",
  schemaRevision: 7,
  key: ["open"],
  id: recordId,
  ...overrides,
});
const expected = (overrides = {}) => ({
  ownerAppId: owner,
  where: [{ field: "status", op: "eq", value: "open" }],
  sort: "data.status.asc",
  schemaRevision: 7,
  ...overrides,
});

test("query cursors are opaque, signed and bind the key and tie-break ID", () => {
  const codec = codecFor(secret);
  const value = codec.encode(binding());
  assert.match(value, /^[A-Za-z0-9_-]+$/);
  assert.ok(value.length <= 512);
  assert.deepEqual(codec.decode(value, expected()), { key: ["open"], id: recordId });
  assert.deepEqual(codec.decode(codec.encode(binding({ key: [null] })), expected()), { key: [null], id: recordId });
});

test("query cursors bind owner, canonical filters, sort and schema revision", () => {
  const codec = codecFor(secret);
  const value = codec.encode(binding({
    where: [{ field: "status", op: "eq", value: "open" }, { field: "code", op: "prefix", value: "A-" }],
  }));
  assert.deepEqual(codec.decode(value, expected({
    where: [{ field: "code", op: "prefix", value: "A-" }, { field: "status", op: "eq", value: "open" }],
  })), { key: ["open"], id: recordId });
  for (const mismatch of [
    expected({ ownerAppId: "55555555-5555-4555-8555-555555555555" }),
    expected({ where: [{ field: "status", op: "eq", value: "closed" }] }),
    expected({ sort: "data.status.desc" }),
    expected({ schemaRevision: 8 }),
  ]) rejects("invalid_cursor", () => codec.decode(value, mismatch));
});

test("tampered, truncated and foreign-secret cursors are rejected", () => {
  const codec = codecFor(secret);
  const value = codec.encode(binding());
  const tampered = `${value.slice(0, -1)}${value.endsWith("A") ? "B" : "A"}`;
  const malformed = [
    "", "!", value.slice(0, -1), `${value}=`, `${value}.`, value.repeat(2),
    tampered, Buffer.from([255, 254]).toString("base64url"), Buffer.from("{\"p\":{},\"h\":\"x\"}").toString("base64url"),
  ];
  for (const cursor of malformed) rejects("invalid_cursor", () => codec.decode(cursor, expected()));
  rejects("invalid_cursor", () => codecFor("another-synthetic-cursor-secret").decode(value, expected()));
  assert.throws(() => createQueryCursor("short"), TypeError);
});

test("cursors distinguish system order from a data field with the same name", () => {
  const codec = codecFor(secret);
  const state = "55555555-5555-4555-8555-555555555555";
  const system = codec.encodeState(binding({ sort: "system.created_at.asc" }), state);
  const data = codec.encodeState(binding({ sort: "data.created_at.asc" }), state);
  rejects("invalid_cursor", () => codec.decodeState(system, expected({ sort: "data.created_at.asc" })));
  rejects("invalid_cursor", () => codec.decodeState(data, expected({ sort: "system.created_at.asc" })));
  rejects("invalid_cursor", () => codec.decodeState(data, expected({ sort: "data.created_at.desc" })));
  assert.throws(() => codec.encodeState(binding({ sort: "created_at.asc" }), state), TypeError);
});

test("state cursors bind a server-side cursor id without embedding the sort key", () => {
  const codec = codecFor(secret);
  const value = codec.encodeState(binding(), "55555555-5555-4555-8555-555555555555");
  assert.match(value, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(codec.decodeState(value, expected()), { stateId: "55555555-5555-4555-8555-555555555555" });
  for (const mismatch of [
    expected({ ownerAppId: "66666666-6666-4666-8666-666666666666" }),
    expected({ sort: "data.status.desc" }),
    expected({ schemaRevision: 8 }),
  ]) rejects("invalid_cursor", () => codec.decodeState(value, mismatch));
  assert.throws(() => codec.encodeState(binding(), "not-a-uuid"), TypeError);
  rejects("invalid_cursor", () => codec.decode(value, expected()));
});

test("cursor encoding rejects malformed bindings and overlong values", () => {
  const codec = codecFor(secret);
  for (const overrides of [
    { ownerAppId: "bad" },
    { sort: "status" },
    { schemaRevision: -1 },
    { schemaRevision: 1.5 },
    { key: [] },
    { key: ["a", "b"] },
    { key: [{}] },
    { id: "bad" },
    { where: [{ field: "status", op: "eq", value: "open" }, { field: "status", op: "eq", value: "closed" }] },
  ]) assert.throws(() => codec.encode(binding(overrides)), TypeError);
  assert.throws(() => codec.encode(binding({ key: ["x".repeat(600)] })), RangeError);
});

const querySql = readFileSync(new URL("../infra/postgres/031-record-queries.sql", import.meta.url), "utf8");

test("query SQL keeps metadata and rows in one stable snapshot and hardens search_path", () => {
  const readStart = querySql.indexOf("CREATE FUNCTION app_private.record_query_list_read");
  const readEnd = querySql.indexOf("CREATE FUNCTION app_private.record_query_list(");
  assert.ok(readStart > 0 && readEnd > readStart);
  const read = querySql.slice(readStart, readEnd);
  assert.match(read, /LANGUAGE plpgsql STABLE/);
  assert.doesNotMatch(read, /\b(?:INSERT INTO|DELETE FROM)\b/);
  assert.match(querySql, /CREATE FUNCTION app_private\.record_query_aggregate[\s\S]{0,80}LANGUAGE plpgsql STABLE/);
  assert.match(querySql, /sort_text := 'system\.created_at\.'/);
  assert.match(querySql, /sort_text := 'data\.' \|\| sort_field/);
  assert.match(querySql, /lookup := left\(text_value, 256\)/);
  assert.match(querySql, /WHEN schema_doc->'properties'->field->>'type' = 'integer' THEN 'integer'/);
  const paths = querySql.match(/SET search_path = [^\n]+/g);
  assert.ok(paths.length > 0 && paths.every(line => line.includes("pg_temp")));
});
