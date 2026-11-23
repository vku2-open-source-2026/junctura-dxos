// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { logicalRequestDigest } from "../src/modules/data/records.mjs";
import { contractFetch, verifyContracts } from "./contract.mjs";

import { base, issuer, recordTestSupport } from "./record-test-support.mjs";
const strict = process.env.STRICT_RECORD_WRITES === "true";
const prefix = `rec_${randomBytes(6).toString("hex")}`;
const support = recordTestSupport(prefix);
const { sql, q: quoted } = support;
const dataPath = collection => `/v2/data/${collection}`;
const key = () => ({ "Idempotency-Key": randomUUID() });
const headersFor = response => ({ "If-Match": response.headers.get("etag") });
const collection = label => `${prefix}_${label}`;
let owner, recipient;

async function request(method, path, { as = owner, body, headers = {}, observe = false, signal } = {}) {
  return (observe ? contractFetch : fetch)(base + path, { method, signal: signal ?? AbortSignal.timeout(10000),
    headers: { Authorization: `Bearer ${as.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
}

function schema() {
  return { schema: { type: "object", required: ["code"], properties: {
    code: { type: "string" }, quantity: { type: "number", minimum: -100 },
    timestamp: { type: "string", format: "date-time" }, notes: { type: "string" }, description: { type: "string" },
    nested: { type: "array", items: { required: ["a/~"], properties: { "a/~": { type: "string", minLength: 2 } } } },
  } }, indexed: ["code", "quantity", "timestamp", "description"], uniqueKey: "code", sensitive: ["notes"],
  searchable: ["notes"], auditActions: [{ action: "record.viewed", sensitivity: "restricted", visibleToSubject: true }] };
}

async function jsonResult(response, status) {
  assert.equal(response.status, status);
  const body = await response.json();
  if (status >= 400) assert.ok(response.headers.get("x-request-id").split(",").map(value => value.trim()).includes(body.requestId));
  return body;
}

const register = (name, body = schema(), options = {}) => request("PUT", `/v2/data-schemas/${name}`, { ...options, body });
const create = (name, data, headers = key(), options = {}) => request("POST", dataPath(name), { ...options, body: { data }, headers });
const statuses = results => results.map(result => result.status).sort((a, b) => a - b);

before(async () => {
  owner = await support.createBackend("writer");
  recipient = await support.createBackend("recipient");
});

after(async () => {
  try {
    for (const app of [owner, recipient].filter(Boolean)) {
      await sql(`DELETE FROM app_private.idempotency_results WHERE tenant_id = 'tenant-a'
        AND caller_scope = sha256(convert_to(jsonb_build_array(${quoted(issuer)},'${app.subject}',
          '${app.clientId}','${app.appId}'::uuid,NULL)::text,'UTF8'));`);
    }
  } finally {
    await support.cleanup([owner, recipient], []);
  }
});

test("schema registration, replay, compatibility, sharing and grant redaction through HTTP", async () => {
  const name = collection("registered");
  const declaration = schema();
  const invalidPattern = schema();
  invalidPattern.schema.properties.code.pattern = "[z-a]";
  assert.equal((await jsonResult(await register(name, invalidPattern), 400)).error, "invalid_schema");
  const setup = await jsonResult(await register(name, declaration, { observe: true }), 200);
  assert.deepEqual(setup.auditActions, declaration.auditActions);
  const retryKey = key();
  const data = { code: "A", quantity: 3, notes: "private", description: "é".repeat(6000),
    timestamp: "2024-02-29T23:01:00-02:30", nested: [{ "a/~": "ok" }] };
  const [first, second] = await Promise.all([
    create(name, data, retryKey, { observe: true }),
    create(name, Object.fromEntries(Object.entries(data).reverse()), retryKey),
  ]);
  const created = await jsonResult(first, 201);
  assert.equal(created.version, 1);
  assert.deepEqual(await jsonResult(second, 201), created);
  assert.equal(first.headers.get("etag"), second.headers.get("etag"));
  const item = `${dataPath(name)}/${created.id}`;
  const fetched = await request("GET", item + "?limit=1", { observe: true });
  assert.equal(fetched.headers.get("etag"), first.headers.get("etag"));
  const read = await jsonResult(fetched, 200);
  assert.deepEqual(read.data, data);
  assert.equal(read.version, strict ? 1 : undefined);
  assert.equal(await sql(`SELECT datetime_value AT TIME ZONE 'UTC' FROM app_private.record_field_values WHERE record_id = '${created.id}' AND field = 'timestamp';`), "2024-03-01 01:31:00");
  assert.equal((await jsonResult(await create(name, { ...data, code: "B" }, retryKey), 422)).error, "idempotency_key_reused");
  const invalid = await jsonResult(await create(name, { code: "B", nested: [{ "a/~": "x" }] }), 422);
  assert.deepEqual(invalid.issues, [{ path: "/data/nested/0/a~1~0", keyword: "minLength" }]);
  assert.equal((await jsonResult(await create(name, { code: "B", timestamp: "2023-02-29T10:00:00Z" }), 422)).issues[0].keyword, "format");
  assert.equal((await jsonResult(await register(name, { ...declaration, schema: { ...declaration.schema, required: ["missing"] },
    uniqueKey: null, auditActions: [] }), 409)).error, "resource_conflict");
  const { auditActions, ...unchanged } = declaration;
  assert.deepEqual((await jsonResult(await register(name, unchanged), 200)).auditActions, auditActions);
  assert.deepEqual((await jsonResult(await register(name, { ...unchanged, auditActions: [] }), 200)).auditActions, []);
  assert.equal((await request("GET", item)).headers.get("etag"), first.headers.get("etag"));

  const legacy = await create(name, { code: "legacy" }, {});
  if (strict) assert.equal(legacy.status, 400);
  else {
    assert.ok(legacy.headers.get("etag"));
    const legacyRecord = await jsonResult(legacy, 201);
    assert.equal(Object.hasOwn(legacyRecord, "version"), false);
    const legacyPath = `${dataPath(name)}/${legacyRecord.id}`;
    assert.equal((await request("PATCH", legacyPath, { body: { data: { code: "updated" } } })).status, 200);
    assert.equal((await request("DELETE", legacyPath)).status, 204);
  }

  assert.equal((await request("GET", item, { as: recipient })).status, 404);
  await sql(`INSERT INTO app_private.principals (tenant_id, issuer, subject, management_client, permissions)
    VALUES ('tenant-a',${quoted(issuer)},'${recipient.subject}','${recipient.clientId}',ARRAY['audit.read']);`);
  assert.equal((await request("GET", item, { as: recipient })).status, 404);
  await sql(`INSERT INTO app_private.record_read_grants VALUES ('tenant-a',${quoted(issuer)},'${recipient.subject}','${recipient.clientId}','${owner.appId}');`);
  const management = await request("GET", item, { as: recipient });
  assert.equal(management.headers.get("etag"), null);
  const { notes, ...masked } = data;
  assert.deepEqual((await jsonResult(management, 200)).data, masked);
  await sql(`DELETE FROM app_private.record_read_grants WHERE tenant_id = 'tenant-a' AND owner_app_id = '${owner.appId}';`);
  const share = await request("POST", "/v2/resource-shares", { body: { resourceType: "record", resourceId: created.id,
    granteeAppId: recipient.appId, action: "read", expiresAt: new Date(Date.now() + 120000).toISOString() } });
  assert.equal(share.status, 201);
  const shared = await request("GET", item, { as: recipient });
  assert.equal(shared.headers.get("etag"), null);
  assert.deepEqual((await jsonResult(shared, 200)).data, data);
  assert.equal((await request("PATCH", item, { as: recipient, body: { data }, headers: headersFor(first) })).status, 404);
  assert.equal((await request("DELETE", item, { headers: headersFor(first) })).status, 204);
  assert.equal(await sql(`SELECT revoked FROM app_private.resource_shares WHERE resource_id = '${created.id}';`), "t");
  await sql(`UPDATE app_private.applications SET state = 'suspended' WHERE app_id = '${owner.appId}';`);
  try {
    assert.equal((await create(name, data, retryKey)).status, 403);
    assert.equal((await request("GET", item)).status, strict ? 404 : 403);
  } finally { await sql(`UPDATE app_private.applications SET state = 'active' WHERE app_id = '${owner.appId}';`); }
});

test("registering a schema rebuilds projections and can swap existing unique keys", async () => {
  const name = collection("projection");
  const firstData = { code: "A", alternate: "B", quantity: 1, timestamp: "2024-02-29T23:01:00-02:30" };
  const secondData = { code: "B", alternate: "A", quantity: 2 };
  const first = await create(name, firstData);
  const second = await create(name, secondData);
  const records = [await jsonResult(first, 201), await jsonResult(second, 201)];
  const rows = `tenant_id = 'tenant-a' AND owner_app_id = '${owner.appId}' AND collection = '${name}'`;
  const declaration = schema();
  assert.equal((await register(name, declaration)).status, 200);
  assert.equal(await sql(`SELECT count(*) FROM app_private.record_field_values WHERE ${rows} AND field = 'quantity'`), "2");

  declaration.schema.properties.alternate = { type: "string" };
  declaration.schema.required.push("alternate");
  declaration.uniqueKey = "alternate";
  declaration.indexed = ["alternate", "timestamp"];
  assert.equal((await register(name, declaration)).status, 200);
  assert.equal(await sql(`SELECT data->>'code', unique_key_value FROM core.app_records WHERE ${rows}
    ORDER BY data->>'code'`), "A|B\nB|A");
  assert.equal(await sql(`SELECT r.data->>'code', f.field, f.text_value, f.datetime_value AT TIME ZONE 'UTC'
    FROM core.app_records r JOIN app_private.record_field_values f
      USING (tenant_id, owner_app_id, collection) WHERE ${rows} AND f.record_id = r.id
    ORDER BY r.data->>'code', f.field`), "A|alternate|B|\nA|timestamp||2024-03-01 01:31:00\nB|alternate|A|");
  const fetched = await request("GET", `${dataPath(name)}/${records[0].id}`);
  assert.equal(fetched.headers.get("etag"), first.headers.get("etag"));
  assert.deepEqual((await jsonResult(fetched, 200)).data, firstData);
});

test("concurrent duplicate keys and quotas preserve counters and replay finalized errors", async () => {
  const name = collection("contention");
  assert.equal((await register(name)).status, 200);
  const duplicateKeys = [key(), key()];
  const duplicate = headers => create(name, { code: "same" }, headers, { observe: true });
  let results = await Promise.all(duplicateKeys.map(duplicate));
  assert.deepEqual(statuses(results), [201, 409]);
  const conflictIndex = results.findIndex(result => result.status === 409);
  const conflict = await jsonResult(results[conflictIndex], 409);
  assert.equal(conflict.error, strict ? "unique_key_conflict" : "conflict");
  if (!strict) assert.deepEqual(conflict.details, { code: "unique_key_conflict" });
  const created = results[1 - conflictIndex];
  const { id } = await jsonResult(created, 201);
  const item = `${dataPath(name)}/${id}`;
  await sql(`UPDATE app_private.record_collections SET max_records = 2 WHERE owner_app_id = '${owner.appId}' AND collection = '${name}';`);
  const quotaWrites = ["second", "third"].map(code => ({ code, headers: key() }));
  const quotaWrite = ({ code, headers }) => create(name, { code }, headers);
  results = await Promise.all(quotaWrites.map(quotaWrite));
  assert.deepEqual(statuses(results), [201, 429]);
  const quotaIndex = results.findIndex(result => result.status === 429);
  const quota = { resource: "collectionRecords", limit: 2, used: 2 };
  assert.deepEqual((await jsonResult(results[quotaIndex], 429)).quota, quota);
  assert.equal(await sql(`SELECT record_count FROM app_private.record_collections WHERE owner_app_id = '${owner.appId}' AND collection = '${name}';`), "2");
  // The planner may pick any index for a two-row table; what matters is that
  // a unique-key lookup is index-backed and the unique index exists.
  await sql(`ANALYZE core.app_records; SET enable_seqscan = off; EXPLAIN (COSTS OFF) SELECT id FROM core.app_records
    WHERE tenant_id='tenant-a' AND owner_app_id='${owner.appId}' AND collection='${name}' AND unique_key_value='same';`)
    .then(plan => { assert.match(plan, /Index (Only )?Scan|Bitmap Index Scan/); assert.doesNotMatch(plan, /Seq Scan/); });
  assert.match(await sql(`SELECT indexdef FROM pg_indexes WHERE schemaname='core' AND indexname='app_records_unique_key_idx';`),
    /UNIQUE INDEX .*unique_key_value/);
  const deleteHeaders = { ...headersFor(created), ...key() };
  assert.equal((await request("DELETE", item, { headers: deleteHeaders })).status, 204);
  assert.equal((await request("DELETE", item, { headers: deleteHeaders })).status, 204);
  assert.equal((await jsonResult(await duplicate(duplicateKeys[conflictIndex]), 409)).error, conflict.error);
  assert.deepEqual((await jsonResult(await quotaWrite(quotaWrites[quotaIndex]), 429)).quota, quota);
});

test("an HTTP retry recovers a committed command whose receipt never reached the caller", async () => {
  const name = collection("lost_receipt");
  const method = "POST";
  const body = { data: { quantity: 3 } };
  const headers = key();
  const claims = { tenant_id: "tenant-a", iss: issuer, sub: owner.subject, client_id: owner.clientId, resource_writer: true };
  const payload = { collection: name, method, path: dataPath(name), body, requestKey: headers["Idempotency-Key"],
    digest: logicalRequestDigest({ body }), legacyBody: false };
  // Run the same RPC without an HTTP response, then recover it via the gateway.
  await sql(`SET ROLE junctura_record_api; SELECT set_config('request.jwt.claims',${quoted(JSON.stringify(claims))},false);
    DO $commit$ BEGIN PERFORM core.record_command('create',${quoted(JSON.stringify(payload))}); END $commit$;`);
  const retry = await create(name, body.data, headers);
  const record = await jsonResult(retry, 201);
  assert.equal(await sql(`SELECT id FROM core.app_records WHERE collection = '${name}' AND owner_app_id = '${owner.appId}';`),
    record.id);
  assert.deepEqual(record.data, body.data);
});

test("compare-and-swap, atomic increments and live leases serialize on one record", async () => {
  const name = collection("conditional");
  assert.equal((await register(name)).status, 200);
  const created = await create(name, { code: "item", quantity: 1 });
  const { id } = await jsonResult(created, 201);
  const item = `${dataPath(name)}/${id}`;
  const attempt = () => request("PATCH", item, { body: { data: { code: "item", quantity: 1 } },
    headers: headersFor(created), observe: true });
  assert.deepEqual(statuses(await Promise.all([attempt(), attempt()])), [200, 412]);
  const initialTag = (await request("GET", item)).headers.get("etag");
  const increment = { operations: [{ op: "increment", field: "quantity", by: -1, min: 0 }] };
  const modify = headers => request("PATCH", item, { body: increment, headers, observe: true });
  const firstKey = key(), secondKey = key();
  const decrements = await Promise.all([modify(firstKey), modify(secondKey)]);
  assert.deepEqual(statuses(decrements), [200, 409]);
  const winner = decrements.findIndex(response => response.status === 200);
  const changed = await jsonResult(decrements[winner], 200);
  assert.equal(changed.version, 3);
  assert.equal(changed.data.quantity, 0);
  assert.deepEqual(await jsonResult(await modify([firstKey, secondKey][winner]), 200), changed);
  const limit = await jsonResult(decrements[1 - winner], 409);
  assert.equal(limit.error, strict ? "limit_exceeded" : "conflict");
  if (strict) assert.equal(limit.field, "quantity");
  else assert.deepEqual(limit.details, { code: "limit_exceeded", field: "quantity" });
  const staleKey = key();
  assert.equal((await modify({ ...staleKey, "If-Match": initialTag })).status, 412);
  assert.equal((await jsonResult(await modify(staleKey), 422)).error, "idempotency_key_reused");

  const endpoint = item + ":lock";
  const acquire = (body, headers = key()) => request("POST", endpoint, { body, headers, observe: true });
  const release = lockId => request("DELETE", endpoint, { headers: { "Lock-Id": lockId }, observe: true });
  const leaseTag = (await request("GET", item)).headers.get("etag");
  const lock = await jsonResult(await acquire({ ttlSeconds: 60 }), 200);
  assert.deepEqual(await jsonResult(await acquire({ ttlSeconds: 90 }), 200), lock);
  const renewalKey = key();
  const renewed = await jsonResult(await acquire({ ttlSeconds: 120, lockId: lock.lockId }, renewalKey), 200);
  assert.equal(renewed.lockId, lock.lockId);
  assert.ok(Date.parse(renewed.lockedUntil) > Date.parse(lock.lockedUntil));
  assert.deepEqual(await jsonResult(await acquire({ ttlSeconds: 120, lockId: lock.lockId }, renewalKey), 200), renewed);
  assert.equal((await request("GET", item)).headers.get("etag"), leaseTag);
  assert.equal((await release(randomUUID())).status, 409);

  await sql(`UPDATE app_private.record_locks SET holder_scope = sha256('former-enrollment'::bytea),
    locked_by = 'Former holder' WHERE record_id = '${id}';`);
  const blockedHeaders = { ...key(), "If-Match": leaseTag };
  const blockedWrite = () => request("PATCH", item, { body: { data: { code: "item" } }, headers: blockedHeaders });
  const blocked = await blockedWrite();
  assert.equal((await jsonResult(blocked, 423)).lockedBy, "Former holder");
  assert.equal((await request("DELETE", item)).status, 423);
  assert.deepEqual(await jsonResult(await modify([firstKey, secondKey][winner]), 200), changed);
  await sql(`UPDATE app_private.record_locks SET locked_until = clock_timestamp() - interval '1 second' WHERE record_id = '${id}';`);
  const retried = await blockedWrite();
  assert.equal(retried.status, 200);
  assert.equal((await release(lock.lockId)).status, 204);
  assert.equal((await release(lock.lockId)).status, 204);

  const bare = await create(collection("schemaless"), { any: "value" });
  const bareItem = `${dataPath(collection("schemaless"))}/${(await jsonResult(bare, 201)).id}`;
  let latest = bare;
  if (strict) {
    const replaceKey = key();
    const body = { data: { updated: true } };
    assert.equal((await request("PATCH", bareItem, { body, headers: replaceKey, observe: true })).status, 428);
    latest = await request("PATCH", bareItem, { body, headers: { ...replaceKey, ...headersFor(bare) }, observe: true });
    assert.equal((await jsonResult(latest, 200)).version, 2);
  }
  const deleteKey = key();
  const noMatch = await request("DELETE", bareItem, { headers: deleteKey });
  assert.equal(noMatch.status, strict ? 428 : 204);
  if (strict) assert.equal((await request("DELETE", bareItem, { headers: { ...deleteKey, ...headersFor(latest) } })).status, 204);
  assert.equal((await request("DELETE", item, { headers: headersFor(retried), observe: true })).status, 204);
});

test("unique-key upserts serialize with creates and reject tags from a previous incarnation", async () => {
  const name = collection("upsert");
  assert.equal((await register(name)).status, 200);
  const item = value => `${dataPath(name)}/by-key/${value}`;
  const upsert = (value, data, headers = key()) => request("PUT", item(value), { body: { data }, headers, observe: true });
  const badRequestKey = key();
  assert.equal((await upsert("Corrected", { code: "wrong" }, badRequestKey)).status, 400);
  assert.equal((await upsert("Corrected", { code: "Corrected" }, badRequestKey)).status, 201);
  const payload = { code: "First" };
  const [one, other] = await Promise.all([upsert("First", payload), upsert("First", payload)]);
  assert.deepEqual(statuses([one, other]), [201, 428]);
  const first = one.status === 201 ? one : other;
  const { id } = await jsonResult(first, 201);
  const itemPath = `${dataPath(name)}/${id}`;
  const refreshed = await upsert("First", { ...payload, quantity: 1 }, { ...key(), ...headersFor(first) });
  assert.equal((await jsonResult(refreshed, 200)).version, 2);
  assert.equal((await upsert("first", { code: "first" })).status, 201);
  assert.equal((await request("DELETE", itemPath, { headers: headersFor(refreshed) })).status, 204);
  assert.equal((await upsert("First", payload, { ...key(), ...headersFor(first) })).status, 412);
  const recreated = await upsert("First", payload);
  assert.equal((await jsonResult(recreated, 201)).version, 1);
  assert.notEqual(recreated.headers.get("etag"), first.headers.get("etag"));
  assert.equal((await upsert("First", payload, { ...key(), ...headersFor(first) })).status, 412);

  await sql(`SET ROLE junctura_app_owner; SELECT set_config('request.jwt.claims','{"tenant_id":"tenant-a"}',false);
    SELECT app_private.record_write('create','${owner.appId}','${name}','${id}','{"code":"ReusedId"}',NULL,false);`);
  const reused = await request("GET", itemPath);
  assert.equal(reused.status, 200);
  assert.notEqual(reused.headers.get("etag"), first.headers.get("etag"));
  assert.equal((await request("PATCH", itemPath, { body: { data: { code: "ReusedId" } }, headers: headersFor(first) })).status, 412);

  const races = await Promise.all([upsert("Race", { code: "Race" }), create(name, { code: "Race" })]);
  assert.equal(races.filter(result => result.status === 201).length, 1);
  assert.ok([409, 428].includes(races.find(result => result.status !== 201).status));
  assert.equal(await sql(`SELECT count(*) FROM core.app_records WHERE owner_app_id = '${owner.appId}'
    AND collection = '${name}' AND unique_key_value = 'Race';`), "1");

  const expiryName = collection("expired_receipt");
  const retry = key();
  const temporary = await jsonResult(await create(expiryName, {}, retry), 201);
  await sql(`UPDATE app_private.idempotency_results SET expires_at = clock_timestamp() - interval '1 second'
    WHERE key = '${retry["Idempotency-Key"]}';`);
  assert.notEqual((await jsonResult(await create(expiryName, {}, retry), 201)).id, temporary.id);
});

test("batch locks collections in sorted order and rolls back rows, projections and counts on failure", async () => {
  const a = collection("batch_a");
  const b = collection("batch_b");
  for (const name of [a, b]) assert.equal((await register(name)).status, 200);
  const createItem = (name, data) => ({ op: "create", collection: name, data });
  const send = (operations, headers = key()) => request("POST", "/v2/data:batch", { body: { operations }, headers, observe: true });

  const invalid = [createItem(a, { code: "discard" }), createItem(b, { nested: [{}], code: "invalid" })];
  const failedKey = key();
  const failure = await jsonResult(await send(invalid, failedKey), 422);
  assert.deepEqual(failure.issues, [{ path: "/operations/1/data/nested/0/a~1~0", keyword: "required" }]);
  const survivorCount = await sql(`SELECT (SELECT count(*) FROM core.app_records WHERE collection = '${a}' AND owner_app_id = '${owner.appId}'),
    (SELECT count(*) FROM app_private.record_field_values WHERE collection = '${a}' AND owner_app_id = '${owner.appId}'),
    (SELECT record_count FROM app_private.record_collections WHERE collection = '${a}' AND owner_app_id = '${owner.appId}'),
    (SELECT status FROM app_private.idempotency_results WHERE key = '${failedKey["Idempotency-Key"]}');`);
  assert.equal(survivorCount, "0|0|0|422");
  await register(b, { ...schema(), schema: { ...schema().schema, properties: { ...schema().schema.properties, nested: {} } } });
  assert.equal((await send(invalid, failedKey)).status, 422);

  const firstOperations = [createItem(a, { code: "A", quantity: 1 }), createItem(b, { code: "B", quantity: 1 })];
  const secondOperations = [createItem(b, { code: "C" }), createItem(a, { code: "D" })];
  const firstKey = key();
  const [first, second] = await Promise.all([send(firstOperations, firstKey), send(secondOperations)]);
  const { results } = await jsonResult(first, 200);
  assert.deepEqual(results.map(result => result.version), [1, 1]);
  assert.deepEqual(await jsonResult(await send(firstOperations, firstKey), 200), { results });
  assert.equal((await jsonResult(second, 200)).results.length, 2);
  const [record] = results;
  const item = `${dataPath(a)}/${record.id}`;
  const current = await request("GET", item);
  const increment = { op: "increment", collection: a, id: record.id, operations: [{ op: "increment", field: "quantity", by: 1 }] };
  const deleteWithoutMatch = { op: "delete", collection: a, id: record.id };
  assert.equal((await send([deleteWithoutMatch])).status, 428);
  const increments = await jsonResult(await send([increment, increment]), 200);
  assert.deepEqual(increments.results.map(result => result.version), [2, 3]);
  const invalidIncrement = { ...increment, operations: [{ op: "increment", field: "quantity", by: -104 }] };
  const resultViolation = await jsonResult(await send([createItem(b, { code: "rolled_back" }), invalidIncrement]), 422);
  assert.deepEqual(resultViolation.issues, [{ path: "/operations/1/data/quantity", keyword: "minimum" }]);
  assert.equal((await jsonResult(await request("GET", item), 200)).data.quantity, 3);
  assert.equal((await send([{ ...deleteWithoutMatch, ifMatch: current.headers.get("etag") }])).status, 412);
  const validDelete = { ...deleteWithoutMatch, ifMatch: (await request("GET", item)).headers.get("etag") };
  assert.deepEqual((await jsonResult(await send([validDelete]), 200)).results,
    [{ op: "delete", id: record.id, version: null }]);
});

test("implemented record operations match the observed HTTP contract", async () => {
  await verifyContracts("records");
});
