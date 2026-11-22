// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { handleIdentity } from "../src/modules/identity/identity.mjs";
import { HttpError, json } from "../src/platform/http/http.mjs";

const identity = {
  tenantId: "tenant-a", subject: "login-1", issuer: "https://identity.example.invalid",
  clientId: "junctura-console", roles: ["core-reader", "regulator"], units: ["unit-a"], groups: ["/unit-a/reviewers"],
};
let subjectId;
let reply;
let seen;
let data, core, base;
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
before(async () => {
  data = createServer(async (request, response) => {
    const claims = JSON.parse(Buffer.from(request.headers.authorization.split(".")[1], "base64url"));
    seen.push({ url: request.url, role: claims.role, sub: claims.sub, subjectId: claims.subject_id });
    if (reply === "down") { response.writeHead(503); return response.end(); }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(reply ?? { status: 200, value: { subjectId: "person-1" } }));
  });
  const dataUrl = await listen(data);
  core = createServer(async (request, response) => {
    try {
      await handleIdentity(request, response,
        { ...identity, ...(subjectId ? { subjectId } : {}) },
        { dataUrl, dataSecret: "x".repeat(32) }, new URL(request.url, "http://core"));
    } catch (error) {
      json(response, error instanceof HttpError ? error.status : 500, { error: error.message });
    }
  });
  base = await listen(core);
});
after(() => { data.close(); core.close(); });
const get = (suffix = "") => fetch(`${base}/v1/identity${suffix}`);

test("identity reports the verified organization context with empty defaults", async () => {
  seen = []; subjectId = undefined; reply = undefined;
  const response = await get();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { subject: "login-1", tenantId: "tenant-a", roles: ["core-reader"],
    units: ["unit-a"], groups: ["/unit-a/reviewers"] });
  assert.deepEqual(seen, [], "no binding lookup without a subjectId claim");
});

test("subjectId appears only through the operator binding of this login subject", async () => {
  subjectId = "person-1";
  seen = []; reply = { status: 200, value: { subjectId: "person-1" } };
  const bound = await get();
  assert.deepEqual(await bound.json(), { subject: "login-1", tenantId: "tenant-a", roles: ["core-reader"],
    units: ["unit-a"], groups: ["/unit-a/reviewers"], subjectId: "person-1" });
  assert.deepEqual(seen[0], { url: "/rpc/subject_binding", role: "junctura_subject_api",
    sub: "login-1", subjectId: "person-1" });

  seen = []; reply = { status: 403, error: "verified_subject_required" };
  assert.ok(!Object.hasOwn(await (await get()).json(), "subjectId"), "an unbound or competing binding stays hidden");

  seen = []; reply = { status: 200, value: { subjectId: "someone-else" } };
  assert.equal((await (await get()).json()).subjectId, undefined, "a different bound subject is refused");

  seen = []; reply = "down";
  assert.equal((await (await get()).json()).subjectId, undefined, "an outage degrades to the token-only identity");
});

test("identity answers only clean GET requests", async () => {
  subjectId = undefined; reply = undefined;
  assert.equal((await get("?tenant=tenant-b")).status, 400);
  const post = await fetch(`${base}/v1/identity`, { method: "POST" });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET");
});
