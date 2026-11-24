// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { createJuncturaClient } from "../sdk/node/index.mjs";
import { handleCapabilities } from "../src/modules/capability/registry/capabilities.mjs";
import { ACCESS_REQUESTS_PATH, handleCapabilityAccessRequests } from "../src/modules/capability/trust/access-requests.mjs";

const id = "11111111-1111-4111-8111-111111111111";
const body = { capabilityId: `urn:junctura:capability:${id}:echo`, version: "1.0.0", purpose: "Verify interoperability." };
const identity = { tenantId: "tenant-a", issuer: "https://identity.example.invalid", subject: "subject",
  clientId: "client", roles: ["core-reader", "core-writer"], units: ["unit-a"] };
const config = { dataUrl: "http://data", dataSecret: "unit-test-signing-value" };

function call(path, { method = "GET", json, key = id, caller = identity, handler = handleCapabilityAccessRequests } = {}) {
  const bytes = json === undefined ? "" : typeof json === "string" ? json : JSON.stringify(json);
  const request = Object.assign(Readable.from(bytes ? [Buffer.from(bytes)] : []), {
    method, headers: { "idempotency-key": key, ...(bytes && { "content-length": String(Buffer.byteLength(bytes)),
      "content-type": "application/json" }) },
  });
  const response = { headers: {}, setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); },
    end(value) { this.value = JSON.parse(value); },
  };
  return handler(request, response, caller, config, new URL(path, "http://core")).then(() => response);
}

test("access requests validate purpose, exact references, idempotency and caller", async () => {
  const create = (json, options) => call(ACCESS_REQUESTS_PATH, { method: "POST", json, ...options });
  for (const patch of [{ version: "1.01.0" }, { capabilityId: "echo" }, { purpose: "" }, { purpose: " \n" },
    { purpose: "a".repeat(513) }, { purpose: "\ud800" }, { consumerAppId: id }]) {
    await assert.rejects(create({ ...body, ...patch }), { status: 400 });
  }
  await assert.rejects(create(body, { key: "not-a-uuid" }), { status: 400, message: "uuid_idempotency_key_required" });
  await assert.rejects(create(body, { caller: { ...identity, roles: ["core-reader"] } }), { status: 403, message: "write_forbidden" });
  await assert.rejects(create(body, { caller: { ...identity, actor: { sub: "backend" } } }), { status: 403 });
  await assert.rejects(call(`${ACCESS_REQUESTS_PATH}/${id}/decline`, { method: "POST", json: {} }), { status: 400 });
  await assert.rejects(call(`${ACCESS_REQUESTS_PATH}/${id}/accept`, { method: "POST", json: { grantId: id } }), { status: 400 });
});

test("handlers dispatch catalog and filtered trust requests to their RPCs", async t => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, value: JSON.parse(init.body) });
    const value = JSON.parse(init.body);
    return Response.json(value.operation === "create" ? { status: 200, value: { requestId: id } }
      : { status: 200, value: { items: [], nextCursor: null } });
  });
  const replay = await call(ACCESS_REQUESTS_PATH, { method: "POST", json: body });
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.Location, `${ACCESS_REQUESTS_PATH}/${id}`);
  const listed = await call(`${ACCESS_REQUESTS_PATH}?direction=incoming&state=accepted&limit=3&cursor=AB`);
  assert.equal(listed.status, 200);
  const catalog = await call("/v1/capabilities/catalog?limit=2", { handler: handleCapabilities });
  assert.equal(catalog.status, 200);
  assert.deepEqual(calls, [
    { url: "http://data/rpc/capability_access_request_command", value: { operation: "create", payload: { ...body, idempotencyKey: id } } },
    { url: "http://data/rpc/capability_access_request_command", value: { operation: "list",
      payload: { direction: "incoming", state: "accepted", limit: 3, cursor: "ab" } } },
    { url: "http://data/rpc/capability_catalog", value: { payload: { limit: 2 } } },
  ]);
  for (const query of ["direction=both", "state=active", "limit=0", "state=pending&state=declined", "consumerAppId=x"]) {
    await assert.rejects(call(`${ACCESS_REQUESTS_PATH}?${query}`), { status: 400, message: "invalid_access_request_query" });
  }
  await assert.rejects(call(`${ACCESS_REQUESTS_PATH}?cursor=xyz`), { status: 400, message: "invalid_access_request_cursor" });
});

test("SDK sends consumer writes and provider decisions with the expected credentials and bodies", async () => {
  const calls = [];
  const sdk = createJuncturaClient({ baseUrl: "https://gateway.example.invalid", clientId: "app", clientSecret: "unit-test-value",
    async fetcher(url, init) {
      if (url.pathname.endsWith("/token")) return Response.json({ access_token: "application", token_type: "Bearer", expires_in: 60 });
      calls.push({ path: url.pathname + url.search, method: init.method, bearer: init.headers.get("authorization"),
        key: init.headers.get("idempotency-key"), body: init.body === undefined ? undefined : JSON.parse(init.body) });
      return Response.json({});
    } });
  await sdk.listCapabilityCatalog({ limit: 2, cursor: "ab" });
  await sdk.createCapabilityAccessRequest(body, id);
  await sdk.listCapabilityAccessRequests({ direction: "incoming", state: "pending", userToken: "owner" });
  await sdk.getCapabilityAccessRequest(id);
  await sdk.withdrawCapabilityAccessRequest(id);
  await sdk.declineCapabilityAccessRequest(id, "Request declined.", { userToken: "owner" });
  await sdk.acceptCapabilityAccessRequest(id, { userToken: "owner" });
  assert.deepEqual(calls.map(({ path, method, bearer }) => [path, method, bearer]), [
    ["/v1/capabilities/catalog?limit=2&cursor=ab", "GET", "Bearer application"],
    [ACCESS_REQUESTS_PATH, "POST", "Bearer application"],
    [`${ACCESS_REQUESTS_PATH}?direction=incoming&state=pending`, "GET", "Bearer owner"],
    [`${ACCESS_REQUESTS_PATH}/${id}`, "GET", "Bearer application"],
    [`${ACCESS_REQUESTS_PATH}/${id}/withdraw`, "POST", "Bearer application"],
    [`${ACCESS_REQUESTS_PATH}/${id}/decline`, "POST", "Bearer owner"],
    [`${ACCESS_REQUESTS_PATH}/${id}/accept`, "POST", "Bearer owner"],
  ]);
  assert.equal(calls[1].key, id);
  assert.deepEqual(calls[1].body, body);
  assert.deepEqual(calls[5].body, { reason: "Request declined." });
  assert.equal(calls[6].body, undefined);
});
