// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { jsonResult, recordTestSupport } from "./record-test-support.mjs";
import { verifyContracts } from "./contract.mjs";

const strict = process.env.STRICT_RECORD_WRITES === "true";
const prefix = `ags_${randomBytes(6).toString("hex")}`;
const support = recordTestSupport(prefix);
const { api, sql, q } = support;
const collection = `${prefix}_main`;
const pageCollection = `${prefix}_pages`;
const group = `partners-${prefix.replaceAll("_", "-")}`;
let owner, recipient, outsider, recordId;

const expiry = (offsetMs = 3600000) => new Date(Date.now() + offsetMs).toISOString();
const share = (body, key = randomUUID()) => api("/v2/resource-shares", owner, {
  method: "POST", body, headers: { "Idempotency-Key": key },
});
const importBody = line => api("/v2/data:import", owner, {
  method: "POST", body: `${JSON.stringify(line)}\n`,
  headers: { "Content-Type": "application/x-ndjson", "Idempotency-Key": randomUUID() },
});
const groupShare = (resourceId, key = randomUUID(), groupName = group) => share({
  resourceType: "record", resourceId, granteeAppGroup: groupName, action: "read", expiresAt: expiry(),
}, key);

before(async () => {
  owner = await support.createBackend("group-owner");
  recipient = await support.createBackend("group-recipient");
  outsider = await support.createBackend("group-outsider");
  assert.equal((await api(`/v2/data-schemas/${collection}`, owner, { method: "PUT", body: {
    schema: { type: "object", required: ["code"], properties: { code: { type: "string" }, status: { type: "string" } } },
    indexed: ["code", "status"], uniqueKey: "code", searchable: [], sensitive: [],
  } })).status, 200);
  const created = await jsonResult(await api(`/v2/data/${collection}`, owner, {
    method: "POST", body: { data: { code: "A-1", status: "open" } }, headers: { "Idempotency-Key": randomUUID() },
  }), 201);
  recordId = created.id;
  await sql(`INSERT INTO app_private.app_groups (tenant_id,app_group) VALUES ('tenant-a',${q(group)});
    INSERT INTO app_private.app_group_memberships (tenant_id,app_group,app_id)
    VALUES ('tenant-a',${q(group)},'${recipient.appId}');`);
});

after(async () => {
  await support.cleanup([owner, recipient, outsider]);
});

test("app group shares authorize current members only and replay by idempotency key", async () => {
  const key = randomUUID();
  const body = { resourceType: "record", resourceId: recordId, granteeAppGroup: group, action: "read", expiresAt: expiry() };
  const created = await jsonResult(await share(body, key), 201);
  assert.equal(created.granteeAppGroup, group);
  assert.equal(created.resourceId, recordId);
  const replay = await jsonResult(await share(body, key), 201);
  assert.equal(replay.shareId, created.shareId);
  assert.equal(await sql(`SELECT count(*) FROM app_private.resource_shares WHERE resource_id='${recordId}' AND NOT revoked;`), "1");
  assert.equal((await api(`/v2/data/${collection}/${recordId}`, recipient)).status, 200);
  assert.equal((await api(`/v2/data/${collection}/${recordId}`, outsider)).status, 404);
  await sql(`DELETE FROM app_private.app_group_memberships WHERE tenant_id='tenant-a' AND app_group=${q(group)} AND app_id='${recipient.appId}';`);
  assert.equal((await api(`/v2/data/${collection}/${recordId}`, recipient)).status, 404);
  await sql(`INSERT INTO app_private.app_group_memberships (tenant_id,app_group,app_id)
    VALUES ('tenant-a',${q(group)},'${recipient.appId}');`);
  assert.equal((await api(`/v2/data/${collection}/${recordId}`, recipient)).status, 200);
  await sql(`UPDATE app_private.resource_shares SET expires_at=now()-interval '1 second' WHERE resource_id='${recordId}';`);
  assert.equal((await api(`/v2/data/${collection}/${recordId}`, recipient)).status, 404);
});

test("group shares revoke like exact shares, accept only records and stop on suspension", async () => {
  const created = await jsonResult(await groupShare(recordId), 201);
  assert.equal((await api(`/v2/resource-shares/${created.shareId}`, owner, { method: "DELETE" })).status, 204);
  assert.equal((await api(`/v2/data/${collection}/${recordId}`, recipient)).status, 404);
  const object = await share({
    resourceType: "object", resourceId: randomUUID(), granteeAppGroup: group, action: "read", expiresAt: expiry(),
  });
  assert.equal(object.status, 400);
  const exact = await jsonResult(await share({
    resourceType: "record", resourceId: recordId, granteeAppId: recipient.appId, action: "read", expiresAt: expiry(),
  }), 201);
  assert.equal(exact.granteeAppId, recipient.appId);
  assert.equal((await api(`/v2/data/${collection}/${recordId}`, recipient)).status, 200);
  await sql(`UPDATE app_private.applications SET state='suspended' WHERE tenant_id='tenant-a' AND app_id='${recipient.appId}';`);
  assert.equal((await api(`/v2/data/${collection}/${recordId}`, recipient)).status, strict ? 404 : 403);
  await sql(`UPDATE app_private.applications SET state='active' WHERE tenant_id='tenant-a' AND app_id='${recipient.appId}';`);
  await sql(`UPDATE app_private.applications SET state='suspended' WHERE tenant_id='tenant-a' AND app_id='${owner.appId}';`);
  assert.equal((await api(`/v2/data/${collection}/${recordId}`, recipient)).status, 404);
  await sql(`UPDATE app_private.applications SET state='active' WHERE tenant_id='tenant-a' AND app_id='${owner.appId}';`);
  const missing = await groupShare(randomUUID());
  assert.equal(missing.status, 404);
});

test("group shares reject cross-tenant groups and malformed grantee selections", async () => {
  const foreignGroup = `foreign-${prefix.replaceAll("_", "-")}`;
  await sql(`INSERT INTO app_private.app_groups (tenant_id,app_group) VALUES ('tenant-b',${q(foreignGroup)});`);
  try {
    assert.equal((await groupShare(recordId, randomUUID(), foreignGroup)).status, 404);
    const both = await share({
      resourceType: "record", resourceId: recordId, granteeAppId: recipient.appId,
      granteeAppGroup: group, action: "read", expiresAt: expiry(),
    });
    assert.equal(both.status, 400);
    const object = await share({
      resourceType: "object", resourceId: randomUUID(), granteeAppGroup: group, action: "read", expiresAt: expiry(),
    });
    assert.equal(object.status, 400);
  } finally {
    await sql(`DELETE FROM app_private.app_groups WHERE tenant_id='tenant-b' AND app_group=${q(foreignGroup)};`);
  }
});

test("group membership changes between list pages and aggregates take effect on the next request", async () => {
  assert.equal((await api(`/v2/data-schemas/${pageCollection}`, owner, { method: "PUT", body: {
    schema: { type: "object", required: ["code"], properties: { code: { type: "string" }, status: { type: "string" } } },
    indexed: ["code", "status"], uniqueKey: "code", searchable: [], sensitive: [],
  } })).status, 200);
  const created = [];
  for (const code of ["P-1", "P-2", "P-3"]) {
    created.push(await jsonResult(await api(`/v2/data/${pageCollection}`, owner, {
      method: "POST", body: { data: { code, status: "open" } }, headers: { "Idempotency-Key": randomUUID() },
    }), 201));
    assert.equal((await groupShare(created.at(-1).id)).status, 201);
  }
  const first = await jsonResult(await api(`/v2/data/${pageCollection}?ownerAppId=${owner.appId}&limit=1`, recipient), 200);
  assert.equal(first.items.length, 1);
  assert.ok(first.nextCursor);
  const aggregateBefore = await jsonResult(await api(`/v2/data/${pageCollection}/aggregate?count&ownerAppId=${owner.appId}`, recipient), 200);
  assert.equal(aggregateBefore.count, 3);
  await sql(`DELETE FROM app_private.app_group_memberships
    WHERE tenant_id='tenant-a' AND app_group=${q(group)} AND app_id='${recipient.appId}';`);
  const second = await api(`/v2/data/${pageCollection}?ownerAppId=${owner.appId}&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`, recipient);
  assert.equal(second.status, 404);
  const aggregateAfter = await api(`/v2/data/${pageCollection}/aggregate?count&ownerAppId=${owner.appId}`, recipient);
  assert.equal(aggregateAfter.status, 404);
  await sql(`INSERT INTO app_private.app_group_memberships (tenant_id,app_group,app_id)
    VALUES ('tenant-a',${q(group)},'${recipient.appId}');`);
});

test("suspending a group recipient blocks reads while the share is live", async () => {
  const record = await jsonResult(await api(`/v2/data/${collection}`, owner, {
    method: "POST", body: { data: { code: "S-1", status: "open" } }, headers: { "Idempotency-Key": randomUUID() },
  }), 201);
  assert.equal((await groupShare(record.id)).status, 201);
  assert.equal((await api(`/v2/data/${collection}/${record.id}`, recipient)).status, 200);
  await sql(`UPDATE app_private.applications SET state='suspended' WHERE tenant_id='tenant-a' AND app_id='${recipient.appId}';`);
  assert.equal((await api(`/v2/data/${collection}/${record.id}`, recipient)).status, strict ? 404 : 403);
  await sql(`UPDATE app_private.applications SET state='active' WHERE tenant_id='tenant-a' AND app_id='${recipient.appId}';`);
});

test("group share expiry accepts just under 24 hours and rejects beyond it", async () => {
  assert.equal((await groupShare(recordId, randomUUID(), group)).status, 201);
  const near = await share({
    resourceType: "record", resourceId: recordId, granteeAppGroup: group, action: "read",
    expiresAt: expiry(24 * 3600000 - 60000),
  });
  assert.equal(near.status, 201);
  const far = await share({
    resourceType: "record", resourceId: recordId, granteeAppGroup: group, action: "read",
    expiresAt: expiry(24 * 3600000 + 300000),
  });
  assert.equal(far.status, 400);
});

test("re-importing a deleted record ID does not revive an old group share", async () => {
  const created = await api(`/v2/data/${collection}`, owner, {
    method: "POST", body: { data: { code: "R-1", status: "open" } }, headers: { "Idempotency-Key": randomUUID() },
  });
  const record = await jsonResult(created, 201);
  assert.equal((await groupShare(record.id)).status, 201);
  assert.equal((await api(`/v2/data/${collection}/${record.id}`, recipient)).status, 200);
  assert.equal((await api(`/v2/data/${collection}/${record.id}`, owner, {
    method: "DELETE", headers: { "If-Match": created.headers.get("etag") },
  })).status, 204);
  const imported = await importBody({ collection, id: record.id, data: { code: "R-1", status: "open" } });
  assert.equal(imported.status, 200);
  assert.equal((await api(`/v2/data/${collection}/${record.id}`, recipient)).status, 404);
});

test("reusing a share idempotency key with a changed body returns 422 with requestId", async () => {
  const key = randomUUID();
  const body = { resourceType: "record", resourceId: recordId, granteeAppGroup: group, action: "read", expiresAt: expiry() };
  assert.equal((await share(body, key)).status, 201);
  const changed = await share({ ...body, expiresAt: expiry(7200000) }, key);
  assert.equal(changed.status, 422);
  const value = await changed.json();
  assert.equal(value.error, "idempotency_key_reused");
  assert.match(value.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("implemented operations match the observed HTTP contract", async () => {
  await verifyContracts("app-group-shares");
});
