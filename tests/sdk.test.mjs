// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { createJuncturaClient, inputDigest, JuncturaError } from "../sdk/node/index.mjs";
import { canonicalize } from "../src/modules/capability/registry/manifest.mjs";
import { createHash } from "node:crypto";

const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers });
const auth = () => json({ access_token: "synthetic-token", token_type: "Bearer", expires_in: 300 });
const options = { baseUrl: "http://127.0.0.1:8080", clientId: "synthetic-client", clientSecret: "synthetic-secret" };

test("SDK shares memory-only authentication and sends only public API requests", async () => {
  let issued = 0; const paths = [];
  const client = createJuncturaClient({ ...options, fetcher: async (url, init) => {
    assert.equal(init.redirect, "error");
    if (url.pathname.includes("/token")) {
      issued++; assert.equal(init.body.get("client_secret"), options.clientSecret);
      return auth();
    }
    assert.equal(init.headers.get("Authorization"), "Bearer synthetic-token");
    assert.ok(!JSON.stringify(init).includes(options.clientSecret));
    paths.push(url.pathname);
    return json({ subject: "synthetic", tenantId: "tenant-a", roles: ["core-reader"] });
  } });
  await Promise.all([client.identity(), client.identity(), client.discover({ limit: 2 })]);
  assert.equal(issued, 1); assert.equal(paths.length, 3);
  assert.ok(!JSON.stringify(client).includes("synthetic-token"));
});

test("SDK forbids remote cleartext and paths escaping Gateway APIs before sending credentials", async () => {
  for (const baseUrl of ["http://remote.invalid", "https://user:secret@example.org", "https://example.org/path"]) {
    assert.throws(() => createJuncturaClient({ ...options, baseUrl }));
  }
  const client = createJuncturaClient({ ...options, fetcher() { assert.fail("must not connect"); } });
  for (const path of ["https://other.invalid/v1/identity", "//other.invalid", "/identity/admin", "/v1/../../admin", "/v1/identity#fragment", "/v1/\\other"]) {
    await assert.rejects(client.request(path), TypeError);
  }
});

test("SDK lists records with optional paging parameters and returns items and nextCursor unchanged", async () => {
  const calls = [];
  const page = { items: [{ id: "00000000-0000-4000-8000-000000000001", collection: "entries", data: { index: 1 }, created_at: "2026-01-01T00:00:00.123456+00:00" }], nextCursor: "opaque_next-cursor" };
  const client = createJuncturaClient({ ...options, fetcher: async (url, init) => {
    if (url.pathname.includes("/token")) return auth();
    assert.equal(init.method, "GET");
    calls.push({ path: url.pathname, query: [...url.searchParams] });
    return json(calls.length === 3 ? { items: [], nextCursor: null } : page);
  } });
  assert.deepEqual(await client.listRecords("entries"), page);
  assert.deepEqual(await client.listRecords("entries", { limit: 2, order: "desc", cursor: "opaque+/=?&" }), page);
  assert.deepEqual(await client.listRecords("entries", { limit: 2, order: "desc", cursor: page.nextCursor }), { items: [], nextCursor: null });
  await client.listRecords("entries/other", {});
  assert.deepEqual(calls, [
    { path: "/v2/data/entries", query: [] },
    { path: "/v2/data/entries", query: [["limit", "2"], ["order", "desc"], ["cursor", "opaque+/=?&"]] },
    { path: "/v2/data/entries", query: [["limit", "2"], ["order", "desc"], ["cursor", page.nextCursor]] },
    { path: "/v2/data/entries%2Fother", query: [] },
  ]);
});

test("SDK never retries ambiguous mutation failures; errors omit bodies and credentials", async () => {
  let mutations = 0;
  const client = createJuncturaClient({ ...options, fetcher: async (url) => {
    if (url.pathname.includes("/token")) return auth();
    mutations++; throw Error("synthetic-secret private transport detail");
  } });
  await assert.rejects(client.createRecord("example", { synthetic: true }), error => error instanceof JuncturaError && error.code === "gateway_unavailable" && !String(error).includes("synthetic-secret"));
  assert.equal(mutations, 1);
});

test("SDK clears rejected credentials for the next explicit request and preserves denial codes", async () => {
  let tokens = 0, attempts = 0;
  const client = createJuncturaClient({ ...options, fetcher: async url => {
    if (url.pathname.includes("/token")) { tokens++; return auth(); }
    attempts++;
    return attempts === 1 ? json({ error: "invalid_token", private: "secret" }, 401, { "x-request-id": "req-123" }) : json({ subject: "ok" });
  } });
  await assert.rejects(client.identity(), error => error.status === 401 && error.code === "invalid_token" && error.requestId === "req-123");
  assert.equal(attempts, 1);
  await client.identity(); assert.equal(tokens, 2);
});

test("SDK sends exact workflow and execution contracts with caller-controlled idempotency", async () => {
  const bodies = [];
  const client = createJuncturaClient({ ...options, fetcher: async (url, init) => {
    if (url.pathname.includes("/token")) return auth();
    bodies.push({ path: url.pathname, key: init.headers.get("Idempotency-Key"), body: JSON.parse(init.body) });
    return json({ executionId: "synthetic", state: "accepted" }, 202);
  } });
  await client.startWorkflow("junctura_checkpoint:1:uuid", { synthetic: true }, "workflow-key");
  const target = { kind: "composition", compositionId: "synthetic", version: "1.0.0", compositionDigest: "sha256:synthetic" };
  await client.execute(target, { value: 1 }, "execution-key");
  await client.execute(target, { value: 2 }, "context-key", { purpose: "review", dataSubject: "subject-1" });
  assert.deepEqual(bodies, [
    { path: "/v1/workflows/executions", key: "workflow-key", body: { definitionId: "junctura_checkpoint:1:uuid", input: { synthetic: true } } },
    { path: "/v1/capability-executions", key: "execution-key", body: { target, input: { value: 1 } } },
    { path: "/v1/capability-executions", key: "context-key", body: { target, input: { value: 2 }, context: { purpose: "review", dataSubject: "subject-1" } } },
  ]);
});

test("SDK polling stops on auth-required and ambiguous outcomes without resubmission", async () => {
  for (const state of ["auth_required", "outcome_unknown", "succeeded", "failed", "timed_out"]) {
    let requests = 0;
    const client = createJuncturaClient({ ...options, fetcher: async (url, init) => {
      if (url.pathname.includes("/token")) return auth();
      assert.equal(init.method, "GET"); requests++;
      return json({ executionId: "synthetic", state });
    } });
    assert.equal((await client.waitForExecution("synthetic")).state, state);
    assert.equal(requests, 1);
  }
});

test("SDK polling and malformed/oversized authentication responses are bounded", async () => {
  const client = createJuncturaClient({ ...options, fetcher: async url => url.pathname.includes("/token") ? auth() : json({ state: "running" }) });
  await assert.rejects(client.waitForExecution("synthetic", { timeoutMs: 30, intervalMs: 100 }));
  for (const issued of [json({ access_token: "token" }), new Response("x".repeat(70000))]) {
    const invalid = createJuncturaClient({ ...options, fetcher: async () => issued });
    await assert.rejects(invalid.identity(), JuncturaError);
  }
});

test("SDK input digest matches the platform canonical digest", () => {
  const input = { z: [1, "á", null, { b: true, a: 2.5 }], a: "x" };
  assert.equal(inputDigest(input), `sha256:${createHash("sha256").update(canonicalize(input)).digest("hex")}`);
  assert.throws(() => inputDigest({ n: Infinity }), TypeError);
});

test("SDK redeems provider tickets once and never sends malformed tickets", async () => {
  const ticket = "t".repeat(43), invocationId = "11111111-1111-4111-8111-111111111111", sent = [];
  const client = createJuncturaClient({ ...options, fetcher: async (url, init) => {
    if (url.pathname.includes("/token")) return auth();
    sent.push({ path: url.pathname, body: JSON.parse(init.body) });
    return json({ active: true, context: { tenantId: "tenant-a", executionId: invocationId, purpose: "review" } });
  } });
  for (const authorization of [undefined, "", `Basic ${ticket}`, "Bearer short", `Bearer ${ticket} extra`]) {
    assert.deepEqual(await client.redeemTicket({ authorization, invocationId, input: {} }), { active: false });
  }
  assert.equal(sent.length, 0);
  const redeemed = await client.redeemTicket({ authorization: `Bearer ${ticket}`, invocationId, input: { subject: "p1" } });
  assert.equal(redeemed.context.purpose, "review");
  assert.deepEqual(sent, [{ path: "/v1/capability-authorizations/introspect",
    body: { ticket, invocationId, inputDigest: inputDigest({ subject: "p1" }) } }]);
});

test("SDK directory and consent calls hit the documented routes and bodies", async () => {
  const calls = [];
  const client = createJuncturaClient({ ...options, fetcher: async (url, init) => {
    if (url.pathname.includes("/token")) return auth();
    calls.push({ path: url.pathname, query: [...url.searchParams], method: init.method,
      key: init.headers.get("Idempotency-Key"), body: init.body === undefined || init.body === null ? undefined : JSON.parse(init.body) });
    return json({ unitType: "office", name: "Office" });
  } });
  await client.listDirectoryUnitTypes({ limit: 10, cursor: "next" });
  await client.putDirectoryUnitType("office", "Office");
  await client.deleteDirectoryUnitType("office");
  await client.putDirectoryUnit("unit-a", { unitType: "office", name: "Unit A" });
  await client.putDirectoryGroup("unit-a", "reviewers", "Reviewers");
  await client.putDirectoryMember("unit-a", "subject-42", ["reviewers"]);
  await client.listDirectoryMembers("unit-a", {});
  await client.deleteDirectoryMember("unit-a", "subject-42");
  await client.createConsent({ consumerAppId: "22222222-2222-4222-8222-222222222222",
    capabilityId: "urn:junctura:capability:33333333-3333-4333-8333-333333333333:lookup",
    purposes: ["service_review"], expiresAt: "2030-01-12T12:00:00Z" }, "consent-key");
  await client.revokeConsent("11111111-1111-4111-8111-111111111111");
  assert.deepEqual(calls, [
    { path: "/v1/directory/unit-types", query: [["limit", "10"], ["cursor", "next"]], method: "GET", key: null, body: undefined },
    { path: "/v1/directory/unit-types/office", query: [], method: "PUT", key: null, body: { name: "Office" } },
    { path: "/v1/directory/unit-types/office", query: [], method: "DELETE", key: null, body: undefined },
    { path: "/v1/directory/units/unit-a", query: [], method: "PUT", key: null, body: { unitType: "office", name: "Unit A" } },
    { path: "/v1/directory/units/unit-a/groups/reviewers", query: [], method: "PUT", key: null, body: { name: "Reviewers" } },
    { path: "/v1/directory/units/unit-a/members/subject-42", query: [], method: "PUT", key: null, body: { groups: ["reviewers"] } },
    { path: "/v1/directory/units/unit-a/members", query: [], method: "GET", key: null, body: undefined },
    { path: "/v1/directory/units/unit-a/members/subject-42", query: [], method: "DELETE", key: null, body: undefined },
    { path: "/v1/me/consents", query: [], method: "POST", key: "consent-key",
      body: { consumerAppId: "22222222-2222-4222-8222-222222222222",
        capabilityId: "urn:junctura:capability:33333333-3333-4333-8333-333333333333:lookup",
        purposes: ["service_review"], expiresAt: "2030-01-12T12:00:00Z" } },
    { path: "/v1/me/consents/11111111-1111-4111-8111-111111111111/revoke", query: [], method: "POST", key: null, body: {} },
  ]);
});
