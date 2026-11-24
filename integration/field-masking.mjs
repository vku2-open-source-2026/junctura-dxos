// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { verifyContracts } from "./contract.mjs";
import { jsonResult, recordTestSupport } from "./record-test-support.mjs";

const collection = `mask_${randomUUID().slice(0, 8)}`;
const path = `/v2/data/${collection}`;
const policyPath = `/v2/data-masking/${collection}`;
const { api, cleanup, q, sql, createBackend } = recordTestSupport(collection);
const backends = [];

after(async () => {
  await cleanup(backends);
  await verifyContracts("field-masking");
});

test("field masks cover existing records, reads, write replays and archives for each reader", async () => {
  const owner = await createBackend("owner");
  backends.push(owner);
  const reader = await createBackend("reader", { writer: false });
  backends.push(reader);
  const grantee = await createBackend("grantee", { writer: false });
  backends.push(grantee);
  const writer = await createBackend("writer");
  backends.push(writer);

  const body = { data: {
    state: "active", nationalId: "example-id-0001", phone: "00001234", short: "1234",
    roleOnly: "example-role-value", internal: { nested: "example-internal-value" },
  } };
  const full = body.data;
  const masked = { state: "active", nationalId: "***", phone: "***1234", short: "***", roleOnly: "***", internal: "***" };
  const ownerView = { ...masked, nationalId: full.nationalId, roleOnly: full.roleOnly };
  const putPolicy = fields => api(policyPath, owner, { method: "PUT", body: { fields } });
  const create = () => api(path, owner, { method: "POST", headers: { "Idempotency-Key": randomUUID() }, body });
  const share = async (resourceId, to) => jsonResult(await api("/v2/resource-shares", owner, {
    method: "POST", headers: { "Idempotency-Key": randomUUID() },
    body: { resourceType: "record", resourceId, action: "read", granteeAppId: to.appId,
      expiresAt: new Date(Date.now() + 3600000).toISOString() },
  }), 201);

  const schema = {
    schema: { type: "object", properties: {
      state: { type: "string" }, nationalId: { type: "string" }, phone: { type: "string" },
    } }, indexed: ["state", "nationalId", "phone"], uniqueKey: null, searchable: ["nationalId", "state"], sensitive: [],
  };
  await jsonResult(await api(`/v2/data-schemas/${collection}`, owner, { method: "PUT", body: schema }), 200);
  assert.deepEqual(await jsonResult(await api(policyPath, owner), 200), { collection, fields: {} });
  const originalWrite = { method: "POST", headers: { "Idempotency-Key": randomUUID() }, body };
  const record = await jsonResult(await api(path, owner, originalWrite), 201);
  assert.deepEqual(record.data, full);
  const second = await jsonResult(await create(), 201);
  const recordPath = `${path}/${record.id}`;
  const clearShare = await share(record.id, grantee);
  await share(record.id, reader);
  await share(record.id, writer);
  await share(second.id, grantee);

  assert.equal((await putPolicy({ phone: { mask: "last4", shareIds: [randomUUID()] } })).status, 400);
  assert.equal((await api(policyPath, reader, { method: "PUT", body: { fields: {} } })).status, 403);
  const fields = {
    nationalId: { mask: "full", owner: true },
    phone: { mask: "last4", shareIds: [clearShare.shareId] },
    short: { mask: "last4" },
    roleOnly: { mask: "full", roles: ["core-writer"] },
    internal: { mask: "full" },
    absent: { mask: "full" },
  };
  assert.deepEqual(await jsonResult(await putPolicy(fields), 200), { collection, fields });
  assert.deepEqual(await jsonResult(await api(policyPath, owner), 200), { collection, fields });
  assert.deepEqual(await jsonResult(await api(policyPath, grantee), 200), { collection, fields: {} });

  for (const [caller, data] of [
    [reader, masked], [owner, ownerView], [grantee, { ...masked, phone: full.phone }],
    [writer, { ...masked, roleOnly: full.roleOnly }],
  ]) assert.deepEqual((await jsonResult(await api(recordPath, caller), 200)).data, data);
  assert.deepEqual((await jsonResult(await api(`${path}/${second.id}`, grantee), 200)).data, masked);
  if (process.env.STRICT_RECORD_WRITES !== "true") {
    assert.deepEqual((await jsonResult(await api(path, reader), 200)).items.map(row => row.data), [masked]);
  }

  const firstPage = await jsonResult(await api(`${path}?limit=1`, owner), 200);
  assert.deepEqual(firstPage.items.map(row => row.data), [ownerView]);
  assert.ok(firstPage.nextCursor);
  const nextPage = await jsonResult(await api(`${path}?cursor=${firstPage.nextCursor}`, owner), 200);
  assert.deepEqual(nextPage.items.map(row => row.data), [ownerView]);
  assert.notEqual(nextPage.items[0].id, firstPage.items[0].id);
  const query = new URLSearchParams({ ownerAppId: owner.appId, "where[state]": 'eq:"active"' });
  assert.deepEqual((await jsonResult(await api(`${path}?${query}`, reader), 200)).items.map(row => row.data), [masked]);
  for (const suffix of [
    `?${new URLSearchParams({ "where[nationalId]": `eq:${JSON.stringify(full.nationalId)}` })}`,
    "?sort=phone.asc", "/aggregate?count=true&groupBy=nationalId",
  ]) assert.equal((await api(path + suffix, owner)).status, 400);

  const replay = await jsonResult(await api(path, owner, originalWrite), 201);
  assert.equal(replay.id, record.id);
  assert.deepEqual(replay.data, ownerView);
  const fresh = await jsonResult(await create(), 201);
  assert.deepEqual(fresh.data, ownerView);
  const batch = await jsonResult(await api("/v2/data:batch", owner, {
    method: "POST", headers: { "Idempotency-Key": randomUUID() },
    body: { operations: [{ op: "create", collection, data: full }] },
  }), 200);
  assert.deepEqual(Object.keys(batch.results[0]).sort(), ["id", "op", "version"]);
  assert.deepEqual((await jsonResult(await api(`${path}/${batch.results[0].id}`, owner), 200)).data, ownerView);

  const archive = await api(`/v2/data:export?collection=${collection}`, owner);
  assert.equal(archive.status, 200);
  const lines = (await archive.text()).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(lines.length, 4);
  for (const line of lines) assert.deepEqual(line.data, ownerView);

  const audit = (await sql(`SELECT subject, count(*) FROM app_private.audit
    WHERE tenant_id = 'tenant-a' AND event = 'audit.record_fields_revealed' AND resource_id = ${q(record.id)}
    GROUP BY subject;`)).split("\n");
  assert.ok(audit.some(row => row.startsWith(`${owner.subject}|`)));
  assert.ok(audit.includes(`${writer.subject}|1`));
  assert.ok(audit.includes(`${grantee.subject}|1`));
  assert.ok(audit.every(row => !row.startsWith(`${reader.subject}|`)));

  const revoked = await api(`/v2/resource-shares/${clearShare.shareId}`, owner, { method: "DELETE" });
  assert.equal(revoked.status, 204);
  assert.equal((await api(recordPath, grantee)).status, 404);
  await share(record.id, grantee);
  assert.deepEqual((await jsonResult(await api(recordPath, grantee), 200)).data, masked);
  assert.deepEqual(await jsonResult(await putPolicy({}), 200), { collection, fields: {} });
  assert.deepEqual((await jsonResult(await api(recordPath, reader), 200)).data, full);
});
