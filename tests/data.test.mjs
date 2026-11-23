// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { handleAppRecords, handleData, presentRecordRequest } from "../src/modules/data/data.mjs";
import { HttpError, json, readJson } from "../src/platform/http/http.mjs";

const identity = { tenantId: "tenant-a", subject: "backend", issuer: "https://issuer.example", clientId: "example", roles: ["core-reader", "core-writer"] };
const listen = server => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
});
const reply = (response, error) => json(response, error instanceof HttpError ? error.status : 500, { error: error.message });
const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const decode = value => JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
const fixture = () => Array.from({ length: 250 }, (_, index) => ({
  id: `00000000-0000-4000-8000-${String(250 - index).padStart(12, "0")}`,
  collection: "entries", data: { index },
  // Ties cross page boundaries; different timestamps also share a JS millisecond.
  created_at: `2026-01-01T00:00:00.12345${Math.floor(index / 80)}+00:00`,
}));
const micros = value => BigInt(Date.parse(value)) * 1000n + BigInt((/\.(\d+)/.exec(value)?.[1] ?? "").padEnd(6, "0").slice(3, 6));
const compare = (left, right) => micros(left.created_at) < micros(right.created_at) ? -1
  : micros(left.created_at) > micros(right.created_at) ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0;

let core, upstream, base, config, records, requests, upstreamMaxRows;
let currentIdentity = identity;

before(async () => {
  upstream = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://data");
      const claims = JSON.parse(Buffer.from(request.headers.authorization.split(".")[1], "base64url"));
      assert.equal(claims.tenant_id, identity.tenantId);
      if (url.pathname === "/rpc/record_command") {
        assert.equal(claims.role, "junctura_record_api");
        assert.equal(request.method, "POST");
        const { operation, payload } = await readJson(request);
        requests.push({ path: url.pathname, operation, payload });
        assert.equal(payload.collection, "entries");
        if (operation !== "get") assert.equal(claims.resource_writer, true);
        let row = records.find(item => item.id === payload.id);
        if (operation === "create") {
          row = { id: randomUUID(), collection: payload.collection, data: payload.body.data,
            created_at: "2026-01-02T00:00:00.123456+00:00", version: 1 };
          records.push(row);
        } else if (!row) return json(response, 200, { status: 404, error: "not_found" });
        if (operation === "delete") {
          records = records.filter(item => item !== row);
          return json(response, 200, { status: 204 });
        }
        if (operation === "replace") {
          row.data = payload.body.data;
          row.version = (row.version ?? 1) + 1;
        }
        const value = { ...row, version: row.version ?? 1 };
        if (payload.legacyBody && operation !== "get") delete value.version;
        return json(response, 200, { status: operation === "create" ? 201 : 200, value,
          headers: { ETag: `"record-${"a".repeat(64)}-${row.version ?? 1}"` } });
      }
      assert.ok(["/records", "/app_records"].includes(url.pathname));
      const query = url.searchParams;
      assert.equal(query.get("select"), "id,collection,data,created_at");
      assert.equal(claims.role, url.pathname === "/records" ? "junctura_api" : "junctura_resource_api");
      requests.push({ path: url.pathname, query, raw: request.url, method: request.method });
      let rows = records.filter(row => `eq.${row.collection}` === query.get("collection") &&
        (!query.has("id") || `eq.${row.id}` === query.get("id")));
      if (request.method === "GET") {
        const order = query.get("order");
        assert.ok(["created_at.asc,id.asc", "created_at.desc,id.desc"].includes(order));
        rows.sort((left, right) => compare(left, right) * (order === "created_at.asc,id.asc" ? 1 : -1));
        if (query.has("or")) {
          // PostgREST requires quoted values for '.', ':' and other reserved characters:
          // https://docs.postgrest.org/en/v16/references/api/url_grammar.html#reserved-characters
          const filter = /^\(created_at\.(gt|lt)\."([^"\\]+)",and\(created_at\.eq\."([^"\\]+)",id\.(gt|lt)\.([0-9a-f-]+)\)\)$/.exec(query.get("or"));
          assert.ok(filter, "quoted PostgREST logical filter");
          assert.equal(filter[2], filter[3]);
          assert.equal(filter[1], filter[4]);
          assert.equal(filter[1], order === "created_at.asc,id.asc" ? "gt" : "lt");
          const boundary = { created_at: filter[2], id: filter[5] };
          rows = rows.filter(row => compare(row, boundary) * (filter[1] === "gt" ? 1 : -1) > 0);
        }
        return json(response, 200, rows.slice(0, Math.min(Number(query.get("limit")), upstreamMaxRows)));
      }
      if (request.method === "DELETE") {
        records = records.filter(row => !rows.includes(row));
        return json(response, 200, rows);
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      if (request.method === "POST") {
        const row = { ...body, created_at: "2026-01-02T00:00:00.123456+00:00" };
        records.push(row);
        return json(response, 201, [row]);
      }
      assert.equal(request.method, "PATCH");
      for (const row of rows) row.data = body.data;
      return json(response, 200, rows);
    } catch (error) { reply(response, error); }
  });
  config = { dataUrl: await listen(upstream), dataSecret: "synthetic-data-secret" };
  core = createServer(async (request, response) => {
    const url = new URL(request.url, "http://core");
    if (url.pathname.startsWith("/v2/") &&
        (request.method !== "GET" || /^\/v2\/data\/[^/]+\/[^/]+$/.test(url.pathname))) {
      return presentRecordRequest(request, response, () => handleAppRecords(request, response, currentIdentity, config, url), true);
    }
    try { await handleData(request, response, currentIdentity, config, url); }
    catch (error) { reply(response, error); }
  });
  base = await listen(core);
});
after(() => {
  core?.close();
  core?.closeAllConnections();
  upstream?.close();
  upstream?.closeAllConnections();
});
beforeEach(() => { records = fixture(); requests = []; upstreamMaxRows = Infinity; currentIdentity = identity; });

for (const version of ["v1", "v2"]) {
  const path = `/${version}/data/entries`;
  const resource = version === "v1" ? "/records" : "/app_records";
  const useIdentity = () => { currentIdentity = version === "v1" ? identity : { ...identity, appId: "00000000-0000-4000-8000-000000000001" }; };

  for (const order of ["asc", "desc"]) for (const cap of [Infinity, 100]) {
    test(`${version} pages all 250 records ${order} without duplicates or gaps with upstream row cap ${cap}`, async () => {
      useIdentity();
      upstreamMaxRows = cap;
      const expected = [...records].sort((left, right) => compare(left, right) * (order === "asc" ? 1 : -1));
      const items = [], sizes = [];
      let cursor;
      do {
        const query = new URLSearchParams({ limit: "100", order });
        if (cursor) query.set("cursor", cursor);
        const response = await fetch(`${base}${path}?${query}`);
        assert.equal(response.status, 200);
        const page = await response.json();
        assert.deepEqual(Object.keys(page), ["items", "nextCursor"]);
        items.push(...page.items);
        sizes.push(page.items.length);
        if (page.nextCursor !== null) {
          assert.match(page.nextCursor, /^[A-Za-z0-9_-]+$/);
          assert.deepEqual(decode(page.nextCursor), { t: page.items.at(-1).created_at, i: page.items.at(-1).id, o: order });
        }
        cursor = page.nextCursor;
        assert.ok(sizes.length <= 3, "paging terminates");
      } while (cursor !== null);
      assert.deepEqual(sizes, [100, 100, 50]);
      assert.deepEqual(items, expected);
      assert.equal(new Set(items.map(row => row.id)).size, 250);
      assert.ok(requests.every(request => request.path === resource));
      assert.equal(requests.filter(request => request.query.get("limit") === "101").length, 3);
      assert.equal(requests.filter(request => request.query.get("limit") === "1").length, cap === 100 ? 2 : 0);
    });
  }

  test(`${version} defaults to ascending order and quotes the exact microsecond timestamp on the wire`, async () => {
    useIdentity();
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200);
    const first = await response.json();
    const expected = [...records].sort(compare);
    assert.deepEqual(first.items, expected.slice(0, 100));
    const last = first.items.at(-1);
    assert.deepEqual(decode(first.nextCursor), { t: last.created_at, i: last.id, o: "asc" });
    const next = await fetch(`${base}${path}?cursor=${first.nextCursor}`);
    assert.equal(next.status, 200);
    assert.deepEqual((await next.json()).items, expected.slice(100, 200));
    assert.equal(requests[1].query.get("or"), `(created_at.gt."${last.created_at}",and(created_at.eq."${last.created_at}",id.gt.${last.id}))`);
    assert.ok(requests[1].raw.includes(`%22${last.created_at.replaceAll(":", "%3A").replace("+", "%2B")}%22`));
    assert.equal(requests[1].raw.includes("%2522"), false, "quotes are encoded once");
  });

  test(`${version} returns null for an empty page and exactly full final pages`, async () => {
    useIdentity();
    for (const count of [0, 1, 2, 100]) {
      records = fixture().slice(0, count);
      const response = await fetch(`${base}${path}?limit=${count === 1 ? 1 : count === 2 ? 2 : 100}`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { items: [...records].sort(compare), nextCursor: null });
    }
    const last = [...records].sort(compare).at(-1);
    const response = await fetch(`${base}${path}?cursor=${encode({ t: last.created_at, i: last.id, o: "asc" })}`);
    assert.deepEqual(await response.json(), { items: [], nextCursor: null });
  });

  test(`${version} rejects unknown, repeated and invalid list query values before fetching`, async () => {
    useIdentity();
    for (const query of ["limit=0", "limit=101", "limit=-1", "limit=1.5", "limit=abc", "limit=", "order=", "order=ASC", "order=other",
      "offset=1", "tenant_id=tenant-b", "limit=2&limit=2", "order=asc&order=desc", "cursor=x&cursor=y"]) {
      const response = await fetch(`${base}${path}?${query}`);
      assert.equal(response.status, 400, query);
      assert.deepEqual(await response.json(), { error: "invalid_query" }, query);
    }
    assert.equal(requests.length, 0);
  });

  test(`${version} rejects malformed or tampered cursors and mismatched order before fetching`, async () => {
    useIdentity();
    const valid = { t: records[0].created_at, i: records[0].id, o: "asc" };
    const malformed = ["", "!", "A", "a".repeat(513), `${encode(valid)}=`, `${encode(valid)}!`, Buffer.from([255]).toString("base64url"),
      Buffer.from("not json").toString("base64url"), encode(null), encode([]), encode({}), encode({ ...valid, extra: true }),
      encode({ t: valid.t, i: valid.i }), encode({ ...valid, i: "bad-id" }), encode({ ...valid, i: [valid.i] }),
      encode({ ...valid, t: "not-a-timestamp" }), encode({ ...valid, t: "2026-01-01" }), encode({ ...valid, t: "2026-02-30T00:00:00Z" }), encode({ ...valid, t: null }),
      encode({ ...valid, t: '2026-01-01T00:00:00Z",id.gt.any' }), encode({ ...valid, o: "other" }), encode({ ...valid, o: "desc" }),
      Buffer.from(`{"t":"${valid.t}","i":"${valid.i}","o":"asc","o":"asc"}`).toString("base64url")];
    for (const cursor of malformed) {
      const response = await fetch(`${base}${path}?${new URLSearchParams({ cursor })}`);
      assert.equal(response.status, 400, cursor);
      assert.deepEqual(await response.json(), { error: "invalid_cursor" }, cursor);
    }
    const response = await fetch(`${base}${path}?order=desc&cursor=${encode(valid)}`);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_cursor" });
    assert.equal(requests.length, 0);
  });

  test(`${version} item GET preserves limit validation and first repeated limit, and rejects paging keys`, async () => {
    useIdentity();
    const record = records[0], item = `${base}${path}/${record.id}`;
    for (const query of ["", "?limit=100", "?limit=2&limit=invalid"]) {
      const response = await fetch(`${item}${query}`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), record);
      if (version === "v1") {
        assert.equal(requests.at(-1).query.get("limit"), "1");
        assert.equal(requests.at(-1).query.has("or"), false);
      } else {
        assert.equal(requests.at(-1).operation, "get");
        assert.equal(requests.at(-1).payload.id, record.id);
        assert.ok(response.headers.get("etag"));
      }
    }
    for (const query of ["?cursor=x", "?order=asc", "?limit=invalid&limit=2", "?limit=0", "?unknown=1"]) {
      const response = await fetch(`${item}${query}`);
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "invalid_query" });
    }
    assert.equal(requests.length, 3);
    const missing = await fetch(`${base}${path}/ffffffff-ffff-4fff-8fff-ffffffffffff`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "not_found" });
  });

  test(`${version} writes retain their envelopes, query rejection and writer requirement`, async () => {
    useIdentity();
    const write = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const created = await fetch(`${base}${path}`, write("POST", { data: { first: true, removed: true } }));
    assert.equal(created.status, 201);
    const record = await created.json(), item = `${base}${path}/${record.id}`;
    assert.match(record.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(record.data, { first: true, removed: true });
    const updated = await fetch(item, write("PATCH", { data: { second: true } }));
    assert.equal(updated.status, 200);
    assert.deepEqual((await updated.json()).data, { second: true });
    for (const [target, options] of [[`${base}${path}`, write("POST", { data: {} })], [item, write("PATCH", { data: {} })], [item, { method: "DELETE" }]]) {
      for (const query of ["limit=2", "order=desc", "cursor=x"]) {
        const response = await fetch(`${target}?${query}`, options);
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), { error: "invalid_query" });
      }
    }
    for (const body of [{ data: [], extra: true }, { data: {}, extra: true }]) {
      assert.equal((await fetch(`${base}${path}`, write("POST", body))).status, 400);
    }
    const writer = currentIdentity;
    currentIdentity = { ...writer, roles: ["core-reader"] };
    for (const [target, options] of [[`${base}${path}`, write("POST", { data: {} })], [item, write("PATCH", { data: {} })], [item, { method: "DELETE" }]]) {
      assert.equal((await fetch(target, options)).status, 403);
    }
    currentIdentity = writer;
    const deleted = await fetch(item, { method: "DELETE" });
    assert.equal(deleted.status, 204);
    assert.equal(await deleted.text(), "");
    if (version === "v1") {
      assert.ok(requests.every(request => request.path === resource && request.query.get("order") === "created_at.asc,id.asc" &&
        !request.query.has("limit") && !request.query.has("or")));
    } else {
      assert.deepEqual(requests.map(request => request.operation), ["create", "replace", "delete"]);
      assert.ok(requests.every(request => request.path === "/rpc/record_command" && !request.payload.requireMatch));
      assert.deepEqual(requests.slice(0, 2).map(request => request.payload.legacyBody), [true, true]);
      assert.ok(created.headers.get("etag"));
      assert.notEqual(updated.headers.get("etag"), created.headers.get("etag"));
    }
    assert.equal((await fetch(item)).status, 404);
  });
}
