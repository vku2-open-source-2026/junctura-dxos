// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { handleAppRecords, logicalRequestDigest, parseRecordBatch } from "../src/modules/data/records.mjs";

const id = "11111111-1111-4111-8111-111111111111";
const tag = `"record-${"a".repeat(64)}-1"`;
const create = { op: "create", collection: "entries", data: { code: "Same" } };
const modify = { op: "increment", collection: "entries", id, operations: [{ op: "increment", field: "quantity", by: 1 }] };

test("batch preserves order and repeated IDs, including a precondition checked in SQL", () => {
  const replacement = { op: "replace", collection: "entries", id, data: {}, ifMatch: tag };
  const operations = [create, modify, modify, replacement, { op: "delete", collection: "entries", id }];
  assert.equal(parseRecordBatch({ operations }).operations, operations);
  assert.equal(parseRecordBatch({ operations: Array(50).fill(create) }).operations.length, 50);
  for (const invalid of [{ operations: [] }, { operations: Array(51).fill(create) }, { operations, extra: 1 }]) {
    assert.throws(() => parseRecordBatch(invalid), { status: 400 });
  }
  for (const [item, suffix] of [[{ ...create, id }, ""], [{ ...modify, id: "bad" }, "/id"],
    [{ ...replacement, ifMatch: "*" }, "/ifMatch"], [{ ...modify, operations: [] }, "/operations"],
    [{ ...create, op: "__proto__" }, "/op"]]) {
    assert.throws(() => parseRecordBatch({ operations: [create, item] }),
      error => error.status === 400 && error.details.issues[0].path === "/operations/1" + suffix);
  }
  const original = logicalRequestDigest({ body: { operations } });
  assert.notEqual(original, logicalRequestDigest({ body: { operations: [...operations].reverse() } }));
  assert.notEqual(original, logicalRequestDigest({ body: { operations: [...operations.slice(0, 3),
    { ...replacement, ifMatch: tag.replace("-1", "-2") }, operations[4]] } }));
});

async function command(method, path, body, ifMatch, requestKey = id) {
  const url = new URL(path, "http://core.invalid");
  const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method, headers: {
    "content-type": "application/json", "idempotency-key": requestKey, "if-match": ifMatch,
  } });
  const response = { status: 0, setHeader() {}, writeHead(status) { this.status = status; }, end() {} };
  const identity = { tenantId: "test", subject: id, issuer: "http://issuer.invalid", clientId: "fixture", roles: ["core-writer"] };
  await handleAppRecords(request, response, identity, { dataUrl: "http://data.invalid", dataSecret: "x".repeat(32) }, url);
  return response.status;
}

test("upsert submits the case-sensitive path value and conditional digest to the RPC", async t => {
  const path = "/v2/data/entries/by-key/Same";
  const body = { data: { code: "Same" } };
  const upstream = t.mock.method(globalThis, "fetch", async (_url, request) => {
    const { operation, payload } = JSON.parse(request.body);
    assert.equal(operation, "upsert");
    assert.equal(payload.uniqueValue, "Same");
    assert.equal(payload.collection, "entries");
    assert.equal(payload.path, path);
    assert.deepEqual(payload.body, body);
    assert.equal(payload.digest, logicalRequestDigest({ body, ifMatch: tag }));
    return Response.json({ status: 200, value: { version: 2 } });
  });
  await assert.rejects(command("PUT", path + "%2F", body, tag), { status: 400 });
  await assert.rejects(command("PUT", path, body, tag, ""), { status: 400 });
  assert.equal(upstream.mock.callCount(), 0);
  assert.equal(await command("PUT", path, body, tag), 200);
});
