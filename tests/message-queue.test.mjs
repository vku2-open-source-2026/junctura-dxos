// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { handleQueues } from "../src/modules/queues/queues.mjs";

const identity = { tenantId: "tenant-a", issuer: "https://identity.invalid", clientId: "queue-test",
  subject: "service-account", roles: ["core-reader", "core-writer"] };
const config = { dataUrl: "http://data.invalid", dataSecret: "z".repeat(32) };
const id = "11111111-1111-4111-8111-111111111111";
const queue = "/v1/queues/jobs";

async function command(path, body, { method = "POST", key = id, caller = identity } = {}) {
  const request = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    method, headers: { "content-type": "application/json", "idempotency-key": key },
  });
  const headers = {};
  const response = {
    setHeader(name, value) { headers[name] = value; },
    writeHead(status, values) { this.status = status; Object.assign(headers, values); },
    end(value) { this.value = value === undefined ? undefined : JSON.parse(value); },
  };
  await handleQueues(request, response, caller, config, new URL(path, "http://core"));
  return { status: response.status, value: response.value, headers };
}

test("enqueue preserves a UTF-8 JSON payload at the byte limit and sends trusted caller claims", async t => {
  const payload = "é".repeat(32767);
  const rpc = t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "http://data.invalid/rpc/queue_command");
    const claims = JSON.parse(Buffer.from(init.headers.Authorization.split(".")[1], "base64url"));
    assert.equal(claims.role, "junctura_queue_api");
    assert.equal(claims.tenant_id, identity.tenantId);
    assert.equal(claims.sub, identity.subject);
    assert.equal(claims.trust_writer, true);
    const input = JSON.parse(init.body);
    assert.equal(input.operation, "send");
    assert.equal(input.queue_name, "jobs");
    assert.equal(input.payload.key, id);
    assert.equal(input.payload.delaySeconds, 0);
    assert.equal(Buffer.byteLength(input.payload.payloadJson), 65536);
    assert.equal(JSON.parse(input.payload.payloadJson), payload);
    return Response.json({ status: 201, value: { messageId: id } });
  });
  const result = await command(`${queue}/messages`, { payload });
  assert.equal(result.status, 201);
  assert.deepEqual(result.value, { messageId: id });
  await assert.rejects(command(`${queue}/messages`, { payload: `${payload}é` }), { status: 413, message: "body_too_large" });
  assert.equal(rpc.mock.callCount(), 1);
});

test("queue routes reject invalid policies, timing, ids and request shapes before the RPC", async t => {
  const rpc = t.mock.method(globalThis, "fetch", () => assert.fail("unexpected queue RPC"));
  for (const [path, body, options] of [
    [`${queue}/messages`, {}],
    [`${queue}/messages`, { payload: null }, { key: "invalid" }],
    [`${queue}/messages`, { payload: null, delaySeconds: -1 }],
    [`${queue}/lease`, { visibilityTimeoutSeconds: 3601 }],
    [`${queue}/messages/not-a-uuid/ack`, { leaseToken: id }],
    [`${queue}/messages/${id}/nack`, { leaseToken: id, payload: "unexpected" }],
    [`${queue}/dead-letters?limit=1&limit=2`, undefined, { method: "GET" }],
    [`${queue}/dead-letters/${id}/replay`, { leaseToken: id }],
    [queue, { consumerAppIds: [id, id] }, { method: "PUT" }],
    [queue, { producerAppIds: [null] }, { method: "PUT" }],
  ]) await assert.rejects(command(path, body, options), { status: 400 });
  await assert.rejects(command(`${queue}/lease`, undefined, { method: "GET" }), { status: 405 });
  assert.equal(rpc.mock.callCount(), 0);
});

test("queue RPC receives delegated actor context for denial and maps stale lease conflicts", async t => {
  const caller = { ...identity, actor: { sub: "delegating-service" } };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const claims = JSON.parse(Buffer.from(init.headers.Authorization.split(".")[1], "base64url"));
    if (claims.actor_sub) {
      assert.equal(claims.actor_sub, caller.actor.sub);
      assert.equal(claims.trust_writer, false);
      return Response.json({ status: 403, error: "queue_forbidden" });
    }
    return Response.json({ status: 409, error: "queue_lease_lost" });
  });
  await assert.rejects(command(`${queue}/lease`, {}, { caller }), { status: 403, message: "queue_forbidden" });
  await assert.rejects(command(`${queue}/messages/${id}/ack`, { leaseToken: id }), { status: 409, message: "queue_lease_lost" });
});
