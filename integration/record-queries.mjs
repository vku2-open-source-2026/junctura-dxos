// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { jsonResult, recordTestSupport } from "./record-test-support.mjs";
import { verifyContracts } from "./contract.mjs";

const prefix = `rq_${randomBytes(6).toString("hex")}`;
const support = recordTestSupport(prefix);
const { api, sql, q } = support;
const collection = `${prefix}_main`;
const prefixCollection = `${prefix}_prefix`;
const planCollection = `${prefix}_plan`;
const thousandCollection = `${prefix}_thousand`;
const sensitiveCollection = `${prefix}_sensitive`;
const concurrentCollection = `${prefix}_concurrent`;
const groups = `${prefix}_groups`;
let owner, recipient, grantOnly;
let records = [];

const fieldSchema = field => {
  if (field === "quantity") return { type: "number" };
  if (field === "count") return { type: "integer" };
  if (field === "createdOn") return { type: "string", format: "date-time" };
  return { type: "string" };
};
const schema = indexed => ({
  schema: { type: "object", required: ["code"], properties: Object.fromEntries(indexed.map(field => [field, fieldSchema(field)])) },
  indexed, uniqueKey: "code", searchable: [], sensitive: indexed.includes("notes") ? ["notes"] : [],
});
const syncCount = collectionName => sql(`UPDATE app_private.record_collections SET record_count =
  (SELECT count(*) FROM core.app_records r WHERE r.tenant_id='tenant-a' AND r.owner_app_id=${q(owner.appId)} AND r.collection=${q(collectionName)})
  WHERE tenant_id='tenant-a' AND owner_app_id=${q(owner.appId)} AND collection=${q(collectionName)};`);

before(async () => {
  owner = await support.createBackend("query-owner");
  recipient = await support.createBackend("query-recipient");
  grantOnly = await support.createBackend("query-grant-only", { enroll: false });
  assert.equal((await api(`/v2/data-schemas/${collection}`, owner, {
    method: "PUT", body: schema(["code", "status", "quantity", "count", "createdOn", "created_at", "notes"]),
  })).status, 200);
  records = Array.from({ length: 105 }, (_, index) => ({
    id: randomUUID(),
    createdAt: `2030-01-${String((index % 28) + 1).padStart(2, "0")}T${String(index % 24).padStart(2, "0")}:00:00${index % 2 ? "Z" : "+07:00"}`,
    data: {
      code: `C-${String(index).padStart(3, "0")}`,
      status: index % 3 === 0 ? "open" : "closed",
      ...(index % 7 === 0 ? {} : { quantity: index % 9 }),
      count: index % 5,
      createdOn: `2030-02-${String((index % 28) + 1).padStart(2, "0")}T${String(index % 24).padStart(2, "0")}:30:00${index % 2 ? "Z" : "+07:00"}`,
      created_at: `2030-01-${String((index % 28) + 1).padStart(2, "0")}T${String(index % 24).padStart(2, "0")}:00:00${index % 2 ? "Z" : "+07:00"}`,
      notes: `note-${index}`,
    },
  }));
  const values = records.map(item => `('tenant-a',${q(owner.appId)},${q(item.id)},${q(collection)},${q(JSON.stringify(item.data))}::jsonb,${q(item.createdAt)},${q(item.data.code)})`).join(",");
  await sql(`INSERT INTO core.app_records (tenant_id,owner_app_id,id,collection,data,created_at,unique_key_value) VALUES ${values};
    SELECT app_private.record_replace_projection(r) FROM core.app_records r
      WHERE r.tenant_id='tenant-a' AND r.owner_app_id=${q(owner.appId)} AND r.collection=${q(collection)};`);
  await syncCount(collection);

  assert.equal((await api(`/v2/data-schemas/${prefixCollection}`, owner, { method: "PUT", body: schema(["code", "tag"]) })).status, 200);
  await sql(`INSERT INTO core.app_records (tenant_id,owner_app_id,id,collection,data,created_at,unique_key_value) VALUES
    ('tenant-a',${q(owner.appId)},gen_random_uuid(),${q(prefixCollection)},jsonb_build_object('code','T-256','tag',repeat('a',256)),now(),'T-256'),
    ('tenant-a',${q(owner.appId)},gen_random_uuid(),${q(prefixCollection)},jsonb_build_object('code','T-257','tag',repeat('a',257)),now(),'T-257'),
    ('tenant-a',${q(owner.appId)},gen_random_uuid(),${q(prefixCollection)},jsonb_build_object('code','T-OTHER','tag',repeat('b',257)),now(),'T-OTHER');
    SELECT app_private.record_replace_projection(r) FROM core.app_records r
      WHERE r.tenant_id='tenant-a' AND r.owner_app_id=${q(owner.appId)} AND r.collection=${q(prefixCollection)};`);
  await syncCount(prefixCollection);

  assert.equal((await api(`/v2/data-schemas/${planCollection}`, owner, { method: "PUT", body: schema(["code", "tag"]) })).status, 200);
  await sql(`INSERT INTO core.app_records (tenant_id,owner_app_id,id,collection,data,created_at,unique_key_value)
    SELECT 'tenant-a',${q(owner.appId)},gen_random_uuid(),${q(planCollection)},
      jsonb_build_object('code','P-'||g,'tag','p-'||lpad(g::text,4,'0')),now(),'P-'||g
    FROM generate_series(1,2000) g;
    SELECT app_private.record_replace_projection(r) FROM core.app_records r
      WHERE r.tenant_id='tenant-a' AND r.owner_app_id=${q(owner.appId)} AND r.collection=${q(planCollection)};`);
  await syncCount(planCollection);

  assert.equal((await api(`/v2/data-schemas/${thousandCollection}`, owner, { method: "PUT", body: schema(["code", "bucket"]) })).status, 200);
  await sql(`INSERT INTO core.app_records (tenant_id,owner_app_id,id,collection,data,created_at,unique_key_value)
    SELECT 'tenant-a',${q(owner.appId)},gen_random_uuid(),${q(thousandCollection)},
      jsonb_build_object('code','K-'||g,'bucket','B-'||g),now(),'K-'||g
    FROM generate_series(1,1000) g;
    SELECT app_private.record_replace_projection(r) FROM core.app_records r
      WHERE r.tenant_id='tenant-a' AND r.owner_app_id=${q(owner.appId)} AND r.collection=${q(thousandCollection)};`);
  await syncCount(thousandCollection);

  assert.equal((await api(`/v2/data-schemas/${sensitiveCollection}`, owner, { method: "PUT", body: schema(["code", "status"]) })).status, 200);
  await sql(`INSERT INTO core.app_records (tenant_id,owner_app_id,id,collection,data,created_at,unique_key_value)
    SELECT 'tenant-a',${q(owner.appId)},gen_random_uuid(),${q(sensitiveCollection)},
      jsonb_build_object('code','S-'||g,'status','open'),now(),'S-'||g
    FROM generate_series(1,5) g;
    SELECT app_private.record_replace_projection(r) FROM core.app_records r
      WHERE r.tenant_id='tenant-a' AND r.owner_app_id=${q(owner.appId)} AND r.collection=${q(sensitiveCollection)};`);
  await syncCount(sensitiveCollection);

  assert.equal((await api(`/v2/data-schemas/${concurrentCollection}`, owner, { method: "PUT", body: schema(["code", "status"]) })).status, 200);
  await sql(`INSERT INTO core.app_records (tenant_id,owner_app_id,id,collection,data,created_at,unique_key_value)
    SELECT 'tenant-a',${q(owner.appId)},gen_random_uuid(),${q(concurrentCollection)},
      jsonb_build_object('code','Q-'||g,'status',CASE WHEN g % 2 = 0 THEN 'open' ELSE 'closed' END),now(),'Q-'||g
    FROM generate_series(1,400) g;
    SELECT app_private.record_replace_projection(r) FROM core.app_records r
      WHERE r.tenant_id='tenant-a' AND r.owner_app_id=${q(owner.appId)} AND r.collection=${q(concurrentCollection)};`);
  await syncCount(concurrentCollection);

  await sql(`INSERT INTO app_private.principals (tenant_id,issuer,subject,management_client,permissions)
    VALUES ('tenant-a',${q(`${process.env.PUBLIC_URL ?? "http://127.0.0.1:8080"}/identity/realms/junctura`)},${q(recipient.subject)},${q(recipient.clientId)},ARRAY['audit.read']);
    INSERT INTO app_private.record_read_grants
    VALUES ('tenant-a',${q(`${process.env.PUBLIC_URL ?? "http://127.0.0.1:8080"}/identity/realms/junctura`)},${q(recipient.subject)},${q(recipient.clientId)},${q(owner.appId)});
    INSERT INTO app_private.principals (tenant_id,issuer,subject,management_client,permissions)
    VALUES ('tenant-a',${q(`${process.env.PUBLIC_URL ?? "http://127.0.0.1:8080"}/identity/realms/junctura`)},${q(grantOnly.subject)},${q(grantOnly.clientId)},ARRAY['audit.read']);
    INSERT INTO app_private.record_read_grants
    VALUES ('tenant-a',${q(`${process.env.PUBLIC_URL ?? "http://127.0.0.1:8080"}/identity/realms/junctura`)},${q(grantOnly.subject)},${q(grantOnly.clientId)},${q(owner.appId)});`);
});

after(async () => {
  await support.cleanup([owner, recipient, grantOnly]);
});

const listPath = (collectionName, entries) => {
  const query = new URLSearchParams(entries);
  return `/v2/data/${collectionName}${query.size ? `?${query}` : ""}`;
};

test("seeded records keep collection metadata counts in sync", async () => {
  for (const [collectionName, expected] of [
    [collection, records.length], [prefixCollection, 3], [planCollection, 2000], [thousandCollection, 1000], [sensitiveCollection, 5],
  ]) {
    const count = await sql(`SELECT record_count FROM app_private.record_collections
      WHERE tenant_id='tenant-a' AND owner_app_id=${q(owner.appId)} AND collection=${q(collectionName)};`);
    assert.equal(Number(count), expected, collectionName);
  }
});

test("filtered lists page with stable order, sort ties, missing values last and an opaque cursor", async () => {
  const expected = records.filter(item => item.data.status === "open").slice().sort((left, right) => {
    const leftQuantity = left.data.quantity;
    const rightQuantity = right.data.quantity;
    if (leftQuantity === undefined && rightQuantity === undefined) return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    if (leftQuantity === undefined) return 1;
    if (rightQuantity === undefined) return -1;
    return leftQuantity - rightQuantity || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  });
  const seen = [];
  let cursor = null;
  do {
    const entries = [["limit", "10"], ["where[status]", "eq:\"open\""], ["sort", "quantity.asc"]];
    if (cursor) entries.push(["cursor", cursor]);
    const page = await jsonResult(await api(listPath(collection, entries), owner), 200);
    assert.ok(page.nextCursor === null || /^[A-Za-z0-9_-]+$/.test(page.nextCursor));
    seen.push(...page.items.map(item => item.id));
    cursor = page.nextCursor;
  } while (cursor !== null);
  assert.deepEqual(seen, expected.map(item => item.id));
  assert.equal(new Set(seen).size, expected.length);
});

test("descending field order keeps the same tie-break and null placement", async () => {
  const expected = records.slice().sort((left, right) => {
    const leftQuantity = left.data.quantity;
    const rightQuantity = right.data.quantity;
    if (leftQuantity === undefined && rightQuantity === undefined) return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
    if (leftQuantity === undefined) return 1;
    if (rightQuantity === undefined) return -1;
    return rightQuantity - leftQuantity || (left.id < right.id ? 1 : left.id > right.id ? -1 : 0);
  });
  const seen = [];
  let cursor = null;
  do {
    const entries = [["limit", "9"], ["sort", "quantity.desc"]];
    if (cursor) entries.push(["cursor", cursor]);
    const page = await jsonResult(await api(listPath(collection, entries), owner), 200);
    seen.push(...page.items.map(item => item.id));
    cursor = page.nextCursor;
  } while (cursor !== null);
  assert.deepEqual(seen, expected.map(item => item.id));
});

test("where operators, aggregate counts and UTC day groups match the seeded records", async () => {
  const prefixPage = await jsonResult(await api(listPath(collection, [["where[code]", "prefix:\"C-01\""], ["sort", "code.asc"]]), owner), 200);
  assert.deepEqual(prefixPage.items.map(item => item.data.code), ["C-010", "C-011", "C-012", "C-013", "C-014", "C-015", "C-016", "C-017", "C-018", "C-019"]);
  const range = await jsonResult(await api(listPath(collection, [["where[quantity]", "gte:2"], ["limit", "100"]]), owner), 200);
  assert.ok(range.items.every(item => item.data.quantity >= 2));
  const inPage = await jsonResult(await api(listPath(collection, [["where[status]", "in:[\"open\"]"], ["limit", "100"]]), owner), 200);
  assert.ok(inPage.items.every(item => item.data.status === "open"));

  const count = await jsonResult(await api(`/v2/data/${collection}/aggregate?count`, owner), 200);
  assert.equal(count.count, records.length);
  assert.deepEqual(count.groups, []);
  const byStatus = await jsonResult(await api(`/v2/data/${collection}/aggregate?count&groupBy=status`, owner), 200);
  assert.equal(byStatus.count, records.length);
  assert.deepEqual(byStatus.groups, [
    { key: ["closed"], count: 70 }, { key: ["open"], count: 35 },
  ]);
  const byDay = await jsonResult(await api(`/v2/data/${collection}/aggregate?count&groupBy=day(createdOn)`, owner), 200);
  const expectedDays = new Map();
  for (const item of records) {
    const day = new Date(item.data.createdOn).toISOString().slice(0, 10);
    expectedDays.set(day, (expectedDays.get(day) ?? 0) + 1);
  }
  assert.equal(byDay.groups.reduce((sum, group) => sum + group.count, 0), records.length);
  for (const group of byDay.groups) assert.equal(group.count, expectedDays.get(group.key[0]));
});

test("integer fields reject fractions and operands keep the parser's decimal precision", async () => {
  const exact = await jsonResult(await api(listPath(collection, [["where[count]", "eq:2"], ["limit", "100"]]), owner), 200);
  assert.ok(exact.items.length > 0 && exact.items.every(item => item.data.count === 2));
  for (const entries of [
    [["where[count]", "eq:2.5"]],
    [["where[count]", "in:[1,2.5]"]],
    [["where[quantity]", "eq:1.0000000000000001"]],
    [["where[quantity]", "in:[1.0000000000000001]"]],
  ]) {
    const response = await api(listPath(collection, entries), owner);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "invalid_query");
  }
});

test("prefixes at the 256 character index boundary keep matching", async () => {
  const tag256 = "a".repeat(256);
  const tag257 = "a".repeat(257);
  const query = async value => jsonResult(await api(listPath(prefixCollection, [["where[tag]", `prefix:${JSON.stringify(value)}`], ["limit", "10"]]), owner), 200);
  assert.deepEqual((await query(tag256)).items.map(item => item.data.code).sort(), ["T-256", "T-257"]);
  assert.deepEqual((await query(tag257)).items.map(item => item.data.code), ["T-257"]);
  assert.deepEqual((await query(`${tag256}b`)).items, []);
});

test("cursors cannot switch between system order and a data field named created_at", async () => {
  const byOrder = await jsonResult(await api(listPath(collection, [["limit", "1"], ["order", "asc"]]), owner), 200);
  assert.ok(byOrder.nextCursor);
  const switchedToField = await api(listPath(collection, [["limit", "1"], ["sort", "created_at.asc"], ["cursor", byOrder.nextCursor]]), owner);
  assert.equal(switchedToField.status, 400);
  assert.equal((await switchedToField.json()).error, "invalid_cursor");

  const byField = await jsonResult(await api(listPath(collection, [["limit", "1"], ["sort", "created_at.asc"]]), owner), 200);
  assert.ok(byField.nextCursor);
  const switchedToOrder = await api(listPath(collection, [["limit", "1"], ["order", "asc"], ["cursor", byField.nextCursor]]), owner);
  assert.equal(switchedToOrder.status, 400);
  assert.equal((await switchedToOrder.json()).error, "invalid_cursor");
});

test("exactly one thousand aggregate groups is allowed and more than one thousand is not", async () => {
  const allowed = await jsonResult(await api(`/v2/data/${thousandCollection}/aggregate?count&groupBy=bucket`, owner), 200);
  assert.equal(allowed.groups.length, 1000);
  assert.equal(allowed.count, 1000);

  assert.equal((await api(`/v2/data-schemas/${groups}`, owner, { method: "PUT", body: schema(["code", "bucket"]) })).status, 200);
  await sql(`INSERT INTO core.app_records (tenant_id,owner_app_id,id,collection,data,created_at,unique_key_value)
    SELECT 'tenant-a',${q(owner.appId)},gen_random_uuid(),${q(groups)},jsonb_build_object('code','G-'||g,'bucket','B-'||g),now(),'G-'||g
    FROM generate_series(1,1001) g;
    SELECT app_private.record_replace_projection(r) FROM core.app_records r
      WHERE r.tenant_id='tenant-a' AND r.owner_app_id=${q(owner.appId)} AND r.collection=${q(groups)};`);
  await syncCount(groups);
  const response = await api(`/v2/data/${groups}/aggregate?count&groupBy=bucket`, owner);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "invalid_query");
});

test("management grants mask sensitive fields and refuse filtering, sorting and grouping on them", async () => {
  for (const reader of [recipient, grantOnly]) {
    const masked = await jsonResult(await api(listPath(collection, [["ownerAppId", owner.appId], ["limit", "100"]]), reader), 200);
    assert.ok(masked.items.length > 0);
    assert.ok(masked.items.every(item => item.data.notes === undefined));
    for (const page of [
      listPath(collection, [["ownerAppId", owner.appId], ["where[notes]", "eq:\"note-1\""]]),
      listPath(collection, [["ownerAppId", owner.appId], ["sort", "notes.asc"]]),
      `/v2/data/${collection}/aggregate?count&ownerAppId=${owner.appId}&groupBy=notes`,
    ]) {
      const response = await api(page, reader);
      assert.equal(response.status, 400, page);
      const body = await response.json();
      assert.equal(body.error, "invalid_query");
    }
  }
});

test("a sensitive-field change committed during an aggregate is seen in the same read snapshot", async () => {
  const mutation = sql(`BEGIN;
    LOCK TABLE app_private.record_collections IN ACCESS EXCLUSIVE MODE;
    SELECT pg_sleep(1);
    UPDATE app_private.record_collections
      SET sensitive_fields = ARRAY['status'], schema_revision = schema_revision + 1
      WHERE tenant_id='tenant-a' AND owner_app_id=${q(owner.appId)} AND collection=${q(concurrentCollection)};
    COMMIT;`).catch(error => error);
  let locked = false;
  for (let attempt = 0; attempt < 100 && !locked; attempt += 1) {
    locked = Number(await sql(`SELECT count(*) FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
      WHERE c.relname = 'record_collections' AND l.mode = 'AccessExclusiveLock' AND l.granted;`)) > 0;
    if (!locked) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(locked, "the schema mutation should hold its lock before the aggregate starts");
  const response = await api(`/v2/data/${concurrentCollection}/aggregate?count&groupBy=status&ownerAppId=${owner.appId}`, recipient);
  await mutation;
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "invalid_query");
});

test("a schema revision change invalidates old cursors and new sensitive fields are masked", async () => {
  const first = await jsonResult(await api(listPath(sensitiveCollection,
    [["limit", "1"], ["ownerAppId", owner.appId]]), grantOnly), 200);
  assert.ok(first.nextCursor);
  assert.equal(first.items[0].data.status, "open");
  await sql(`UPDATE app_private.record_collections
    SET sensitive_fields = ARRAY['status'], schema_revision = schema_revision + 1
    WHERE tenant_id='tenant-a' AND owner_app_id=${q(owner.appId)} AND collection=${q(sensitiveCollection)};`);
  const stale = await api(listPath(sensitiveCollection,
    [["limit", "1"], ["ownerAppId", owner.appId], ["cursor", first.nextCursor]]), grantOnly);
  assert.equal(stale.status, 400);
  assert.equal((await stale.json()).error, "invalid_cursor");
  const fresh = await jsonResult(await api(listPath(sensitiveCollection,
    [["limit", "10"], ["ownerAppId", owner.appId]]), grantOnly), 200);
  assert.ok(fresh.items.every(item => item.data.status === undefined));
});

test("equality, prefix and default pagination use their declared indexes", async () => {
  await sql("ANALYZE app_private.record_field_values; ANALYZE core.app_records;");
  const equality = await sql(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
    SELECT record_id FROM app_private.record_field_values f
    WHERE f.tenant_id='tenant-a' AND f.owner_app_id=${q(owner.appId)} AND f.collection=${q(planCollection)} AND f.field='code'
      AND app_private.record_text_digest(f.text_value) = app_private.record_text_digest('P-1000');`);
  assert.match(equality, /record_field_equality_idx|record_field_values_pkey/);
  assert.doesNotMatch(equality, /Seq Scan/);
  const prefixPlan = await sql(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
    SELECT record_id FROM app_private.record_field_values f
    WHERE f.tenant_id='tenant-a' AND f.owner_app_id=${q(owner.appId)} AND f.collection=${q(planCollection)} AND f.field='tag'
      AND left(f.text_value, 256) COLLATE "C" LIKE 'p-10%'
      AND left(f.text_value, char_length('p-10')) = 'p-10' COLLATE "C";`);
  assert.match(prefixPlan, /record_field_text_prefix_idx|record_field_values_pkey/);
  assert.doesNotMatch(prefixPlan, /Seq Scan/);
  const pagination = await sql(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
    SELECT id FROM core.app_records
    WHERE tenant_id='tenant-a' AND owner_app_id=${q(owner.appId)} AND collection=${q(planCollection)}
    ORDER BY created_at, id LIMIT 101;`);
  assert.match(pagination, /app_records_owner_collection_created_idx/);
  assert.doesNotMatch(pagination, /Seq Scan/);
});

test("implemented operations match the observed HTTP contract", async () => {
  await verifyContracts("record-queries");
});

test("numeric aggregates use the same half-open UTC range and filters as detail queries", async () => {
  const range = [
    ["createdFrom", "2030-01-10T07:00:00+07:00"],
    ["createdTo", "2030-01-20T00:00:00Z"],
  ];
  const where = ["where[status]", 'eq:"open"'];
  const detail = await jsonResult(await api(listPath(collection, [...range, where]), owner), 200);
  const expected = records.filter(item => item.data.status === "open" &&
    Date.parse(item.createdAt) >= Date.parse(range[0][1]) && Date.parse(item.createdAt) < Date.parse(range[1][1]));
  assert.deepEqual(new Set(detail.items.map(item => item.id)), new Set(expected.map(item => item.id)));
  const values = expected.flatMap(item => item.data.quantity === undefined ? [] : [item.data.quantity]);
  const total = values.reduce((sum, value) => sum + value, 0);
  for (const [measure, value] of [["sum", total], ["avg", total / values.length]]) {
    const query = new URLSearchParams([[measure, "quantity"], ...range, where, ["groupBy", "status"]]);
    const result = await jsonResult(await api(`/v2/data/${collection}/aggregate?${query}`, owner), 200);
    assert.equal(result.count, detail.items.length);
    assert.equal(result.value, value);
    assert.deepEqual(result.groups, [{ key: ["open"], count: detail.items.length, value }]);
    assert.deepEqual(result.source, {
      collection, ownerAppId: owner.appId, measure, field: "quantity",
      groupBy: [{ field: "status", day: false }], filters: [{ field: "status", op: "eq", value: "open" }],
      createdFrom: "2030-01-10T00:00:00.000Z", createdTo: "2030-01-20T00:00:00.000Z",
    });
  }
  const empty = await jsonResult(await api(`/v2/data/${collection}/aggregate?sum=quantity&createdFrom=2050-01-01T00:00:00Z`, owner), 200);
  assert.equal(empty.count, 0);
  assert.equal(empty.value, null);
  const first = await jsonResult(await api(listPath(collection, [...range, ["limit", "1"]]), owner), 200);
  assert.ok(first.nextCursor);
  await jsonResult(await api(listPath(collection, [...range, ["cursor", first.nextCursor]]), owner), 200);
  assert.equal((await jsonResult(await api(listPath(collection, [["cursor", first.nextCursor]]), owner), 400)).error, "invalid_cursor");
  for (const query of ["sum=status", "avg=quantity&count", "sum=quantity&createdTo=2030-02-31T00:00:00Z"]) {
    assert.equal((await jsonResult(await api(`/v2/data/${collection}/aggregate?${query}`, owner), 400)).error, "invalid_query");
  }
});
