// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Replays the exact registered-backend requests from integration/applications.mjs
// against the Node layer: a plain octet-stream upload and a simple record create
// without an Idempotency-Key must both stay 201 (contract compatibility).
import assert from "node:assert/strict";
import net from "node:net";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { handleObjects } from "../src/modules/objects/objects.mjs";
import { boundaryOf, parseMultipart } from "../src/modules/objects/multipart.mjs";
import { handleAppRecords, presentRecordRequest } from "../src/modules/data/data.mjs";
import { json } from "../src/platform/http/http.mjs";

const appId = "22222222-2222-4222-8222-222222222222";
const identity = { tenantId: "tenant-a", issuer: "https://issuer.test", subject: "backend",
  clientId: "app-client", roles: ["core-reader", "core-writer"], appId };
const listen = server => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
});

let data, core, filer, clamd, dataUrl, coreUrl, config, commands, published, committed;

before(async () => {
  // The private authority store: object lifecycle commands and record commands.
  committed = new Map();
  data = createServer(async (request, response) => {
    try {
      const body = JSON.parse(await new Promise((resolve, reject) => {
        const chunks = [];
        request.on("data", chunk => chunks.push(chunk));
        request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        request.on("error", reject);
      }));
      commands.push(body);
      const { operation, payload } = body;
      if (operation === "context") return json(response, 200, { status: 200, value: { appId } });
      if (operation === "object_get") {
        return json(response, 200, { status: 200, value: { ownerAppId: appId, version: committed.get(payload.id) } });
      }
      if (operation === "replay") {
        assert.ok(/^[0-9a-f-]{36}$/.test(payload.key ?? ""), "replay always carries its key");
        return json(response, 200, { status: 200, value: null });
      }
      if (operation === "prepare") {
        return json(response, 200, { status: 200, value: { ownerAppId: appId, version: null,
          size: null, tags: [], recordRef: null } });
      }
      if (operation === "stage") {
        return json(response, 200, { status: 200, value: { id: payload.id, version: payload.version } });
      }
      if (operation === "commit") {
        if (payload.key === undefined) {
          assert.equal(payload.digest, undefined, "a keyless commit records no receipt");
        } else {
          assert.match(payload.digest, /^[0-9a-f]{64}$/);
        }
        committed.set(payload.id, payload.version);
        return json(response, 200, { status: 201, value: { id: payload.id, size: payload.size,
          tags: [], recordRef: null } });
      }
      if (operation === "create") {
        assert.equal(payload.collection, "private_fixture");
        assert.deepEqual(payload.body, { data: { fixture: "app-client" } });
        const value = { id: "33333333-3333-4333-8333-333333333333", collection: payload.collection,
          data: payload.body.data, created_at: "2026-11-23T00:00:00+00:00", version: 1 };
        if (payload.legacyBody) delete value.version;
        return json(response, 200, { status: 201, value,
          headers: { ETag: `"record-${"a".repeat(64)}-1"` } });
      }
      return json(response, 200, { status: 400, error: "invalid_operation" });
    } catch (error) {
      json(response, 500, { error: error.message });
    }
  });
  dataUrl = await listen(data);
  // The Filer stores quarantine and published versions and serves them back.
  published = [];
  const stored = new Map();
  filer = createServer((request, response) => {
    // /junctura-quarantine/{tenant}/{id}/{scope} or /junctura-app/{tenant}/{app}/{id}/{version}
    const segments = request.url.split("/").filter(Boolean);
    let chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      published.push({ method: request.method, path: request.url });
      if (request.method === "POST") {
        const body = Buffer.concat(chunks);
        // SeaweedFS accepts the multipart envelope and serves the file bytes.
        const type = request.headers["content-type"] ?? "";
        const parsed = type.startsWith("multipart/form-data")
          ? parseMultipart(body, boundaryOf(type)).find(part => part.name === "file").value : body;
        stored.set(request.url, parsed);
      } else if (request.method === "DELETE") stored.delete(request.url);
      if (request.method === "GET") {
        const bytes = stored.get(request.url);
        response.writeHead(bytes === undefined ? 404 : 200,
          { "Content-Type": "application/octet-stream", "Content-Length": bytes?.length ?? 0 });
        return response.end(bytes);
      }
      json(response, 200, { accepted: true });
    });
  });
  // A minimal clamd INSTREAM responder: clean verdict for every scan.
  clamd = net.createServer(socket => {
    let buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      // zINSTREAM framing: 4-byte big-endian chunk length, zero length ends the stream.
      if (!buffer.subarray(10).includes(Buffer.alloc(4))) return;
      socket.write("stream: OK\0");
      socket.end();
    });
  });
  config = { dataUrl, dataSecret: "synthetic-data-secret", objectsUrl: await listen(filer),
    clamavHost: "127.0.0.1", clamavPort: await new Promise(resolve => clamd.listen(0, "127.0.0.1", () => resolve(clamd.address().port))) };
  core = createServer(async (request, response) => {
    const url = new URL(request.url, "http://core");
    if (url.pathname.startsWith("/v2/objects")) {
      try { return await handleObjects(request, response, identity, config, url); }
      catch (error) { return json(response, error.status ?? 503, { error: error.message }); }
    }
    return presentRecordRequest(request, response, () =>
      handleAppRecords(request, response, identity, config, url), true);
  });
  coreUrl = await listen(core);
});
after(() => {
  for (const server of [core, data, filer]) { server?.close(); server?.closeAllConnections(); }
  clamd?.close();
});

test("a registered backend uploads plain octet-stream bytes without metadata or key and gets 201", async () => {
  commands = []; published = [];
  const bytes = Buffer.from("private resource fixture");
  const response = await fetch(`${coreUrl}/v2/objects`, { method: "POST",
    headers: { Authorization: "Bearer synthetic", "Content-Type": "application/octet-stream" }, body: bytes });
  const body = await response.text();
  assert.equal(response.status, 201, body);
  const object = JSON.parse(body);
  assert.match(object.id, /^[0-9a-f-]{36}$/);
  assert.equal(object.size, bytes.length);
  assert.deepEqual(object, { id: object.id, size: bytes.length, tags: [], recordRef: null });
  // The exact wire shape the SQL contract expects from a keyless upload.
  assert.deepEqual(commands.map(command => command.operation), ["prepare", "stage", "commit"]);
  assert.equal(commands.at(-1).payload.key, undefined);
  // The best-effort quarantine cleanup runs after the response; wait for it.
  const deadline = Date.now() + 5000;
  while (!published.some(call => call.method === "DELETE") && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.deepEqual(published.map(call => [call.method, call.path.split("/").at(1)]),
    [["POST", "junctura-quarantine"], ["POST", "junctura-app"], ["DELETE", "junctura-quarantine"]]);
  // Download still serves the committed bytes.
  const download = await fetch(`${coreUrl}/v2/objects/${object.id}`, { headers: { Authorization: "Bearer synthetic" } });
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
});

test("a registered backend PUTs octet-stream bytes under its own UUID without a key and gets 201", async () => {
  commands = []; published = [];
  const id = "44444444-4444-4444-8444-444444444444";
  const response = await fetch(`${coreUrl}/v2/objects/${id}`, { method: "PUT",
    headers: { Authorization: "Bearer synthetic", "Content-Type": "application/octet-stream" },
    body: Buffer.from("foreign bytes") });
  const body = await response.text();
  assert.equal(response.status, 201, body);
  assert.equal(JSON.parse(body).id, id);
  assert.equal(commands.at(-1).payload.key, undefined);
});

test("a supplied Idempotency-Key still replays and a malformed one still fails", async () => {
  commands = [];
  const bytes = Buffer.from("keyed upload");
  const keyed = await fetch(`${coreUrl}/v2/objects`, { method: "POST",
    headers: { Authorization: "Bearer synthetic", "Content-Type": "application/octet-stream",
      "Idempotency-Key": "11111111-1111-4111-8111-111111111111" }, body: bytes });
  assert.equal(keyed.status, 201);
  assert.deepEqual(commands.map(command => command.operation), ["replay", "prepare", "stage", "commit"]);
  assert.equal(commands.at(-1).payload.key, "11111111-1111-4111-8111-111111111111");
  const malformed = await fetch(`${coreUrl}/v2/objects`, { method: "POST",
    headers: { Authorization: "Bearer synthetic", "Content-Type": "application/octet-stream",
      "Idempotency-Key": "not-a-uuid" }, body: bytes });
  assert.equal(malformed.status, 400);
  assert.deepEqual((await malformed.json()).error, "invalid_request");
});

test("a registered backend creates a simple record without an Idempotency-Key and gets 201", async () => {
  commands = [];
  const response = await fetch(`${coreUrl}/v2/data/private_fixture`, { method: "POST",
    headers: { Authorization: "Bearer synthetic", "Content-Type": "application/json" },
    body: JSON.stringify({ data: { fixture: "app-client" } }) });
  const body = await response.text();
  assert.equal(response.status, 201, body);
  const record = JSON.parse(body);
  assert.match(record.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(record.data, { fixture: "app-client" });
  assert.equal(commands.at(-1).operation, "create");
  assert.equal(commands.at(-1).payload.requestKey, undefined);
  assert.equal(commands.at(-1).payload.legacyBody, true);
});
