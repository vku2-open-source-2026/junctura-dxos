// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { test } from "node:test";
import { handleShares, validateShare } from "../src/modules/resources/resources.mjs";

const id = "11111111-1111-4111-8111-111111111111";
const appId = "33333333-3333-4333-8333-333333333333";
const key = "14141414-1414-4414-8414-141414141414";
const group = "partners";
const target = { resourceType: "record", resourceId: id, granteeAppGroup: group, action: "read", expiresAt: "2030-01-12T12:00:00Z" };

function fakeResponse() {
  const headers = {};
  let body = "";
  return {
    headersSent: false,
    status: 0,
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    writeHead(status, extra = {}) {
      this.status = status;
      this.headersSent = true;
      Object.assign(headers, extra);
    },
    end(chunk) { if (chunk !== undefined) body += chunk; },
    json() { return JSON.parse(body); },
  };
}

const listen = server => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
});

test("share validation accepts one grantee form and rejects mixed or group-object targets", () => {
  assert.deepEqual(validateShare(target), target);
  for (const patch of [
    { granteeAppId: appId },
    { resourceType: "object" },
    { expiresAt: "2030-01-12T12:00:00.1234Z" },
    { expiresAt: "2030-01-12T12:00:00+00:00" },
  ]) assert.throws(() => validateShare({ ...target, ...patch }), error => error.status === 400);
});

test("an idempotency replay with a changed body is a 422 that carries requestId", async () => {
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: 422, error: "idempotency_key_reused" }));
  });
  try {
    const dataUrl = await listen(server);
    const request = Readable.from([Buffer.from(JSON.stringify(target))]);
    request.method = "POST";
    request.url = "/v2/resource-shares";
    request.headers = { "content-type": "application/json", "idempotency-key": key };
    const response = fakeResponse();
    const identity = { tenantId: "tenant-a", issuer: "https://issuer.example.invalid", subject: "subject",
      clientId: "backend", roles: ["core-reader", "core-writer"], appId };
    await handleShares(request, response, identity, { dataUrl, dataSecret: "synthetic-test-key" },
      new URL("http://core/v2/resource-shares"));
    assert.equal(response.status, 422);
    const body = response.json();
    assert.equal(body.error, "idempotency_key_reused");
    assert.match(body.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test("group-share SQL pins pg_temp last in search_path", () => {
  const sql = readFileSync(new URL("../infra/postgres/035-app-group-shares.sql", import.meta.url), "utf8");
  const paths = sql.match(/SET search_path = [^\n]+/g);
  assert.ok(paths.length > 0 && paths.every(line => line.includes("pg_temp")));
});
