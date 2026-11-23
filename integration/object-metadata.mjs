// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { base, jsonResult, recordTestSupport } from "./record-test-support.mjs";
import { contractFetch, verifyContracts } from "./contract.mjs";

const prefix = `omd_${randomBytes(6).toString("hex")}`;
const support = recordTestSupport(prefix);
const { api, sql, q } = support;
const collection = `${prefix}_main`;
let owner, other, recipient, recordId;

const octets = (bytes) => new Blob([bytes], { type: "application/octet-stream" });
const jsonPart = (value) => new Blob([JSON.stringify(value)], { type: "application/json" });

const upload = (who, id, parts, { key = randomUUID(), method = "POST", contentType = "multipart/form-data" } = {}) => {
  const path = id ? `/v2/objects/${id}` : "/v2/objects";
  const headers = { Authorization: `Bearer ${who.token}`, "Idempotency-Key": key };
  if (contentType === "multipart/form-data") {
    const form = new FormData();
    for (const [name, value] of Object.entries(parts)) {
      if (value === undefined) continue;
      form.append(name, value instanceof Blob ? value : jsonPart(value));
    }
    return contractFetch(`${base}${path}`, { method, body: form, headers, signal: AbortSignal.timeout(30000) });
  }
  return contractFetch(`${base}${path}`, { method, body: parts.file, headers: {
    ...headers, "Content-Type": "application/octet-stream" }, signal: AbortSignal.timeout(30000) });
};

const list = (who, query = "") => api(`/v2/objects${query}`, who);

before(async () => {
  owner = await support.createBackend("meta-owner");
  other = await support.createBackend("meta-other");
  recipient = await support.createBackend("meta-reader");
  assert.equal((await api(`/v2/data-schemas/${collection}`, owner, { method: "PUT", body: {
    schema: { type: "object", required: ["code"], properties: { code: { type: "string" } } },
    indexed: ["code"], uniqueKey: "code", searchable: [], sensitive: [],
  } })).status, 200);
  recordId = (await jsonResult(await api(`/v2/data/${collection}`, owner, {
    method: "POST", body: { data: { code: "OM-1" } }, headers: { "Idempotency-Key": randomUUID() },
  }), 201)).id;
});

after(async () => {
  await support.cleanup([owner, other, recipient]);
});

test("multipart uploads publish metadata only after a clean scan", async () => {
  const created = await jsonResult(await upload(owner, undefined, {
    file: octets(Buffer.from("report-bytes")),
    recordRef: { collection, id: recordId },
    tags: ["source", "draft"],
  }), 201);
  assert.equal(created.size, 12);
  assert.deepEqual(created.recordRef, { collection, id: recordId });
  assert.deepEqual(created.tags, ["source", "draft"]);
  const download = await api(`/v2/objects/${created.id}`, owner);
  assert.equal(download.status, 200);
  assert.equal(Buffer.from(await download.arrayBuffer()).toString(), "report-bytes");
  // The octet-stream form creates an unlinked and untagged object.
  const plain = await jsonResult(await upload(owner, undefined, { file: octets(Buffer.from("plain-bytes")) },
    { contentType: "application/octet-stream" }), 201);
  assert.deepEqual({ recordRef: plain.recordRef, tags: plain.tags }, { recordRef: null, tags: [] });
});

test("replacement preserves omitted metadata and honours explicit null and empty array", async () => {
  const created = await jsonResult(await upload(owner, undefined, {
    file: octets(Buffer.from("first")), recordRef: { collection, id: recordId }, tags: ["keep"],
  }), 201);
  // Omitted parts preserve the previous link and tags.
  const kept = await jsonResult(await upload(owner, created.id, { file: octets(Buffer.from("second-bytes")) }, { method: "PUT" }), 200);
  assert.equal(kept.size, 13);
  assert.deepEqual(kept.recordRef, { collection, id: recordId });
  assert.deepEqual(kept.tags, ["keep"]);
  // Explicit null and [] clear them.
  const cleared = await jsonResult(await upload(owner, created.id, {
    file: octets(Buffer.from("third")), recordRef: null, tags: [],
  }, { method: "PUT" }), 200);
  assert.deepEqual({ recordRef: cleared.recordRef, tags: cleared.tags }, { recordRef: null, tags: [] });
  const relinked = await jsonResult(await upload(owner, created.id, {
    file: octets(Buffer.from("fourth")), recordRef: { collection, id: recordId }, tags: ["again"],
  }, { method: "PUT" }), 200);
  assert.deepEqual(relinked.recordRef, { collection, id: recordId });
  // A stable UUID PUT with identical bytes and key replays the stored receipt.
  const key = randomUUID();
  const first = await upload(owner, undefined, { file: octets(Buffer.from("retry")), tags: ["r"] }, { key });
  assert.equal(first.status, 201);
  const replay = await upload(owner, undefined, { file: octets(Buffer.from("retry")), tags: ["r"] }, { key });
  assert.equal(replay.status, 201);
  assert.deepEqual(await replay.json(), await first.clone().json());
  const reused = await upload(owner, undefined, { file: octets(Buffer.from("changed")), tags: ["r"] }, { key });
  assert.equal(reused.status, 422);
  assert.equal((await reused.json()).error, "idempotency_key_reused");
});

test("record links stay valid only for the live linked record", async () => {
  const foreign = await upload(owner, undefined, {
    file: octets(Buffer.from("foreign")), recordRef: { collection, id: "44444444-4444-4444-8444-444444444444" },
  });
  assert.equal(foreign.status, 404);
  const created = await jsonResult(await upload(owner, undefined, {
    file: octets(Buffer.from("linked")), recordRef: { collection, id: recordId }, tags: ["linked"],
  }), 201);
  // An exact object share authorizes the recipient's list entry; a record link
  // alone never grants visibility.
  await jsonResult(await api("/v2/resource-shares", owner, { method: "POST", body: {
    resourceType: "object", resourceId: created.id, granteeAppId: recipient.appId,
    action: "read", expiresAt: new Date(Date.now() + 3600000).toISOString(),
  }, headers: { "Idempotency-Key": randomUUID() } }), 201);
  const shared = await list(recipient, `?recordRef[collection]=${collection}&recordRef[id]=${recordId}`);
  assert.deepEqual((await shared.json()).items.map(item => item.id), [created.id]);
  const outsider = await list(other, `?recordRef[collection]=${collection}&recordRef[id]=${recordId}`);
  assert.deepEqual((await outsider.json()).items, []);
  // Deleting the linked record invalidates the link but keeps the bytes.
  assert.equal((await api(`/v2/data/${collection}/${recordId}`, owner, { method: "DELETE" })).status, 204);
  assert.equal((await api(`/v2/objects/${created.id}`, owner)).status, 200);
  const afterDelete = await list(owner, "?tag=linked");
  const entry = (await afterDelete.json()).items.find(item => item.id === created.id);
  assert.equal(entry.recordRef, null);
  // A re-created record with the same UUID has a new incarnation; the link stays invalid.
  await jsonResult(await api("/v2/data:import", owner, {
    method: "POST", body: `${JSON.stringify({ collection, id: recordId, data: { code: "OM-1" } })}\n`,
    headers: { "Content-Type": "application/x-ndjson", "Idempotency-Key": randomUUID() },
  }), 200);
  const afterRecreate = await list(owner, "?tag=linked");
  assert.equal((await afterRecreate.json()).items.find(item => item.id === created.id).recordRef, null);
});

test("the per-app file quota charges published bytes once under the app lock", async () => {
  await sql(`INSERT INTO app_private.object_quotas (tenant_id, owner_app_id, max_bytes)
    VALUES ('tenant-a','${owner.appId}',20) ON CONFLICT (tenant_id, owner_app_id)
    DO UPDATE SET max_bytes=20;`);
  try {
    const first = await jsonResult(await upload(owner, undefined, { file: octets(Buffer.alloc(12, 1)) }), 201);
    const second = await upload(owner, undefined, { file: octets(Buffer.alloc(12, 2)) });
    assert.equal(second.status, 429);
    const body = await second.json();
    assert.equal(body.error, "quota_exceeded");
    assert.deepEqual(body.quota, { resource: "appFileBytes", limit: 20, used: 12 });
    // The refused bytes never became downloadable.
    assert.equal((await list(owner)).status, 200);
    // Replacement charges only the delta; deletion releases the current size.
    const grown = await jsonResult(await upload(owner, first.id, { file: octets(Buffer.alloc(20, 3)) }, { method: "PUT" }), 200);
    assert.equal(grown.size, 20);
    assert.equal((await api(`/v2/objects/${first.id}`, owner, { method: "DELETE" })).status, 204);
    const released = await jsonResult(await upload(owner, undefined, { file: octets(Buffer.alloc(20, 4)) }), 201);
    assert.equal(released.size, 20);
    // Legacy rows without a size are backfilled from the Filer before charging.
    await sql(`UPDATE app_private.resource_objects SET size_bytes=NULL
      WHERE tenant_id='tenant-a' AND id='${released.id}';`);
    const page = await jsonResult(await list(owner));
    assert.equal(page.items.find(item => item.id === released.id).size, 20);
    const charged = await upload(owner, undefined, { file: octets(Buffer.alloc(1, 5)) });
    assert.equal(charged.status, 429);
    assert.deepEqual((await charged.json()).quota, { resource: "appFileBytes", limit: 20, used: 20 });
  } finally {
    await sql(`DELETE FROM app_private.object_quotas WHERE tenant_id='tenant-a' AND owner_app_id='${owner.appId}';`);
  }
});

test("upload rejections follow the planned envelope", async () => {
  assert.equal((await upload(owner, undefined, { file: octets(Buffer.alloc(0)) })).status, 400);
  const foreign = await upload(other, undefined, { file: octets(Buffer.from("x")),
    recordRef: { collection, id: recordId } });
  assert.equal(foreign.status, 404);
  const missingKey = await contractFetch(`${base}/v2/objects`, { method: "POST",
    headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/octet-stream" },
    body: Buffer.from("x"), signal: AbortSignal.timeout(30000) });
  assert.equal(missingKey.status, 400);
  assert.match((await missingKey.json()).error, /^invalid_request$/);
  // A PUT racing a finished delete finds the tombstoned object gone.
  const target = await jsonResult(await upload(owner, undefined, { file: octets(Buffer.from("race")) }), 201);
  assert.equal((await api(`/v2/objects/${target.id}`, owner, { method: "DELETE" })).status, 204);
  const afterDelete = await upload(owner, target.id, { file: octets(Buffer.from("race")) }, { method: "PUT" });
  assert.equal(afterDelete.status, 404);
});

test("implemented operations match the observed HTTP contract", async () => {
  await verifyContracts("object-metadata");
});
