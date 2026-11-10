// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { handleAudit, handleAuditEvents } from "../src/modules/audit/audit.mjs";
import { HttpError, json } from "../src/platform/http/http.mjs";

const identity = { tenantId: "tenant-a", subject: "auditor", issuer: "https://identity.example.invalid", clientId: "management", roles: ["core-reader"] };
let reply = { status: 200, value: { verified: true, entries: 3, newlySealed: 1, headHash: `sha256:${"a".repeat(64)}`, firstBreak: null, verifiedAt: "2026-11-04T00:00:00.000Z" } };
let seen = [];
let data, core, base;
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));

before(async () => {
  data = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    seen.push({ url: request.url, authorization: request.headers.authorization, body: Buffer.concat(chunks).toString() });
    if (reply === "down") { response.writeHead(503); return response.end(); }
    response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(reply));
  });
  const dataUrl = await listen(data);
  core = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://core");
      const handler = url.pathname === "/v1/audit-events" ? handleAuditEvents : handleAudit;
      await handler(request, response, identity, { dataUrl, dataSecret: "x".repeat(32) }, url);
    }
    catch (error) { json(response, error instanceof HttpError ? error.status : 500, { error: error.message }); }
  });
  base = await listen(core);
});
after(() => { data.close(); core.close(); });

const verify = (options = {}) => fetch(`${base}${options.path ?? "/v1/audit-events/verify"}`, {
  method: options.method ?? "POST", headers: { "Content-Type": "application/json" }, body: options.body ?? "{}" });

test("verification asserts only the private audit role and returns the database result", async () => {
  seen = [];
  const response = await verify();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), reply.value);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "/rpc/audit_verify");
  assert.deepEqual(JSON.parse(seen[0].body), { payload: {} });
  const claims = JSON.parse(Buffer.from(seen[0].authorization.split(".")[1], "base64url"));
  assert.equal(claims.role, "junctura_audit_api");
  assert.deepEqual([claims.tenant_id, claims.sub, claims.client_id], ["tenant-a", "auditor", "management"]);
});

test("a broken chain is reported, not hidden", async () => {
  reply = { status: 200, value: { verified: false, entries: 1, newlySealed: 0, headHash: null, firstBreak: { chainSeq: 2, eventId: "11111111-1111-4111-8111-111111111111", reason: "content_modified" }, verifiedAt: "2026-11-04T00:00:00.000Z" } };
  const response = await verify();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).firstBreak.reason, "content_modified");
});

test("authority errors, bad input and outages fail closed", async () => {
  reply = { status: 403, error: "audit_permission_required" };
  assert.equal((await verify()).status, 403);
  assert.equal((await verify({ body: '{"seal":1}' })).status, 400);
  assert.equal((await verify({ path: "/v1/audit-events/verify?x=1" })).status, 400);
  assert.equal((await verify({ method: "PUT" })).status, 405);
  reply = "down";
  assert.equal((await verify()).status, 503);
  reply = { status: 200, value: {} };
  assert.equal((await verify()).status, 503, "malformed database answer is not reported as verified");
});

const events = path => fetch(`${base}/v1/audit-events${path}`);

test("listing asks the private audit role for one tenant page and returns it unchanged", async () => {
  const page = { items: [{ eventId: "11111111-1111-4111-8111-111111111111", occurredAt: "2026-11-04T00:00:00Z", event: "application.approved", outcome: "success" }], nextCursor: null };
  reply = { status: 200, value: page };
  seen = [];
  const response = await events("?since=2026-11-04T00:00:00Z&limit=20");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), page);
  assert.equal(seen[0].url, "/rpc/audit_query");
  assert.deepEqual(JSON.parse(seen[0].body), { payload: { since: "2026-11-04T00:00:00Z", limit: 20 } });
  const claims = JSON.parse(Buffer.from(seen[0].authorization.split(".")[1], "base64url"));
  assert.equal(claims.role, "junctura_audit_api");
  assert.deepEqual([claims.tenant_id, claims.sub, claims.client_id], ["tenant-a", "auditor", "management"]);
});

test("listing rejects unknown, repeated or malformed query parameters before the database", async () => {
  seen = [];
  for (const bad of ["?tenant=other", "?limit=5&limit=6", "?limit=abc", "?limit=1000", "?since="]) {
    assert.equal((await events(bad)).status, 400, bad);
  }
  assert.equal((await fetch(`${base}/v1/audit-events`, { method: "POST", body: "{}" })).status, 405);
  assert.equal(seen.length, 0);
});

test("listing passes database authority errors through and fails closed on outages", async () => {
  reply = { status: 403, error: "audit_permission_required" };
  assert.equal((await events("")).status, 403);
  reply = { status: 400, error: "invalid_audit_time_range" };
  assert.equal((await events("?since=b&until=a")).status, 400);
  reply = "down";
  assert.equal((await events("")).status, 503);
  reply = { status: 200, value: { nextCursor: null } };
  assert.equal((await events("")).status, 503, "malformed database answer is not reported as a page");
});
