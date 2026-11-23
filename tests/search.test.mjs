// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { handleSearch, decodeSearchCursor, encodeSearchCursor, drainTenant, startSearchIndexer } from "../src/modules/search/search.mjs";
import { createMeilisearch } from "../src/modules/search/meilisearch.mjs";
import { HttpError } from "../src/platform/http/http.mjs";

const config = { dataUrl: "http://data.invalid", dataSecret: "z".repeat(32),
  searchUrl: "http://meili.invalid", searchKey: "k".repeat(32), objectsUrl: "http://filer.invalid" };
const identity = { tenantId: "tenant-a", issuer: "https://identity.invalid", subject: "reader", clientId: "console",
  roles: ["core-reader"] };
const generation = "66666666-6666-4666-8666-666666666666";
const scope = { generation, actor: identity.tenantId, management: [], shares: [] };
const index = `junctura-search-tenant-a-${generation}`;
const hit = (kind, id, extra = {}) => ({
  kind, resourceId: id, ownerAppId: "22222222-2222-4222-8222-222222222222",
  version: kind === "record" ? 1 : "33333333-3333-4333-8333-333333333333",
  incarnation: "44444444-4444-4444-8444-444444444444", schemaRevision: 1,
  projection: "full", collection: "notes", text: "hello", ...extra,
});

let routes;
const respond = async (url, init) => {
  const target = new URL(url);
  if (process.env.DEBUG_ROUTES) console.log("FETCH", init?.method, url);
  for (const [match, handler] of routes) {
    if (!match(target, init)) continue;
    const answer = await handler(target, init);
    return answer === undefined ? new Response(null, { status: 404 }) : answer;
  }
  return new Response(null, { status: 404 });
};

const data = (value, status = 200) => Response.json({ status, ...(status === 200 ? { value } : { error: value }) });
const accepted = taskUid => Response.json({ taskUid }, { status: 202 });
const succeeded = () => Response.json({ status: "succeeded" });
const signed = (value, secret = config.dataSecret) =>
  `${Buffer.from(JSON.stringify(value)).toString("base64url")}.${
    createHmac("sha256", secret).update(Buffer.from(JSON.stringify(value)).toString("base64url")).digest("base64url")}`;

function meiliRoutes(overrides = {}) {
  let task = 0;
  return [
    [target => target.host === "meili.invalid" && target.pathname === `/indexes/${index}/search`,
      (target, init) => {
        const body = JSON.parse(init.body);
        return body.filter !== undefined
          ? overrides.listing?.(body) ?? Response.json({ hits: [] })
          : overrides.search?.(body) ?? Response.json({ hits: [] });
      }],
    [target => target.host === "meili.invalid" && target.pathname === `/indexes/${index}/documents`,
      (target, init) => overrides.documents?.(JSON.parse(init.body)) ?? accepted(++task)],
    [target => target.host === "meili.invalid" && target.pathname === `/indexes/${index}/documents/delete-batch`,
      (target, init) => overrides.purgeIds?.(JSON.parse(init.body)) ?? accepted(++task)],
    [target => target.host === "meili.invalid" && target.pathname === `/indexes/${index}/settings`,
      (target, init) => overrides.settings?.(JSON.parse(init.body)) ?? accepted(++task)],
    [target => target.host === "meili.invalid" && target.pathname === "/indexes",
      (target, init) => overrides.create?.(JSON.parse(init.body)) ?? accepted(++task)],
    [target => target.host === "meili.invalid" && target.pathname === `/indexes/${index}`,
      (target, init) => init.method === "DELETE"
        ? overrides.drop?.() ?? Response.json({ taskUid: ++task }, { status: 202 })
        : Response.json({ uid: index })],
    [target => target.host === "meili.invalid" && /^\/tasks\/\d+$/.test(target.pathname),
      (target, init) => overrides.task?.(Number(target.pathname.split("/").at(-1))) ?? succeeded()],
  ];
}

const dataRoute = handler => [target => target.host === "data.invalid" && target.pathname === "/rpc/search_command",
  async (target, init) => {
    const body = JSON.parse(init.body);
    const claims = JSON.parse(Buffer.from(init.headers.Authorization.split(".")[1], "base64url"));
    return (await handler(body, claims)) ?? data(null);
  }];

const search = async (url = "/v1/search?q=hello", caller = identity) => {
  const sink = { body: null, writeHead() {}, setHeader() {}, end(payload) { this.body = payload; } };
  await handleSearch({ method: "GET" }, sink, caller, config, new URL(url, "http://core"));
  return JSON.parse(sink.body);
};

test("pagination skips blocked candidates without losing visible hits", async t => {
  const hits = ["a", "b", "c", "d", "e"].map(suffix => hit("record", `55555555-5555-4555-8555-55555555555${suffix}`));
  const allowed = new Set([hits[1].resourceId, hits[3].resourceId]);
  let pages = 0;
  t.mock.method(globalThis, "fetch", respond);
  routes = [
    dataRoute(async body => {
      if (body.operation === "scope") return data(scope);
      assert.equal(body.operation, "acl");
      return data({
        items: body.payload.candidates
          .filter(candidate => allowed.has(candidate.id))
          .map(candidate => ({ position: candidate.position,
            item: { type: "record", recordRef: { collection: "notes", id: candidate.id } } })),
        generation });
    }),
    ...meiliRoutes({ search: body => {
      pages++;
      if (pages === 1) { assert.equal(body.offset, 0); assert.equal(body.sort[0], "id:asc"); return Response.json({ hits }); }
      assert.equal(body.offset, 3);
      return Response.json({ hits: hits.slice(3) });
    } }),
  ];
  const first = await search("/v1/search?q=hello&limit=1");
  assert.deepEqual(first.items, [{ type: "record", recordRef: { collection: "notes", id: hits[1].resourceId } }]);
  const resumed = decodeSearchCursor(first.nextCursor, "hello", identity, scope, config.dataSecret);
  assert.deepEqual(resumed, { offset: 3, generation },
    "the cursor resumes at the next visible hit, not after the blocked ones");
  const second = await search(`/v1/search?q=hello&limit=1&cursor=${first.nextCursor}`);
  assert.deepEqual(second.items, [{ type: "record", recordRef: { collection: "notes", id: hits[3].resourceId } }]);
  assert.equal(second.nextCursor, null);
  assert.equal(pages, 2);
});

test("a fully blocked batch produces an empty page and never a cursor", async t => {
  t.mock.method(globalThis, "fetch", respond);
  routes = [
    dataRoute(async body => body.operation === "scope" ? data(scope)
      : data({ items: [], generation })),
    ...meiliRoutes({ search: () => Response.json({ hits: [hit("record", "55555555-5555-4555-8555-555555555551")] }) }),
  ];
  const page = await search("/v1/search?q=hello&limit=5");
  assert.deepEqual(page, { items: [], nextCursor: null });
});

test("duplicate resource ids in one batch are approved per hit, not per id", async t => {
  const stale = hit("record", "55555555-5555-4555-8555-555555555551", { version: 0, schemaRevision: 0 });
  const current = hit("record", "55555555-5555-4555-8555-555555555551");
  t.mock.method(globalThis, "fetch", respond);
  routes = [
    dataRoute(async body => {
      if (body.operation === "scope") return data(scope);
      assert.equal(body.operation, "acl");
      return data({ items: body.payload.candidates
        .filter(candidate => candidate.version === "1")
        .map(candidate => ({ position: candidate.position,
          item: { type: "record", recordRef: { collection: "notes", id: candidate.id } } })), generation });
    }),
    ...meiliRoutes({ search: () => Response.json({ hits: [stale, current] }) }),
  ];
  const page = await search("/v1/search?q=hello");
  assert.deepEqual(page.items, [{ type: "record", recordRef: { collection: "notes", id: current.resourceId } }],
    "the stale duplicate stays blocked while the current hit surfaces exactly once");
});

test("cursors bind to the query, caller, scope and generation, and fail closed", async t => {
  t.mock.method(globalThis, "fetch", respond);
  routes = [
    dataRoute(async body => body.operation === "scope" ? data(scope) : data({ items: [], generation })),
    ...meiliRoutes({ search: () => Response.json({ hits: [hit("record", "55555555-5555-4555-8555-555555555551")] }) }),
  ];
  const stale = encodeSearchCursor("hello", identity, scope, "77777777-7777-4777-8777-777777777777", 0, config.dataSecret);
  await assert.rejects(search(`/v1/search?q=hello&cursor=${stale}`), error =>
    error instanceof HttpError && error.status === 400 && error.message === "invalid_cursor");
  await assert.rejects(search(`/v1/search?q=other&cursor=${encodeSearchCursor("hello", identity, scope, generation, 0, config.dataSecret)}`),
    error => error.status === 400 && error.message === "invalid_cursor");
  await assert.rejects(search(`/v1/search?q=hello&cursor=${encodeSearchCursor("hello", identity,
    { ...scope, shares: ["record-1"] }, generation, 0, config.dataSecret)}`),
    error => error.status === 400 && error.message === "invalid_cursor",
    "a cursor from another read scope is foreign");
  await assert.rejects(search(`/v1/search?q=hello&cursor=${Buffer.from(JSON.stringify({
    o: 0, g: generation, f: "x", e: Date.now() + 3_600_000,
  })).toString("base64url")}.forged`), error => error.status === 400 && error.message === "invalid_cursor",
  "an unsigned or forged cursor never pages");
  await assert.rejects(search(`/v1/search?q=hello&cursor=${signed({
    o: 0, g: generation, f: "x", e: Date.now() - 1,
  })}`), error => error.status === 400 && error.message === "invalid_cursor",
  "a correctly signed but expired cursor fails closed");
  const decoded = decodeSearchCursor(encodeSearchCursor("hello", identity, scope, generation, 3, config.dataSecret),
    "hello", identity, scope, config.dataSecret);
  assert.deepEqual(decoded, { offset: 3, generation });
  assert.throws(() => decodeSearchCursor(encodeSearchCursor("hello", { ...identity, subject: "other" },
    scope, generation, 0, config.dataSecret), "hello", identity, scope, config.dataSecret),
    error => error.status === 400, "a cursor from another subject is foreign");
});

test("a tenant that never built its index answers an empty page", async t => {
  t.mock.method(globalThis, "fetch", respond);
  let meiliSearches = 0;
  routes = [
    dataRoute(async () => data({ generation: null, actor: identity.tenantId, management: [], shares: [] })),
    ...meiliRoutes({ search: () => { meiliSearches++; return Response.json({ hits: [hit("record", "55555555-5555-4555-8555-555555555551")] }); } }),
  ];
  const page = await search();
  assert.deepEqual(page, { items: [], nextCursor: null });
  assert.equal(meiliSearches, 0, "no index exists for a generation-less tenant");
  // A generation whose index vanished answers empty instead of failing.
  routes = [
    dataRoute(async () => data(scope)),
    ...meiliRoutes({ search: () => Response.json({}, { status: 404 }) }),
  ];
  assert.deepEqual(await search(), { items: [], nextCursor: null });
});

test("the worker rebuilds from PostgreSQL, fences every write and retires the old generation", async t => {
  const old = "99999999-9999-4999-8999-999999999999";
  const recordId = "55555555-5555-4555-8555-555555555551";
  const incarnation = "44444444-4444-4444-8444-444444444444";
  const drops = [];
  const dropped = [];
  let leases = null;
  let documents = 0;
  let jobs = 0;
  t.mock.method(globalThis, "fetch", respond);
  routes = [
    dataRoute(async (body, claims) => {
      if (claims.role !== "junctura_search_worker") return data("worker_required", 403);
      leases ??= body.payload.lease;
      assert.equal(body.payload.lease, leases, "every worker call carries the same lease");
      if (body.operation === "tenants") return data(["tenant-a"]);
      if (body.operation === "acquire") {
        assert.equal(claims.tenant_id, "tenant-a");
        return data({ tenant_id: "tenant-a", generation: null, building_generation: null,
          retired_generation: old, rebuild_requested: false, ready_at: null });
      }
      if (body.operation === "retire") { assert.equal(body.payload.generation, old); return data(true); }
      if (body.operation === "prepare") return data({ building_generation: generation, rebuild_requested: false });
      if (body.operation === "jobs") return data(jobs++ === 0
        ? [{ jobId: "7", kind: "record", id: recordId }] : []);
      if (body.operation === "document") {
        assert.deepEqual(body.payload, { kind: "record", id: recordId, lease: leases });
        return data({ id: recordId, ownerAppId: "22222222-2222-4222-8222-222222222222", collection: "notes",
          version: "1", incarnation, schemaRevision: "2", searchable: ["code", "secret"], sensitive: ["secret"],
          data: { code: "hello", secret: "s3cret", nested: { ignored: true } } });
      }
      if (body.operation === "finish") return data({ tenant_id: "tenant-a", generation, building_generation: null,
        retired_generation: old, rebuild_requested: false, ready_at: null });
      if (body.operation === "drop") { drops.push({ jobIds: body.payload.jobIds, retryJobIds: body.payload.retryJobIds }); return data(true); }
      if (body.operation === "renew" || body.operation === "release") return data(true);
      return data("invalid_operation", 400);
    }),
    ...meiliRoutes({
      documents: body => {
        documents++;
        assert.deepEqual(Object.keys(body[0]).sort(), ["collection", "generation", "id", "incarnation", "kind",
          "ownerAppId", "projection", "resourceId", "schemaRevision", "text", "version"]);
        assert.match(body[0].id, /^[A-Za-z0-9_-]+$/, "the document id has no invalid characters");
        assert.equal(body[0].generation, generation);
        if (body[0].projection === "full") {
          assert.equal(body[0].id, `record-${recordId}-${incarnation}-v1-r2-full`);
          assert.match(body[0].text, /hello/);
          assert.match(body[0].text, /s3cret/, "the owner projection keeps sensitive fields searchable");
        } else {
          assert.equal(body[0].id, `record-${recordId}-${incarnation}-v1-r2-management`);
          assert.match(body[0].text, /hello/);
          assert.doesNotMatch(body[0].text, /s3cret/, "the management projection omits sensitive fields");
        }
        return accepted(documents);
      },
      listing: body => {
        assert.equal(body.filter, `kind = "record" AND resourceId = "${recordId}"`);
        return Response.json({ hits: [
          { id: `record-${recordId}-${incarnation}-v1-r2-full` },
          { id: `record-${recordId}-${incarnation}-v1-r2-management` },
          { id: `record-${recordId}-${incarnation}-v0-r1-full` },
        ] });
      },
      purgeIds: body => {
        assert.deepEqual(body, [`record-${recordId}-${incarnation}-v0-r1-full`],
          "only the immutable id of the superseded version is removed");
        return accepted(++documents + 100);
      },
      drop: () => { dropped.push(old); return Response.json({ taskUid: 900 }, { status: 202 }); },
    }),
    [(target, init) => target.host === "meili.invalid" &&
      target.pathname === `/indexes/junctura-search-tenant-a-${old}` && init.method === "DELETE",
      () => { dropped.push(old); return Response.json({ taskUid: 901 }, { status: 202 }) }],
  ];
  await drainTenant(config, createMeilisearch(config), "tenant-a");
  assert.deepEqual(drops, [{ jobIds: ["7"], retryJobIds: [] }]);
  assert.equal(documents, 3, "both projections and the superseded cleanup ran");
  assert.deepEqual(dropped, [old, old], "the retired generation dropped its index at acquire and at finish");
});

test("an unusable index write keeps the job queued and a lost lease stops the drain", async t => {
  const recordId = "55555555-5555-4555-8555-555555555552";
  let jobs = 0;
  let writes = 0;
  const drops = [];
  let renewAfterDrop = false;
  t.mock.method(globalThis, "fetch", respond);
  routes = [
    dataRoute(async body => {
      if (body.operation === "tenants") return data(["tenant-a"]);
      if (body.operation === "acquire") return data({ tenant_id: "tenant-a", generation,
        building_generation: null, retired_generation: null, rebuild_requested: false, ready_at: null });
      if (body.operation === "jobs") return data(jobs++ === 0 ? [{ jobId: "3", kind: "record", id: recordId }] : []);
      if (body.operation === "document") return data({ id: recordId, ownerAppId: "22222222-2222-4222-8222-222222222222",
        collection: "notes", version: "1", incarnation: "44444444-4444-4444-8444-444444444444",
        schemaRevision: "1", searchable: ["code"], sensitive: [], data: { code: "hello" } });
      if (body.operation === "drop") {
        drops.push({ jobIds: body.payload.jobIds, retryJobIds: body.payload.retryJobIds });
        return data("search_lease_lost", 409);
      }
      if (body.operation === "renew") { renewAfterDrop = true; return data(true); }
      if (body.operation === "release") return data(true);
      return data("invalid_operation", 400);
    }),
    ...meiliRoutes({
      documents: () => {
        writes++;
        if (writes === 1) return Response.json({ missing: true }, { status: 202 });
        if (writes === 2) return accepted(99);
        return Response.json({ status: "failed" });
      },
      task: uid => Response.json({ status: uid === 99 ? "failed" : "succeeded" }),
    }),
  ];
  await assert.rejects(drainTenant(config, createMeilisearch(config), "tenant-a"),
    error => error.status === 409, "a lost lease ends the drain");
  assert.deepEqual(drops, [{ jobIds: [], retryJobIds: ["3"] }],
    "a missing task id and a failed task keep the job queued");
  assert.equal(renewAfterDrop, false, "the drain stops before renewing a lost lease");
});

test("a temporary filer outage keeps the object job and a clean miss purges it", async t => {
  const objectId = "55555555-5555-4555-8555-555555555553";
  const staleVersion = "33333333-3333-4333-8333-333333333333";
  let jobs = 0;
  let failures = 0;
  const purged = [];
  const drops = [];
  t.mock.method(globalThis, "fetch", respond);
  routes = [
    dataRoute(async body => {
      if (body.operation === "tenants") return data(["tenant-a"]);
      if (body.operation === "acquire") return data({ tenant_id: "tenant-a", generation,
        building_generation: null, retired_generation: null, rebuild_requested: false, ready_at: null });
      if (body.operation === "jobs") return data(jobs++ % 2 === 0 ? [{ jobId: "4", kind: "object", id: objectId }] : []);
      if (body.operation === "document") return data({ id: objectId, ownerAppId: "22222222-2222-4222-8222-222222222222",
        version: staleVersion });
      if (body.operation === "drop") { drops.push({ jobIds: body.payload.jobIds, retryJobIds: body.payload.retryJobIds }); return data(true); }
      if (body.operation === "renew" || body.operation === "release") return data(true);
      return data("invalid_operation", 400);
    }),
    [target => target.host === "filer.invalid", () => {
      failures++;
      return failures === 1 ? Promise.reject(new Error("filer down")) : new Response(null, { status: 404 });
    }],
    ...meiliRoutes({
      listing: body => {
        assert.equal(body.filter, `kind = "object" AND resourceId = "${objectId}"`);
        return Response.json({ hits: [{ id: `object-${objectId}-v${staleVersion}` }] });
      },
      purgeIds: body => { purged.push(...body); return accepted(50); },
    }),
  ];
  await drainTenant(config, createMeilisearch(config), "tenant-a");
  await drainTenant(config, createMeilisearch(config), "tenant-a");
  assert.deepEqual(purged, [`object-${objectId}-v${staleVersion}`],
    "the first pass fails on the filer outage and the second pass removes the stale document by id");
  assert.deepEqual(drops, [{ jobIds: [], retryJobIds: ["4"] }, { jobIds: ["4"], retryJobIds: [] }]);
});

test("a newer render or a lost lease stops the superseded cleanup", async t => {
  const recordId = "55555555-5555-4555-8555-555555555554";
  let jobs = 0;
  let fetches = 0;
  const purged = [];
  t.mock.method(globalThis, "fetch", respond);
  routes = [
    dataRoute(async body => {
      if (body.operation === "tenants") return data(["tenant-a"]);
      if (body.operation === "acquire") return data({ tenant_id: "tenant-a", generation,
        building_generation: null, retired_generation: null, rebuild_requested: false, ready_at: null });
      if (body.operation === "jobs") return data(jobs++ % 2 === 0 ? [{ jobId: "5", kind: "record", id: recordId }] : []);
      // The currency re-check answers a newer version: the worker stops
      // before touching the index for cleanup.
      if (body.operation === "document") return fetches++ === 0
        ? data({ id: recordId, ownerAppId: "22222222-2222-4222-8222-222222222222", collection: "notes",
          version: "1", incarnation: "44444444-4444-4444-8444-444444444444", schemaRevision: "1",
          searchable: ["code"], sensitive: [], data: { code: "hello" } })
        : data({ id: recordId, ownerAppId: "22222222-2222-4222-8222-222222222222", collection: "notes",
          version: "2", incarnation: "44444444-4444-4444-8444-444444444444", schemaRevision: "1",
          searchable: ["code"], sensitive: [], data: { code: "hello again" } });
      return data(true);
    }),
    ...meiliRoutes({
      documents: () => accepted(60),
      listing: () => Response.json({ hits: [{ id: `record-${recordId}-44444444-4444-4444-8444-444444444444-v0-r1-full` }] }),
      purgeIds: body => { purged.push(...body); return accepted(61); },
    }),
  ];
  await drainTenant(config, createMeilisearch(config), "tenant-a");
  assert.deepEqual(purged, [], "a superseded render never deletes documents");
});

test("a rebuild yields when outstanding jobs are waiting for retry", async t => {
  const operations = [];
  t.mock.method(globalThis, "fetch", respond);
  routes = [dataRoute(async ({ operation }) => {
    operations.push(operation);
    if (operation === "acquire") return data({ generation: null, building_generation: generation });
    if (operation === "jobs") {
      assert.equal(operations.filter(name => name === "jobs").length, 1);
      return data([]);
    }
    if (operation === "finish") return data(null);
    assert.equal(operation, "release");
    return data(true);
  })];
  assert.equal(await drainTenant(config, createMeilisearch(config), "tenant-a"), true);
  assert.deepEqual(operations, ["acquire", "jobs", "finish", "release"]);
});

test("an unusable adapter configuration fails closed", async t => {
  assert.throws(() => createMeilisearch({ searchUrl: "http://meili.invalid" }), HttpError);
  assert.equal(startSearchIndexer({ ...config, searchUrl: undefined }), undefined);
  t.mock.method(globalThis, "fetch", respond);
  routes = [];
  await assert.rejects(search("/v1/search?q=hello", { ...identity, clientId: undefined }),
    error => error.status === 403, "an anonymous client cannot search");
});
