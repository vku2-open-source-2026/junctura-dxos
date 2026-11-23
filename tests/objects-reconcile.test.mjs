// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcileOnce, startObjectReconciler } from "../src/modules/objects/reconcile.mjs";

const config = { dataUrl: "http://data.test", dataSecret: "s".repeat(32), objectsUrl: "http://filer.test" };
const item = { tenantId: "tenant-a", appId: "22222222-2222-4222-8222-222222222222",
  id: "44444444-4444-4444-8444-444444444444", version: "55555555-5555-4555-8555-555555555555" };
const versionPath = `/junctura-app/${item.tenantId}/${item.appId}/${item.id}/${item.version}`;
const quarantinePath = `/junctura-quarantine/${item.tenantId}/${item.id}/${item.stagedVersion ?? item.version}`;

function fixture(plan) {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    const target = new URL(url);
    const method = options.method ?? "GET";
    const body = options.body === undefined ? undefined : JSON.parse(options.body);
    calls.push({ method, path: target.pathname, body });
    if (target.pathname === "/rpc/object_maintenance") {
      const respond = plan.rpc[body.operation]?.shift();
      if (respond === undefined) throw new Error(`unexpected ${body.operation}`);
      return typeof respond === "function" ? respond(body.payload) : respond;
    }
    const handle = plan.filer?.shift();
    if (handle === undefined) throw new Error(`unexpected filer ${method} ${target.pathname}`);
    return typeof handle === "function" ? handle() : handle;
  };
  return { calls, fetcher };
}

const rpcPayload = (calls, operation) => calls.find(call =>
  call.path === "/rpc/object_maintenance" && call.body?.operation === operation)?.body.payload;
const rpcCalls = (calls, operation) =>
  calls.filter(call => call.path === "/rpc/object_maintenance" && call.body?.operation === operation);
const filer = calls => calls.filter(call => call.path.startsWith("/junctura-app/") ||
  call.path.startsWith("/junctura-quarantine/"));

test("the reconciler measures published versions from the Filer and reports their sizes", async () => {
  const { calls, fetcher } = fixture({
    rpc: {
      unmeasured: [Response.json({ status: 200, value: [item] }), Response.json({ status: 200, value: [] })],
      sizes: [Response.json({ status: 200, value: { measured: 1 } })],
      staged: [Response.json({ status: 200, value: [] })],
    },
    filer: [new Response(null, { status: 200, headers: { "content-length": "12" } })],
  });
  await reconcileOnce(config, fetcher);
  assert.deepEqual(filer(calls).map(call => call.method), ["HEAD"]);
  assert.deepEqual(rpcPayload(calls, "sizes"), { sizes: [{ ...item, size: 12 }] });
  assert.equal(rpcCalls(calls, "unmeasured").length, 2, "the pass drains the queue");
  assert.deepEqual(rpcCalls(calls, "unmeasured")[1].body.payload.after,
    { tenantId: item.tenantId, appId: item.appId, id: item.id },
    "the sweep continues with a keyset past the reported rows");
  assert.equal(rpcCalls(calls, "staged").length, 1);
  assert.equal(rpcCalls(calls, "unstaged").length, 0);
});

test("a version whose bytes are gone counts as zero and an unavailable Filer defers with backoff", async () => {
  const gone = fixture({
    rpc: {
      unmeasured: [Response.json({ status: 200, value: [{ ...item, attempts: 0 }] }),
        Response.json({ status: 200, value: [] })],
      sizes: [Response.json({ status: 200, value: { measured: 1 } })],
      staged: [Response.json({ status: 200, value: [] })],
    },
    filer: [new Response(null, { status: 404 })],
  });
  await reconcileOnce(config, gone.fetcher);
  assert.deepEqual(rpcPayload(gone.calls, "sizes"), { sizes: [{ ...item, size: 0 }] });

  const down = fixture({
    rpc: {
      unmeasured: [Response.json({ status: 200, value: [{ ...item, attempts: 2 }] }),
        Response.json({ status: 200, value: [] })],
      sizes: [Response.json({ status: 200, value: { measured: 0 } })],
      staged: [Response.json({ status: 200, value: [] })],
    },
    filer: [new Response(null, { status: 503 })],
  });
  await reconcileOnce(config, down.fetcher);
  assert.deepEqual(rpcPayload(down.calls, "sizes"),
    { sizes: [{ ...item, defer: 240 }] },
    "an unmeasurable version is deferred on the retry schedule, not guessed");
  assert.deepEqual(rpcCalls(down.calls, "unmeasured")[1].body.payload.after,
    { tenantId: item.tenantId, appId: item.appId, id: item.id },
    "the deferred row does not block the sweep behind it");
});

test("staged attempts without a confirmed version lose their bytes and record", async () => {
  const orphan = { ...item, stagedVersion: item.version, publishedVersion: null };
  const { calls, fetcher } = fixture({
    rpc: {
      unmeasured: [Response.json({ status: 200, value: [] })],
      staged: [Response.json({ status: 200, value: [orphan] })],
      unstaged: [Response.json({ status: 200, value: { unstaged: 1, confirmed: [orphan] } }),
        Response.json({ status: 200, value: { unstaged: 1, confirmed: [] } })],
    },
    filer: [new Response(null, { status: 404 }), new Response(null, { status: 404 })],
  });
  await reconcileOnce(config, fetcher);
  assert.deepEqual(rpcPayload(calls, "unstaged"),
    { items: [{ tenantId: item.tenantId, appId: item.appId, id: item.id, stagedVersion: item.version }] },
    "the invalidation asks only for the four identifying keys");
  assert.deepEqual(filer(calls).map(call => [call.method, call.path]),
    [["DELETE", versionPath], ["DELETE", quarantinePath]],
    "a crashed upload leaves bytes on the published and the quarantine path");
});

test("the published staged version keeps its bytes while a busy Filer defers cleanup", async () => {
  const published = { ...item, stagedVersion: item.version, publishedVersion: item.version };
  const kept = fixture({
    rpc: {
      unmeasured: [Response.json({ status: 200, value: [] })],
      staged: [Response.json({ status: 200, value: [published] })],
    },
    filer: [],
  });
  await reconcileOnce(config, kept.fetcher);
  assert.deepEqual(filer(kept.calls), [], "referenced bytes are never removed");
  assert.equal(rpcCalls(kept.calls, "unstaged").length, 0,
    "an attempt naming the published version is never invalidated");

  const busy = { ...item, stagedVersion: item.version, publishedVersion: null };
  const deferred = fixture({
    rpc: {
      unmeasured: [Response.json({ status: 200, value: [] })],
      staged: [Response.json({ status: 200, value: [busy] })],
      unstaged: [Response.json({ status: 200, value: { unstaged: 1, confirmed: [busy] } })],
    },
    filer: [new Response(null, { status: 503 }), new Response(null, { status: 503 })],
  });
  await reconcileOnce(config, deferred.fetcher);
  assert.equal(rpcCalls(deferred.calls, "unstaged").length, 1,
    "a failed deletion keeps the invalidated attempt for the next pass");
  assert.deepEqual(filer(deferred.calls).map(call => call.method), ["DELETE", "DELETE"],
    "the published path and the quarantine path are both retried later");
});

test("confirmed attempts are cleared only after their bytes are gone", async () => {
  const orphan = { ...item, stagedVersion: item.version, publishedVersion: null };
  const { calls, fetcher } = fixture({
    rpc: {
      unmeasured: [Response.json({ status: 200, value: [] })],
      staged: [Response.json({ status: 200, value: [orphan] })],
      unstaged: [Response.json({ status: 200, value: { unstaged: 1, confirmed: [orphan] } }),
        Response.json({ status: 200, value: { unstaged: 1, confirmed: [] } })],
    },
    filer: [new Response(null, { status: 404 }), new Response(null, { status: 404 })],
  });
  await reconcileOnce(config, fetcher);
  assert.deepEqual(rpcCalls(calls, "unstaged")[1].body.payload,
    { items: [{ tenantId: item.tenantId, appId: item.appId, id: item.id, stagedVersion: item.version }],
      cleared: true },
    "the record is dropped only once its bytes no longer exist");
});

test("a commit that wins the race keeps its bytes: only database-confirmed attempts are deleted", async () => {
  const raced = { ...item, stagedVersion: item.version, publishedVersion: null };
  const { calls, fetcher } = fixture({
    rpc: {
      unmeasured: [Response.json({ status: 200, value: [] })],
      staged: [Response.json({ status: 200, value: [raced] })],
      // The database refused to invalidate the attempt: a concurrent commit
      // published these bytes, so nothing may be deleted.
      unstaged: [Response.json({ status: 200, value: { unstaged: 0, confirmed: [] } })],
    },
    filer: [],
  });
  await reconcileOnce(config, fetcher);
  assert.deepEqual(filer(calls), [], "unconfirmed attempts never lose their bytes");
});

test("worker refusals and transport outages surface to the retrying tick", async () => {
  const { fetcher } = fixture({ rpc: { unmeasured: [Response.json({ status: 403, error: "worker_required" })] } });
  await assert.rejects(reconcileOnce(config, fetcher), /worker_required/);
  const failing = async () => { throw new Error("down"); };
  await assert.rejects(reconcileOnce(config, failing), /objects_unavailable/);
  await assert.rejects(reconcileOnce({ ...config, dataUrl: undefined }, failing), /objects_unavailable/);
});

test("the reconciler only starts with both the database and the Filer configured", () => {
  assert.equal(startObjectReconciler({ objectsUrl: "http://filer.test" }), undefined);
  assert.equal(startObjectReconciler({ dataUrl: "http://data.test" }), undefined);
  const stop = startObjectReconciler(config, 60_000);
  assert.equal(typeof stop, "function");
  stop();
});
