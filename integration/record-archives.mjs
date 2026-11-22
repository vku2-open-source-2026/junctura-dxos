// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { base, jsonResult, recordTestSupport } from "./record-test-support.mjs";
import { verifyContracts } from "./contract.mjs";

const prefix = `ra_${randomBytes(6).toString("hex")}`;
const support = recordTestSupport(prefix);
const { api, sql } = support;
const collection = `${prefix}_main`;
const ids = Array.from({ length: 5 }, () => randomUUID());
const bulkCollection = `${prefix}_bulk`;
let owner, recipient;

const schema = {
  schema: { type: "object", required: ["code"], properties: {
    code: { type: "string" }, status: { type: "string" }, quantity: { type: "number" },
  } },
  indexed: ["code", "status", "quantity"], uniqueKey: "code", searchable: [], sensitive: [],
};
const create = (code, extra = {}) => api(`/v2/data/${collection}`, owner, {
  method: "POST", body: { data: { code, status: "open", ...extra } },
  headers: { "Idempotency-Key": randomUUID() },
});
const line = (id, data) => JSON.stringify({ collection, id, data });
const importBody = text => api("/v2/data:import", owner, {
  method: "POST", body: text,
  headers: { "Content-Type": "application/x-ndjson", "Idempotency-Key": randomUUID() },
});
const insertArchive = async (id, data) => {
  const response = await importBody(`${line(id, data)}\n`);
  return jsonResult(response, 200);
};

before(async () => {
  owner = await support.createBackend("archive-owner");
  recipient = await support.createBackend("archive-recipient");
  assert.equal((await api(`/v2/data-schemas/${collection}`, owner, { method: "PUT", body: schema })).status, 200);
});

after(async () => {
  await support.cleanup([owner, recipient]);
});

test("export streams a consistent owner-only NDJSON snapshot in collection and id order", async () => {
  for (const [code, quantity] of [["A-1", 1], ["A-2", 2]]) {
    const response = await create(code, { quantity });
    assert.equal(response.status, 201);
  }
  const exported = await api(`/v2/data:export?collection=${collection}`, owner);
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get("content-type"), /^application\/x-ndjson/);
  const text = await exported.text();
  assert.ok(text.endsWith("\n"));
  const lines = text.trimEnd().split("\n").map(value => JSON.parse(value));
  assert.deepEqual(lines.map(value => value.collection), [collection, collection]);
  assert.deepEqual(lines.map(value => value.id), [...lines].map(value => value.id).sort());
  assert.ok(lines.every(value => value.data.code.startsWith("A-")));
  const foreign = await api(`/v2/data:export?collection=${collection}`, recipient);
  assert.equal(foreign.status, 200);
  assert.equal(await foreign.text(), "");
  assert.equal((await api("/v2/data:export?unknown=1", owner)).status, 400);
});

test("import preserves IDs, starts at version one and replays the same idempotency key", async () => {
  const body = `${line(ids[2], { code: "A-3", status: "open", quantity: 3 })}\n`;
  const key = randomUUID();
  const send = () => api("/v2/data:import", owner, {
    method: "POST", body, headers: { "Content-Type": "application/x-ndjson", "Idempotency-Key": key },
  });
  assert.deepEqual(await jsonResult(await send(), 200), { created: 1 });
  assert.deepEqual(await jsonResult(await send(), 200), { created: 1 });
  const fetched = await jsonResult(await api(`/v2/data/${collection}/${ids[2]}`, owner), 200);
  assert.deepEqual(fetched.data, { code: "A-3", status: "open", quantity: 3 });
  assert.equal(await sql(`SELECT version FROM core.app_records WHERE tenant_id='tenant-a' AND id='${ids[2]}';`), "1");
  assert.equal(await sql(`SELECT count(*) FROM core.app_records WHERE tenant_id='tenant-a' AND id='${ids[2]}';`), "1");
});

test("a failed line rolls back the whole upload and malformed NDJSON is rejected", async () => {
  const body = `${line(ids[3], { code: "A-4" })}\n${line(ids[2], { code: "A-5" })}\n`;
  const conflict = await api("/v2/data:import", owner, {
    method: "POST", body, headers: { "Content-Type": "application/x-ndjson", "Idempotency-Key": randomUUID() },
  });
  assert.equal(conflict.status, 409);
  assert.equal((await api(`/v2/data/${collection}/${ids[3]}`, owner)).status, 404);
  for (const [text, status] of [
    ["", 400],
    [`\uFEFF${line(ids[4], { code: "A-6" })}\n`, 400],
    [`\n${line(ids[4], { code: "A-6" })}\n`, 400],
    [`${line(ids[4], { code: "A-6" })}\r\n`, 400],
    [`{"collection":"${collection}","id":"${ids[4]}"}\n`, 400],
    [`{"collection":"${collection}","id":"${ids[4]}","data":{},"extra":true}\n`, 400],
  ]) {
    const response = await api("/v2/data:import", owner, {
      method: "POST", body: text, headers: { "Content-Type": "application/x-ndjson", "Idempotency-Key": randomUUID() },
    });
    assert.equal(response.status, status, text);
  }
  const missingKey = await api("/v2/data:import", owner, {
    method: "POST", body: `${line(ids[4], { code: "A-6" })}\n`, headers: { "Content-Type": "application/x-ndjson" },
  });
  assert.equal(missingKey.status, 400);
  const wrongType = await api("/v2/data:import", owner, {
    method: "POST", body: `${line(ids[4], { code: "A-6" })}\n`,
    headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
  });
  assert.equal(wrongType.status, 415);
});

test("export after import includes every committed record exactly once", async () => {
  await insertArchive(ids[4], { code: "A-6", status: "closed" });
  const exported = await api(`/v2/data:export?collection=${collection}`, owner);
  const lines = (await exported.text()).trimEnd().split("\n").map(value => JSON.parse(value));
  assert.equal(new Set(lines.map(value => value.id)).size, lines.length);
  assert.ok(lines.some(value => value.id === ids[2]));
  assert.ok(lines.some(value => value.id === ids[4]));
  assert.deepEqual(lines.map(value => value.id), [...lines].map(value => value.id).sort());
});

test("import schema failures publish the failing line in issues", async () => {
  const body = `${line(randomUUID(), { status: "open" })}\n`;
  const response = await api("/v2/data:import", owner, {
    method: "POST", body, headers: { "Content-Type": "application/x-ndjson", "Idempotency-Key": randomUUID() },
  });
  assert.equal(response.status, 422);
  const value = await response.json();
  assert.equal(value.error, "schema_violation");
  assert.equal(value.issues[0].line, 1);
});

test("a 500+ row export stays on one snapshot while writes continue and pages are read", async () => {
  assert.equal((await api(`/v2/data-schemas/${bulkCollection}`, owner, { method: "PUT", body: schema })).status, 200);
  const bulk = Array.from({ length: 520 }, (_, index) => ({
    id: randomUUID(), code: `B-${String(index).padStart(3, "0")}`,
  }));
  const values = bulk.map(item => `('tenant-a',${support.q(owner.appId)},${support.q(item.id)},${support.q(bulkCollection)},jsonb_build_object('code',${support.q(item.code)},'status','open'),now(),${support.q(item.code)})`).join(",");
  await sql(`INSERT INTO core.app_records (tenant_id,owner_app_id,id,collection,data,created_at,unique_key_value) VALUES ${values};
    SELECT app_private.record_replace_projection(r) FROM core.app_records r
      WHERE r.tenant_id='tenant-a' AND r.owner_app_id=${support.q(owner.appId)} AND r.collection=${support.q(bulkCollection)};
    UPDATE app_private.record_collections SET record_count=520
      WHERE tenant_id='tenant-a' AND owner_app_id=${support.q(owner.appId)} AND collection=${support.q(bulkCollection)};`);

  const response = await fetch(`${base}/v2/data:export?collection=${bulkCollection}`, {
    headers: { Authorization: `Bearer ${owner.token}` },
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = decoder.decode((await reader.read()).value, { stream: true });
  const newId = randomUUID();
  await sql(`UPDATE core.app_records SET data = data || '{"status":"changed"}'::jsonb
      WHERE tenant_id='tenant-a' AND owner_app_id=${support.q(owner.appId)} AND collection=${support.q(bulkCollection)};
    INSERT INTO core.app_records (tenant_id,owner_app_id,id,collection,data,created_at,unique_key_value)
      VALUES ('tenant-a',${support.q(owner.appId)},${support.q(newId)},${support.q(bulkCollection)},'{"code":"B-NEW","status":"open"}',now(),'B-NEW');`);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  const lines = text.trimEnd().split("\n").map(value => JSON.parse(value));
  assert.equal(lines.length, 520);
  assert.ok(lines.every(value => value.data.status === "open"));
  assert.ok(!lines.some(value => value.id === newId));
});

test("cancelling an export stops streaming and removes its snapshot", async () => {
  const snapshots = async () => Number(await sql(`SELECT count(*) FROM app_private.record_export_snapshots
    WHERE owner_app_id=${support.q(owner.appId)};`));
  assert.equal(await snapshots(), 0);
  const response = await fetch(`${base}/v2/data:export?collection=${bulkCollection}`, {
    headers: { Authorization: `Bearer ${owner.token}` },
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  let remaining = await snapshots();
  for (let attempt = 0; attempt < 50 && remaining !== 0; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 100));
    remaining = await snapshots();
  }
  assert.equal(remaining, 0);
});

test("implemented operations match the observed HTTP contract", async () => {
  await verifyContracts("record-archives");
});
