// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { createApi } from "../src/api.mjs";
import { test } from "node:test";
import { logicalRequestDigest, parseCollectionSchema, parseRecordWrite, parseRecordWriteHeaders,
  validRecordETag } from "../src/modules/data/records.mjs";
import { parseRecordJson } from "../src/platform/http/http.mjs";

const key = "11111111-1111-4111-8111-111111111111";
const tag = `"record-${"a".repeat(64)}-1"`;

function registration() {
  return {
    schema: {
      type: "object", required: ["code"], properties: {
        code: { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Z]{2}-[0-9]+$" },
        date: { type: "string", format: "date" },
        when: { type: "string", format: "date-time" },
        quantity: { type: "integer", minimum: -10, maximum: 50 },
        enabled: { type: "boolean" },
        notes: { type: "string" },
        more: { type: "array", items: { properties: { "a/~b": { enum: [{ a: 1, b: 2 }, null] } } } },
      },
    },
    indexed: ["code", "date", "when", "quantity", "enabled"], uniqueKey: "code",
    searchable: ["notes"], sensitive: ["notes"],
    auditActions: [{ action: "record.viewed", sensitivity: "restricted", visibleToSubject: true }],
  };
}

test("collection schema accepts the recursive subset and rejects ambiguous policies", () => {
  assert.deepEqual(parseCollectionSchema(registration()), registration());
  for (const edit of [
    value => { value.schema.required = []; },
    value => { value.indexed.push("missing"); },
    value => { value.indexed.push("more"); },
    value => { value.indexed.push("code"); },
    value => { value.auditActions.push(value.auditActions[0]); },
    value => { value.schema.properties.code.additionalProperties = false; },
    value => { value.schema.properties.code.pattern = "(x+)+"; },
    value => { value.schema.properties.code.pattern = "x".repeat(257); },
    value => { value.schema.properties.code.maxLength = 0; },
    value => { value.schema.properties.quantity.minimum = 51; },
    value => { value.schema.properties.date.format = "date-ish"; },
    value => { value.schema.properties.more.items = { enum: [{ a: 1, b: 2 }, { b: 2, a: 1 }] }; },
    value => {
      let child = value.schema.properties.more;
      for (let depth = 2; depth <= 8; depth++) child = (child.items = {});
    },
  ]) {
    const value = registration();
    edit(value);
    assert.throws(() => parseCollectionSchema(value), { status: 400, message: "invalid_schema" });
  }
});

test("strict JSON protects storage and canonical request digests", () => {
  for (const source of [
    '{"data":{"x":0,"\\u0078":1}}', '{"data":{"x":"\\u0000"}}', '{"data":{"x":"\\ud800"}}',
    '{"data":{"\\u0000":false}}', '{"data":{"x":1e999}}', '{"data":{"x":1.1e-999}}',
    '{"data":{"x":9007199254740993}}', '{"data":{"x":0.10000000000000001}}',
    "[".repeat(257) + "0" + "]".repeat(257),
  ]) assert.throws(() => parseRecordJson(source), SyntaxError);
  const first = parseRecordJson('{"data":{"__proto__":{"nested":1},"x":[1.00e1,"é"],"ñ":null}}');
  const same = parseRecordJson('{"data":{"ñ":null,"x":[10,"é"],"__proto__":{"nested":1}}}');
  assert.equal(Object.hasOwn(parseRecordWrite(first).data, "__proto__"), true);
  assert.equal(logicalRequestDigest({ body: first }), logicalRequestDigest({ body: same }));
  assert.notEqual(logicalRequestDigest({ body: first, ifMatch: tag }), logicalRequestDigest({ body: first }));
  same.data.x.reverse();
  assert.notEqual(logicalRequestDigest({ body: first }), logicalRequestDigest({ body: same }));
  for (const value of [{}, { data: null }, { data: [] }, { data: {}, extra: true }]) {
    assert.throws(() => parseRecordWrite(value), { status: 400, message: "invalid_request" });
  }
});

test("strong ETag syntax agrees with the Foundation contract", () => {
  const contract = JSON.parse(readFileSync(new URL("../docs/contracts/foundation-api.openapi.json", import.meta.url)));
  const pattern = new RegExp(contract.components.schemas.RecordETag.pattern);
  assert.deepEqual(parseRecordWriteHeaders({ "idempotency-key": key, "if-match": tag },
    { requireIdempotency: true, allowIfMatch: true }), { requestKey: key, ifMatch: tag });
  for (const invalid of [`W/${tag}`, `${tag}, ${tag}`, '"record-1"', "*", tag.slice(0, -1), tag.replace("-1", "-01")]) {
    assert.equal(pattern.test(invalid), false);
    assert.equal(validRecordETag(invalid), false);
    assert.throws(() => parseRecordWriteHeaders({ "if-match": invalid }, { allowIfMatch: true }), { status: 400 });
  }
  assert.equal(pattern.test(tag), true);
  assert.throws(() => parseRecordWriteHeaders({}, { requireIdempotency: true }), { status: 400 });
  assert.throws(() => parseRecordWriteHeaders({ "idempotency-key": `${key}, ${key}` }), { status: 400 });
});

test("the Core router sends writes, queries and imports to their RPCs with verified claims", async t => {
  const issuer = "https://issuer.invalid";
  const outbound = t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url.startsWith(issuer)) return Response.json({
      active: true, iss: issuer, aud: "junctura-core", exp: Date.now() / 1000 + 60,
      sub: "verified-subject", client_id: "verified-client", tenant_id: "tenant-a", tenant_memberships: ["tenant-a"],
      realm_access: { roles: ["core-reader", "core-writer"] },
    });
    const claims = JSON.parse(Buffer.from(options.headers.Authorization.split(".")[1], "base64url"));
    assert.equal(claims.tenant_id, "tenant-a");
    assert.equal(claims.client_id, "verified-client");
    assert.equal(claims.sub, "verified-subject");
    assert.equal(claims.role, "junctura_record_api");
    const command = JSON.parse(options.body);
    if (url === "https://data.invalid/rpc/record_query") {
      if (command.operation === "describe") {
        return Response.json({ status: 200, value: { ownerAppId: key, indexed: ["code"], sensitive: [],
          types: { code: "string" }, management: false, schemaRevision: 1 } });
      }
      assert.equal(command.operation, "list");
      assert.equal(command.payload.ownerAppId, key);
      assert.equal(command.payload.filters.length, 1);
      return Response.json({ status: 200, value: { items: [], nextCursorId: null } });
    }
    if (url === "https://data.invalid/rpc/record_archive") {
      assert.equal(command.operation, "import");
      assert.deepEqual(command.payload.records, [{ collection: "records", id: key, data: {} }]);
      return Response.json({ status: 200, value: { created: 1 } });
    }
    assert.equal(url, "https://data.invalid/rpc/record_command");
    assert.equal(command.operation, "batch");
    assert.equal(command.payload.path, "/v2/data:batch");
    return Response.json({ status: 200, value: { results: [{ op: "create", id: key, version: 1 }] } });
  });
  const route = createApi({ issuer, identityUrl: issuer, clientSecret: "test", dataUrl: "https://data.invalid",
    dataSecret: "test".repeat(8), strictRecords: true });
  const send = async (headers, { method = "POST", url = "/v2/data:batch",
    body = '{"operations":[{"op":"create","collection":"records","data":{}}]}' } = {}) => {
    const request = Object.assign(Readable.from([Buffer.from(body)]), { method, url, headers: {
      "content-type": "application/json", "idempotency-key": key, "x-tenant-id": "tenant-b", ...headers,
    } });
    const result = {};
    await route(request, {
      setHeader() {}, writeHead(status) { result.status = status; }, end(body) { result.body = JSON.parse(body); },
    });
    return result;
  };
  assert.equal((await send({})).status, 401);
  assert.equal(outbound.mock.callCount(), 0);
  assert.deepEqual(await send({ authorization: "Bearer caller-token" }),
    { status: 200, body: { results: [{ op: "create", id: key, version: 1 }] } });
  assert.equal(outbound.mock.callCount(), 2);
  const auth = { authorization: "Bearer caller-token" };
  assert.deepEqual(await send(auth, { method: "GET", url: "/v2/data/records?where%5Bcode%5D=eq%3A%22AZ%22", body: "" }),
    { status: 200, body: { items: [], nextCursor: null } });
  assert.deepEqual(await send({ ...auth, "content-type": "application/x-ndjson" }, { url: "/v2/data:import",
    body: JSON.stringify({ collection: "records", id: key, data: {} }) + "\n" }),
    { status: 200, body: { created: 1 } });
});
