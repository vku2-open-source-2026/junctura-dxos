// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { handleAppRecords, parseRecordIncrements, parseRecordLockWrite, presentRecordRequest } from "../src/modules/data/records.mjs";

const id = "11111111-1111-4111-8111-111111111111";
const tag = `"record-${"a".repeat(64)}-1"`;
const identity = { tenantId: "test", issuer: "https://issuer.invalid", subject: id, clientId: "app", roles: ["core-writer"] };
const dataPath = `/v2/data/test/${id}`;
const operation = { op: "increment", field: "count", by: -1, min: 0 };

function adapter(strictRecords) {
  return async (method, path, headers = {}, value, caller = identity) => {
    const bytes = value === undefined ? "" : JSON.stringify(value);
    const request = Object.assign(Readable.from([Buffer.from(bytes)]), { method, headers: {
      ...(bytes ? { "content-type": "application/json", "content-length": String(bytes.length) } : {}), ...headers,
    } });
    const result = { headers: {} };
    const response = {
      setHeader: (name, value) => { result.headers[name] = value; },
      writeHead: (status, headers) => { Object.assign(result.headers, headers); result.status = status; },
      end: text => { result.value = text === undefined ? undefined : JSON.parse(text); },
    };
    const config = { dataUrl: "http://data.invalid", dataSecret: "x".repeat(32), strictRecords };
    const url = new URL(path, "http://core.invalid");
    await presentRecordRequest(request, response, () => handleAppRecords(request, response, caller, config, url));
    return result;
  };
}

test("atomic PATCH requires a key and preserves operation order with optional precondition", async t => {
  const operations = [operation, { ...operation, by: 2, min: 0, max: 3 }];
  assert.deepEqual(parseRecordIncrements(operations), operations);
  for (const value of [null, [], [undefined], [{ ...operation, by: "1" }], [{ ...operation, min: 2, max: 1 }],
    [{ ...operation, field: "$bad" }], [{ ...operation, extra: 1 }], [{ ...operation, min: null }]]) {
    assert.throws(() => parseRecordIncrements(value), { status: 400 });
  }
  const fetcher = t.mock.method(globalThis, "fetch", async (_url, request) => {
    const { operation, payload } = JSON.parse(request.body);
    assert.equal(operation, "increment");
    assert.equal(payload.requireMatch, false);
    assert.deepEqual(payload.body, { operations });
    assert.equal(payload.ifMatch, tag);
    return Response.json({ status: 200, value: { version: 2 }, headers: { ETag: tag, ignored: "private" } });
  });
  const send = adapter(true);
  const missing = await send("PATCH", dataPath, {}, { operations });
  assert.equal(missing.status, 400);
  assert.equal(fetcher.mock.callCount(), 0);
  const actual = await send("PATCH", dataPath, { "if-match": tag, "idempotency-key": id }, { operations });
  assert.equal(actual.status, 200);
  assert.equal(actual.headers.ETag, tag);
  assert.equal(actual.headers.ignored, undefined);
});

test("strict replacement and delete leave the lease and precondition order to SQL", async t => {
  let observed;
  t.mock.method(globalThis, "fetch", async (_url, request) => {
    observed = JSON.parse(request.body);
    const payload = observed.payload;
    return Response.json(payload.requireMatch && !payload.ifMatch ? { status: 428, error: "precondition_required" } :
      observed.operation === "delete" ? { status: 204 } :
        { status: 200, value: { data: {}, ...(!payload.legacyBody ? { version: 2 } : {}) } });
  });
  const strict = adapter(true);
  const compatibility = adapter(false);
  assert.equal((await strict("PATCH", dataPath, {}, { data: {} })).status, 428);
  assert.equal(observed.operation, "replace");
  assert.equal((await strict("DELETE", dataPath)).status, 428);
  assert.deepEqual((await strict("PATCH", dataPath, { "if-match": tag }, { data: {} })).value, { data: {}, version: 2 });
  assert.deepEqual((await compatibility("PATCH", dataPath, {}, { data: {} })).value, { data: {} });
  assert.equal((await compatibility("DELETE", dataPath)).status, 204);
  assert.equal((await strict("DELETE", dataPath, { "if-match": "bad" })).status, 400);
});

test("lock TTLs, verified writers and closed lock error envelopes", async t => {
  for (const ttlSeconds of [0, -1, 1.5, 1801, "300", null]) {
    assert.throws(() => parseRecordLockWrite({ ttlSeconds }), { status: 400 });
  }
  assert.deepEqual(parseRecordLockWrite({ ttlSeconds: 1800, lockId: id }), { ttlSeconds: 1800, lockId: id });
  assert.throws(() => parseRecordLockWrite({ lockId: "bad" }), { status: 400 });
  const expiry = "2028-01-01T00:00:00Z";
  const fetcher = t.mock.method(globalThis, "fetch", async (_url, request) => {
    const { operation, payload } = JSON.parse(request.body);
    if (operation === "lock") {
      assert.deepEqual(payload.body, {});
      return Response.json({ status: 423, error: "locked", details: { lockedBy: "A", lockedUntil: expiry, scope: "private" } });
    }
    assert.equal(operation, "unlock");
    assert.equal(payload.lockId, id);
    return Response.json({ status: 204 });
  });
  const send = adapter(false);
  const endpoint = dataPath + ":lock";
  assert.equal((await send("POST", endpoint, { "idempotency-key": id }, {}, { ...identity, roles: [] })).status, 403);
  assert.equal((await send("POST", endpoint, {}, {})).status, 400);
  assert.equal((await send("DELETE", endpoint, { "lock-id": "bad" })).status, 400);
  assert.equal(fetcher.mock.callCount(), 0);
  const locked = await send("POST", endpoint, { "idempotency-key": id });
  assert.equal(locked.status, 423);
  assert.deepEqual(locked.value, { error: "locked", requestId: locked.headers["X-Request-Id"], lockedBy: "A", lockedUntil: expiry });
  assert.equal((await send("DELETE", endpoint, { "lock-id": id })).status, 204);
});
