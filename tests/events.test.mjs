// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createEventStreams } from "../src/modules/events/events.mjs";

const config = { dataUrl: "http://data.invalid", dataSecret: "z".repeat(32) };
const url = new URL("http://core/v1/events");
const reader = () => ({ tenantId: "tenant-a", issuer: "https://identity.invalid", subject: "reader", clientId: "console",
  credentialExpiresAt: Date.now() + 5000, groups: [] });
const committed = "11111111-1111-4111-8111-111111111111";

class TestResponse extends EventEmitter {
  frames = [];
  writeHead(status, headers) {
    this.headersSent = true;
    this.status = status;
    this.headers = headers;
  }
  write(frame) {
    this.frames.push(frame);
    return this.onWrite?.(frame) ?? true;
  }
  end() { this.ended = true; }
  destroy() { this.destroyed = true; this.emit("close"); }
}

function database(t, responder) {
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const request = JSON.parse(init.body);
    const claims = JSON.parse(Buffer.from(init.headers.Authorization.split(".")[1], "base64url"));
    assert.equal(url, "http://data.invalid/rpc/event_stream_command");
    assert.equal(claims.role, "junctura_event_api");
    const value = await responder(request.operation, request.payload, claims);
    return Response.json({ status: 200, value });
  });
}

test("SSE opens at the tenant watermark, reauthorizes each event and frames only approved references", async t => {
  let polls = 0;
  let rechecks = 0;
  database(t, (operation, payload, claims) => {
    if (operation === "start") return { sequence: "8", startedAt: new Date().toISOString() };
    if (operation === "poll") {
      assert.equal(payload.after, polls++ === 0 ? "8" : "10");
      return polls === 1 ? { overflow: false, items: [
        { sequence: "9", event: "record.status.changed" }, { sequence: "10", event: "consent.revoked" },
      ] } : { overflow: true, items: [] };
    }
    assert.equal(operation, "deliver");
    return claims.groups.includes("/unit/group") ? { consentId: committed } : null;
  });
  const runtime = createEventStreams(config);
  const response = new TestResponse();
  const principal = reader();
  await runtime.handle({ method: "GET", headers: { "last-event-id": "3" } }, response, principal, () =>
    ({ ...principal, groups: ++rechecks === 2 ? ["/unit/group"] : [] }), url);
  assert.equal(rechecks, 2);
  assert.equal(response.status, 200);
  assert.equal(response.headers["X-Accel-Buffering"], "no");
  assert.deepEqual(response.frames, [": connected\n\n", `event: consent.revoked\ndata: {"consentId":"${committed}"}\n\n`]);
  assert.equal(response.ended, true);
  assert.equal(response.listenerCount("close"), 0);
});

test("SSE disconnects a slow writer and releases its slot without buffering events", async t => {
  let started = 0;
  database(t, operation => {
    assert.equal(operation, "start");
    started++;
    return { sequence: "0", startedAt: new Date().toISOString() };
  });
  const runtime = createEventStreams(config);
  for (let count = 0; count < 10; count++) {
    const response = new TestResponse();
    response.onWrite = () => false;
    const identity = reader();
    await runtime.handle({ method: "GET" }, response, identity, () => identity, url);
    assert.equal(response.destroyed, true);
    assert.deepEqual(response.frames, [": connected\n\n"]);
    assert.equal(response.listenerCount("close"), 0);
  }
  assert.equal(started, 10);
});

test("SSE closes at credential expiry while the journal is quiet", async t => {
  database(t, operation => operation === "start" ? { sequence: "0", startedAt: new Date().toISOString() } :
    { overflow: false, items: [] });
  const response = new TestResponse();
  const identity = { ...reader(), credentialExpiresAt: Date.now() + 100 };
  await createEventStreams(config).handle({ method: "GET" }, response, identity, () => identity, url);
  assert.equal(response.destroyed, true);
  assert.deepEqual(response.frames, [": connected\n\n"]);
});

test("a delayed task observation cannot replay a task from before the stream", async t => {
  const startedAt = Date.now() - 200;
  const task = (id, time) => ({ taskId: id, executionId: "execution", definitionId: "review:1:1",
    stepKey: "review", createdAt: new Date(time).toISOString() });
  const old = task("old", startedAt - 1);
  const removed = task("removed", startedAt + 1);
  const live = task("live", startedAt + 2);
  const checked = [];
  const delivered = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(input);
    if (url.hostname === "workflow.invalid") {
      if (url.pathname === "/runtime/tasks") return Response.json({ data: [], total: 0 });
      const id = url.pathname.split("/").at(-1);
      checked.push(id);
      if (id === "removed") return new Response(null, { status: 404 });
      return Response.json({ id, tenantId: "tenant-a", processInstanceId: live.executionId,
        processDefinitionId: live.definitionId, taskDefinitionKey: live.stepKey, createTime: live.createdAt });
    }
    const { operation, payload } = JSON.parse(init.body);
    if (operation === "start") return Response.json({ status: 200, value: { sequence: "0", startedAt: new Date(startedAt).toISOString() } });
    if (operation === "poll") return Response.json({ status: 200, value: { overflow: false,
      items: [old, removed, live].map((task, index) => ({ task, event: "workflow.task.created", sequence: String(index + 1) })) } });
    delivered.push(payload.sequence);
    return Response.json({ status: 200, value: { taskId: live.taskId, executionId: live.executionId } });
  });
  const response = new TestResponse();
  response.onWrite = frame => frame.startsWith(":");
  const identity = reader();
  await createEventStreams({ ...config, workflowUrl: "http://workflow.invalid", workflowPassword: "unused" })
    .handle({ method: "GET" }, response, identity, () => identity, url);
  assert.deepEqual(checked, ["removed", "live"]);
  assert.deepEqual(delivered, ["3"]);
  assert.equal(response.frames[1], 'event: workflow.task.created\ndata: {"taskId":"live","executionId":"execution"}\n\n');
});

test("an idle event stream reauthorizes and sends a comment heartbeat", async t => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  database(t, operation => {
    if (operation === "start") return { sequence: "0", startedAt: new Date(now).toISOString() };
    now += 10000;
    return { overflow: false, items: [] };
  });
  const response = new TestResponse();
  response.onWrite = frame => frame !== ": heartbeat\n\n";
  const identity = { ...reader(), credentialExpiresAt: now + 30000 };
  let rechecks = 0;
  await createEventStreams(config).handle({ method: "GET" }, response, identity, () => {
    rechecks++;
    return identity;
  }, url);
  assert.equal(rechecks, 1);
  assert.deepEqual(response.frames, [": connected\n\n", ": heartbeat\n\n"]);
});
