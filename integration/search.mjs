// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { issuer, jsonResult, recordTestSupport } from "./record-test-support.mjs";
import { verifyContracts } from "./contract.mjs";

const prefix = `src_${randomBytes(6).toString("hex")}`;
const support = recordTestSupport(prefix);
const { api, sql, q } = support;
const collection = `${prefix}_notes`;
let owner, other, recipient, manager, recordId, objectId, secretId;

const waitUntil = async (description, probe) => {
  // A recreated Core may wait for the previous worker's 60-second lease.
  const deadline = Date.now() + 90_000;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`Search index did not settle: ${description}`);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
};

const hits = async (who, query) =>
  (await jsonResult(await api(`/v1/search?q=${encodeURIComponent(query)}`, who), 200)).items;

before(async () => {
  owner = await support.createBackend("search-owner");
  other = await support.createBackend("search-other");
  recipient = await support.createBackend("search-reader");
  manager = await support.createBackend("search-manager");
  // A management principal sees record structure without sensitive content.
  await sql(`INSERT INTO app_private.principals(tenant_id,issuer,subject,management_client,permissions)
    VALUES('tenant-a',${q(issuer)},${q(manager.subject)},${q(manager.clientId)},'{}'::text[]);
    INSERT INTO app_private.record_read_grants(tenant_id,issuer,subject,management_client,owner_app_id)
    VALUES('tenant-a',${q(issuer)},${q(manager.subject)},${q(manager.clientId)},'${owner.appId}');`);
  assert.equal((await api(`/v2/data-schemas/${collection}`, owner, { method: "PUT", body: {
    schema: { type: "object", required: ["code"], properties: { code: { type: "string" }, note: { type: "string" } } },
    indexed: ["code"], uniqueKey: "code", searchable: ["code", "note"], sensitive: ["note"],
  } })).status, 200);
});

after(async () => {
  await support.cleanup([owner, other, recipient, manager]);
});

test("declared record fields become searchable with live ACL checks", async () => {
  // note is searchable AND sensitive: owner and share readers match its
  // content, management readers only see the fields they may read.
  const found = await jsonResult(await api(`/v2/data/${collection}`, owner, {
    method: "POST", body: { data: { code: `needle-${prefix}`, note: "hidden-personal" } },
    headers: { "Idempotency-Key": randomUUID() },
  }), 201);
  recordId = found.id;
  const visible = await jsonResult(await api(`/v2/data/${collection}`, owner, {
    method: "POST", body: { data: { code: "plain-code", note: "unrelated remark" } },
    headers: { "Idempotency-Key": randomUUID() },
  }), 201);
  secretId = visible.id;
  await waitUntil("owner record", async () => (await hits(owner, `needle-${prefix}`)).length);
  const items = await hits(owner, `needle-${prefix}`);
  assert.deepEqual(items, [{ type: "record", recordRef: { collection, id: recordId } }]);
  // The owner matches the sensitive value; the management grant does not.
  assert.deepEqual(await hits(owner, "hidden-personal"),
    [{ type: "record", recordRef: { collection, id: recordId } }]);
  // The management projection is a separate document indexed on its own;
  // wait for it before asserting what management can and cannot match.
  const managed = await waitUntil("management projection", async () => {
    const items = await hits(manager, `needle-${prefix}`);
    return items.length ? items : null;
  });
  assert.deepEqual(managed, [{ type: "record", recordRef: { collection, id: recordId } }]);
  assert.deepEqual(await hits(manager, "hidden-personal"), []);
  // A candidate whose row disappeared between index and query never surfaces:
  // delete, then search for the still-indexed term.
  await sql(`DELETE FROM core.app_records WHERE tenant_id='tenant-a' AND id='${visible.id}';`);
  assert.deepEqual(await hits(owner, "plain-code"), []);
  assert.equal((await api(`/v2/data/${collection}/${secretId}`, owner)).status, 404);
});

test("object text becomes searchable after a clean publish", async () => {
  const original = `quarterly findings ${prefix}`;
  const replacement = `replacement ${prefix}`;
  const created = await jsonResult(await api("/v2/objects", owner, {
    method: "POST",
    headers: { "Idempotency-Key": randomUUID(), "Content-Type": "application/octet-stream" },
    body: Buffer.from(original),
  }), 201);
  objectId = created.id;
  await waitUntil("published object", async () => (await hits(owner, original)).some(hit => hit.objectId === objectId));
  const items = await hits(owner, original);
  assert.deepEqual(items.filter(hit => hit.type === "object"), [{ type: "object", objectId }]);
  // Replacing the published version replaces the indexed text.
  assert.equal((await api(`/v2/objects/${objectId}`, owner, {
    method: "PUT",
    headers: { "Idempotency-Key": randomUUID(), "Content-Type": "application/octet-stream" },
    body: Buffer.from(replacement),
  })).status, 200);
  await waitUntil("replacement object text", async () => {
    const found = await hits(owner, replacement);
    return found.some(hit => hit.type === "object" && hit.objectId === objectId);
  });
  // The superseded document's purge follows its replacement's visibility, so
  // the old text settles out of the index like the delete case below.
  await waitUntil("superseded object text removed", async () =>
    (await hits(owner, original)).every(hit => hit.objectId !== objectId));
  // Deletion tombstones the object and drops it from the index.
  assert.equal((await api(`/v2/objects/${objectId}`, owner, { method: "DELETE" })).status, 204);
  await waitUntil("deleted object text removed", async () => {
    const found = await hits(owner, replacement);
    return !found.some(hit => hit.type === "object" && hit.objectId === objectId);
  });
});

test("shares decide visibility at query time and revocation is immediate", async () => {
  await waitUntil("record available before sharing", async () => (await hits(owner, `needle-${prefix}`))
    .some(hit => hit.recordRef?.id === recordId));
  await jsonResult(await api("/v2/resource-shares", owner, { method: "POST", body: {
    resourceType: "record", resourceId: recordId, granteeAppId: recipient.appId,
    action: "read", expiresAt: new Date(Date.now() + 3600000).toISOString(),
  }, headers: { "Idempotency-Key": randomUUID() } }), 201);
  assert.deepEqual(await hits(recipient, `needle-${prefix}`),
    [{ type: "record", recordRef: { collection, id: recordId } }]);
  // A share reader reads full record content, sensitive fields included.
  assert.deepEqual(await hits(recipient, "hidden-personal"),
    [{ type: "record", recordRef: { collection, id: recordId } }]);
  // Another application in the same tenant sees nothing without a share.
  assert.deepEqual(await hits(other, `needle-${prefix}`), []);
  await sql(`UPDATE app_private.resource_shares SET revoked=true WHERE resource_id='${recordId}' AND NOT revoked;`);
  assert.deepEqual(await hits(recipient, `needle-${prefix}`), []);
});

test("search audits archived references only when authorized and returned", async () => {
  const term = `archived-${prefix}`;
  const created = await api(`/v2/data/${collection}`, owner, {
    method: "POST", body: { data: { code: term } }, headers: { "Idempotency-Key": randomUUID() },
  });
  const record = await jsonResult(created, 201);
  const path = `/v2/data/${collection}/${record.id}`;
  let createdArchive = false;
  try {
    await jsonResult(await api(`${path}:archive`, owner, {
      method: "POST", headers: { "If-Match": created.headers.get("etag") },
    }), 200);
    createdArchive = true;
    const expected = { type: "record", recordRef: { collection, id: record.id } };
    const response = await waitUntil("archived record revision", async () => {
      const next = await api(`/v1/search?q=${encodeURIComponent(term)}`, owner);
      const data = await jsonResult(next, 200);
      return data.items.some(item => item.recordRef?.id === record.id) && { headers: next.headers, items: data.items };
    });
    assert.deepEqual(response.items, [expected]);
    assert.deepEqual(await hits(other, term), []);
    const requestId = response.headers.get("x-request-id").split(",").at(-1).trim();
    assert.equal(await sql(`SELECT count(*) FROM app_private.audit WHERE tenant_id='tenant-a'
      AND event='audit.archived_record_read' AND reason_code='record_search' AND resource_id=${q(record.id)}
      AND subject=${q(owner.subject)} AND reason=${q(requestId)};`), "1");
    assert.equal(await sql(`SELECT count(*) FROM app_private.audit WHERE tenant_id='tenant-a'
      AND event='audit.archived_record_read' AND resource_id=${q(record.id)} AND subject=${q(other.subject)};`), "0");
  } finally {
    if (createdArchive) await sql(`BEGIN;
      ALTER TABLE core.app_records DISABLE TRIGGER record_guard_archived;
      DELETE FROM core.app_records WHERE tenant_id='tenant-a' AND id=${q(record.id)};
      ALTER TABLE core.app_records ENABLE TRIGGER record_guard_archived;
      COMMIT;`);
  }
});

test("cursors carry the query, caller and generation and fail closed", async () => {
  const term = `cursor-${prefix}`;
  for (const code of [`${term}-1`, `${term}-2`]) {
    await jsonResult(await api(`/v2/data/${collection}`, owner, {
      method: "POST", body: { data: { code } }, headers: { "Idempotency-Key": randomUUID() },
    }), 201);
  }
  await waitUntil("both cursor records", async () => (await hits(owner, term)).length >= 2);
  const page = await jsonResult(await api(`/v1/search?q=${encodeURIComponent(term)}&limit=1`, owner), 200);
  assert.equal(page.items.length, 1);
  assert.ok(page.nextCursor);
  const next = await api(`/v1/search?q=${encodeURIComponent(term)}&limit=1&cursor=${page.nextCursor}`, owner);
  assert.equal(next.status, 200);
  assert.equal((await next.json()).items.length, 1);
  // The same cursor with a different query is not valid.
  const foreign = await api(`/v1/search?q=unrelated&cursor=${page.nextCursor}`, owner);
  assert.equal(foreign.status, 400);
  assert.equal((await foreign.json()).error, "invalid_cursor");
  // Bumping the generation expires every outstanding cursor.
  await sql(`UPDATE app_private.search_generations SET generation=gen_random_uuid() WHERE tenant_id='tenant-a';`);
  const stale = await api(`/v1/search?q=${encodeURIComponent(term)}&limit=1&cursor=${page.nextCursor}`, owner);
  assert.equal(stale.status, 400);
  assert.equal((await stale.json()).error, "invalid_cursor");
});

test("implemented operations match the observed HTTP contract", async () => {
  await verifyContracts("search");
});
