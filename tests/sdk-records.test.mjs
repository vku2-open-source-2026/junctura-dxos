// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createJuncturaClient } from "../sdk/node/index.mjs";

const recordId = "44444444-4444-4444-8444-444444444444";
const ownerAppId = "33333333-3333-4333-8333-333333333333";
const lockId = "11111111-1111-4111-8111-111111111111";
const key = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const keyCreate = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const keyReplace = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const keyIncrement = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const keyLock = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const keyUpsert = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const keyBatch = "12121212-1212-4212-8212-121212121212";
const keyImport = "13131313-1313-4313-8313-131313131313";
const keyShare = "14141414-1414-4414-8414-141414141414";

const record = version => ({
  id: recordId,
  collection: "entries",
  created_at: "2030-01-10T09:00:00Z",
  version,
  data: { code: "REF-0002", status: "open" },
});

const listen = server => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
});

const read = async request => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

test("SDK record, archive and share methods use the planned HTTP contract with a real gateway stand-in", async () => {
  const api = [];
  let schemaExpectation;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://gateway");
    const body = await read(request);
    if (url.pathname.endsWith("/protocol/openid-connect/token")) {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ access_token: "synthetic-token", token_type: "Bearer", expires_in: 300 }));
    }
    api.push({ method: request.method, path: url.pathname, query: [...url.searchParams], headers: request.headers, body });
    const send = (status, payload, headers = {}) => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(payload === undefined ? "" : typeof payload === "string" ? payload : JSON.stringify(payload));
    };
    if (request.method === "PUT" && url.pathname === "/v2/data-schemas/entries") {
      schemaExpectation = JSON.parse(body);
      return send(200, { collection: "entries", ...schemaExpectation, auditActions: [] });
    }
    if (request.method === "POST" && url.pathname === "/v2/data/entries") {
      return send(201, record(1), { etag: "\"record-create-1\"" });
    }
    if (request.method === "GET" && url.pathname === `/v2/data/entries/${recordId}`) {
      return send(200, record(2), { etag: "\"record-get-2\"" });
    }
    if (request.method === "PATCH" && url.pathname === `/v2/data/entries/${recordId}`) {
      const parsed = JSON.parse(body);
      return send(200, record(parsed.operations ? 4 : 3), { etag: parsed.operations ? "\"record-increment-4\"" : "\"record-replace-3\"" });
    }
    if (request.method === "DELETE" && url.pathname === `/v2/data/entries/${recordId}`) return send(204);
    if (url.pathname === `/v2/data/entries/${recordId}:lock`) {
      if (request.method === "POST") return send(200, { lockId, lockedUntil: "2030-01-10T09:05:00Z" });
      return send(204);
    }
    if (request.method === "PUT" && url.pathname === "/v2/data/entries/by-key/REF-0002") {
      return send(201, record(1), { etag: "\"record-upsert-1\"" });
    }
    if (request.method === "POST" && url.pathname === "/v2/data:batch") {
      return send(200, { results: [{ op: "create", id: recordId, version: 1 }] });
    }
    if (request.method === "GET" && url.pathname === "/v2/data/entries/aggregate") {
      return send(200, { count: 2, groups: [{ key: ["open", "2030-01-10"], count: 2 }] });
    }
    if (request.method === "GET" && url.pathname === "/v2/data/entries") {
      return send(200, { items: [record(2)], nextCursor: "next-cursor" });
    }
    if (request.method === "GET" && url.pathname === "/v2/data:export") {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      return response.end("{\"collection\":\"entries\",\"id\":\"44444444-4444-4444-8444-444444444444\",\"data\":{}}\n");
    }
    if (request.method === "POST" && url.pathname === "/v2/data:import") return send(200, { created: 2 });
    if (request.method === "POST" && url.pathname === "/v2/resource-shares") {
      return send(201, { shareId: lockId, resourceType: "record", resourceId: recordId, granteeAppGroup: "partners", action: "read", expiresAt: "2030-01-12T12:00:00Z" });
    }
    send(404, { error: "not_found" });
  });
  try {
    const baseUrl = await listen(server);
    const client = createJuncturaClient({ baseUrl, clientId: "synthetic-client", clientSecret: "synthetic-secret" });

    const schema = {
      schema: { type: "object", required: ["code"], properties: { code: { type: "string" } } },
      indexed: ["code"], uniqueKey: "code", searchable: [], sensitive: [],
    };
    assert.equal((await client.registerCollectionSchema("entries", schema)).collection, "entries");
    assert.deepEqual(schemaExpectation, schema);

    const created = await client.createVersionedRecord("entries", { code: "REF-0002" }, { idempotencyKey: keyCreate });
    assert.deepEqual(created, { record: record(1), etag: "\"record-create-1\"" });

    const fetched = await client.getVersionedRecord("entries", recordId);
    assert.deepEqual(fetched, { record: record(2), etag: "\"record-get-2\"" });

    const replaced = await client.replaceVersionedRecord("entries", recordId, { code: "REF-0002", status: "closed" }, {
      ifMatch: fetched.etag, idempotencyKey: keyReplace,
    });
    assert.deepEqual(replaced, { record: record(3), etag: "\"record-replace-3\"" });

    const incremented = await client.incrementRecord("entries", recordId,
      [{ op: "increment", field: "quantity", by: -2, min: 0 }], { ifMatch: replaced.etag, idempotencyKey: keyIncrement });
    assert.deepEqual(incremented, { record: record(4), etag: "\"record-increment-4\"" });

    assert.equal(await client.deleteVersionedRecord("entries", recordId, replaced.etag), undefined);
    assert.deepEqual(await client.lockRecord("entries", recordId, { ttlSeconds: 60, idempotencyKey: keyLock }),
      { lockId, lockedUntil: "2030-01-10T09:05:00Z" });
    assert.equal(await client.releaseRecordLock("entries", recordId, lockId), undefined);

    const upserted = await client.upsertRecordByKey("entries", "REF-0002", { code: "REF-0002" }, { idempotencyKey: keyUpsert });
    assert.deepEqual(upserted, { record: record(1), etag: "\"record-upsert-1\"", created: true });

    assert.deepEqual(await client.writeRecordBatch([{ op: "create", collection: "entries", data: { code: "REF-0002" } }],
      { idempotencyKey: keyBatch }), { results: [{ op: "create", id: recordId, version: 1 }] });

    const page = await client.listFilteredRecords("entries", {
      limit: 2, sort: "status.asc", where: { status: "eq:\"open\"", code: "prefix:\"A-\"" }, ownerAppId,
    });
    assert.deepEqual(page, { items: [record(2)], nextCursor: "next-cursor" });

    assert.deepEqual(await client.aggregateRecords("entries", {
      where: { status: "eq:\"open\"" }, groupBy: ["status", "day(createdOn)"], ownerAppId,
    }), { count: 2, groups: [{ key: ["open", "2030-01-10"], count: 2 }] });

    const exported = await client.exportAppRecords({ collection: "entries" });
    assert.equal(exported.status, 200);
    assert.equal(exported.headers.get("content-type"), "application/x-ndjson");
    assert.equal(await exported.text(), "{\"collection\":\"entries\",\"id\":\"44444444-4444-4444-8444-444444444444\",\"data\":{}}\n");

    assert.deepEqual(await client.importAppRecords("{\"collection\":\"entries\",\"id\":\"44444444-4444-4444-8444-444444444444\",\"data\":{}}\n",
      { idempotencyKey: keyImport }), { created: 2 });

    const target = { resourceType: "record", resourceId: recordId, granteeAppGroup: "partners", action: "read", expiresAt: "2030-01-12T12:00:00Z" };
    assert.equal((await client.shareResourceWithAppOrGroup(target, keyShare)).shareId, lockId);

    const calls = (path, method) => api.filter(call => call.path === path && call.method === method);
    assert.deepEqual(calls("/v2/data-schemas/entries", "PUT")[0].body, JSON.stringify(schema));
    assert.equal(calls("/v2/data/entries", "POST")[0].headers["idempotency-key"], keyCreate);
    assert.equal(calls("/v2/data/entries", "POST")[0].headers["content-type"], "application/json");
    assert.equal(calls(`/v2/data/entries/${recordId}`, "PATCH")[0].headers["if-match"], "\"record-get-2\"");
    assert.equal(calls(`/v2/data/entries/${recordId}`, "PATCH")[1].headers["idempotency-key"], keyIncrement);
    assert.deepEqual(JSON.parse(calls(`/v2/data/entries/${recordId}`, "PATCH")[1].body), {
      operations: [{ op: "increment", field: "quantity", by: -2, min: 0 }],
    });
    assert.equal(calls(`/v2/data/entries/${recordId}`, "DELETE")[0].headers["if-match"], "\"record-replace-3\"");
    assert.equal(calls(`/v2/data/entries/${recordId}:lock`, "POST")[0].headers["idempotency-key"], keyLock);
    assert.deepEqual(JSON.parse(calls(`/v2/data/entries/${recordId}:lock`, "POST")[0].body), { ttlSeconds: 60 });
    assert.equal(calls(`/v2/data/entries/${recordId}:lock`, "DELETE")[0].headers["lock-id"], lockId);
    assert.equal(calls("/v2/data/entries/by-key/REF-0002", "PUT")[0].headers["idempotency-key"], keyUpsert);
    assert.equal(calls("/v2/data:batch", "POST")[0].headers["idempotency-key"], keyBatch);
    assert.equal(calls("/v2/data:import", "POST")[0].headers["content-type"], "application/x-ndjson");
    assert.equal(calls("/v2/data:import", "POST")[0].headers["idempotency-key"], keyImport);
    assert.equal(calls("/v2/resource-shares", "POST")[0].headers["idempotency-key"], keyShare);
    assert.deepEqual(JSON.parse(calls("/v2/resource-shares", "POST")[0].body), target);

    const list = calls("/v2/data/entries", "GET")[0].query;
    assert.deepEqual(list, [
      ["limit", "2"], ["sort", "status.asc"], ["where[status]", "eq:\"open\""], ["where[code]", "prefix:\"A-\""], ["ownerAppId", ownerAppId],
    ]);
    assert.deepEqual(calls("/v2/data/entries/aggregate", "GET")[0].query, [
      ["count", ""], ["groupBy", "status"], ["groupBy", "day(createdOn)"], ["where[status]", "eq:\"open\""], ["ownerAppId", ownerAppId],
    ]);
    assert.deepEqual(calls("/v2/data:export", "GET")[0].query, [["collection", "entries"]]);

    const before = api.length;
    await assert.rejects(client.replaceVersionedRecord("entries", recordId, {}, {}), TypeError);
    await assert.rejects(client.deleteVersionedRecord("entries", recordId, ""), TypeError);
    await assert.rejects(client.incrementRecord("entries", recordId, []), TypeError);
    await assert.rejects(client.lockRecord("entries", recordId, { ttlSeconds: 0 }), TypeError);
    await assert.rejects(client.aggregateRecords("entries", { count: false }), TypeError);
    assert.equal(api.length, before);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test("streamed imports use duplex half and legacy or exact-share bodies keep their actual shapes", async () => {
  const keyStream = "15151515-1515-4515-8515-151515151515";
  const keyExact = "16161616-1616-4616-8616-161616161616";
  let importBody = "";
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://gateway");
    if (url.pathname.endsWith("/protocol/openid-connect/token")) {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ access_token: "synthetic-token", token_type: "Bearer", expires_in: 300 }));
    }
    if (request.method === "POST" && url.pathname === "/v2/data:import") {
      importBody = await read(request);
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ created: 1 }));
    }
    if (request.method === "GET" && url.pathname === `/v2/data/entries/${recordId}`) {
      const { version, ...legacy } = record(2);
      response.writeHead(200, { "content-type": "application/json", etag: "\"record-get-2\"" });
      return response.end(JSON.stringify(legacy));
    }
    if (request.method === "GET" && url.pathname === "/v2/data/entries") {
      const { version, ...legacy } = record(2);
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ items: [legacy], nextCursor: null }));
    }
    if (request.method === "POST" && url.pathname === "/v2/resource-shares") {
      response.writeHead(201, { "content-type": "application/json" });
      return response.end(JSON.stringify({
        shareId: lockId, resourceType: "object", resourceId: recordId, granteeAppId: ownerAppId,
        action: "read", expiresAt: "2030-01-12T12:00:00Z",
      }));
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  });
  try {
    const baseUrl = await listen(server);
    const client = createJuncturaClient({ baseUrl, clientId: "synthetic-client", clientSecret: "synthetic-secret" });
    const text = `${JSON.stringify({ collection: "entries", id: recordId, data: { code: "A-1" } })}\n`;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
    assert.deepEqual(await client.importAppRecords(stream, { idempotencyKey: keyStream }), { created: 1 });
    assert.equal(importBody, text);

    const fetched = await client.getVersionedRecord("entries", recordId);
    assert.equal(Object.hasOwn(fetched.record, "version"), false);
    assert.equal(fetched.etag, "\"record-get-2\"");

    const page = await client.listFilteredRecords("entries");
    assert.equal(Object.hasOwn(page.items[0], "version"), false);
    assert.equal(page.nextCursor, null);

    const exact = await client.shareResourceWithAppOrGroup({
      resourceType: "object", resourceId: recordId, granteeAppId: ownerAppId, action: "read", expiresAt: "2030-01-12T12:00:00Z",
    }, keyExact);
    assert.equal(exact.granteeAppId, ownerAppId);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
