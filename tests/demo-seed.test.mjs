// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  DEMO_COLLECTIONS, DEMO_CONTACTS, DEMO_DOCUMENTS, DEMO_NOTES, DEMO_ROOMS,
  backendClient, main, missingRecords, objectIdFor, parseOptions, seedCollection, seedDemoData, seedNotes,
} from "../scripts/demo-seed.mjs";
import { consoleUrlFor, main as localDemo, planSteps } from "../scripts/local-demo.mjs";
import { findViolations } from "../scripts/check-domain-neutral.mjs";

test("demo:seed defaults to demo, validates tenants and refuses reserved tenants", async () => {
  assert.equal(parseOptions([]).tenant, "demo");
  for (const tenant of ["demo-extra", "preview", "a", "a".repeat(63)]) {
    assert.equal(parseOptions(["--tenant", tenant]).tenant, tenant);
    assert.equal(parseOptions([`--tenant=${tenant}`]).tenant, tenant);
  }
  const connect = () => assert.fail("invalid options must not access the stack");
  for (const tenant of ["production", "tenant-a", "tenant-b"]) {
    await assert.rejects(main(["--tenant", tenant], { connect }), /Refusing to seed reserved tenant/);
  }
  for (const args of [["--tenant"], ["--tenant", ""], ["--tenant", "Demo"], ["--tenant", "bad_tenant"],
    ["--tenant", "../demo"], ["--tenant", "a".repeat(64)], ["--unknown"], ["production"]]) {
    await assert.rejects(main(args, { connect }), /Invalid --tenant|Usage:/);
  }
});

test("the fixed datasets are small, neutral and clearly fictional with unique seed keys", () => {
  assert.deepEqual(DEMO_COLLECTIONS.map(({ app, collection, records }) => [app, collection, records.length]), [
    ["danhba", "contacts", 8], ["vanban", "documents", 6], ["lichhop", "rooms", 4],
  ]);
  const all = [...DEMO_CONTACTS, ...DEMO_DOCUMENTS, ...DEMO_ROOMS, ...DEMO_NOTES];
  assert.equal(new Set(all.map(record => record.seedKey)).size, all.length);
  assert.ok(all.every(record => /^demo-[a-z]+-\d{2}$/.test(record.seedKey)));
  assert.ok(Buffer.byteLength(JSON.stringify(all)) < 12000);
  for (const contact of DEMO_CONTACTS) {
    assert.match(contact.name, /^Nhân vật mô phỏng \d{2}$/);
    assert.match(contact.email, /^[^@]+@example\.invalid$/);
    assert.match(contact.phone, /^\+84 000 000 \d{3}$/);
  }
  for (const document of DEMO_DOCUMENTS) {
    assert.equal(new Date(document.issuedOn).toISOString().slice(0, 10), document.issuedOn);
    assert.ok(document.summary.includes("mô phỏng"));
  }
  assert.ok(DEMO_ROOMS.every(room => room.capacity > 0 && room.capacity <= 20 && room.floor <= 2));
  assert.ok(DEMO_NOTES.length >= 2 && DEMO_NOTES.length <= 3);
  for (const note of DEMO_NOTES) {
    assert.match(note.filename, /^[a-z-]+\.txt$/);
    assert.ok(Buffer.byteLength(note.text) > 0 && Buffer.byteLength(note.text) < 1024);
  }
  // Include untracked new sources too; check:neutral scans tracked files only.
  const files = ["scripts/demo-seed.mjs", "scripts/local-demo.mjs"];
  assert.deepEqual(findViolations({ files, read: path => readFileSync(new URL(`../${path}`, import.meta.url)) }).violations, []);
  assert.deepEqual(findViolations({ files: ["scripts/demo-dataset.json"], read: () => JSON.stringify(all) }).violations, []);
});

test("stable object IDs separate seed keys and tenants", () => {
  const ids = DEMO_NOTES.map(note => objectIdFor("demo", note.seedKey));
  assert.equal(new Set(ids).size, DEMO_NOTES.length);
  for (const [index, note] of DEMO_NOTES.entries()) {
    assert.match(ids[index], /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(ids[index], objectIdFor("demo", note.seedKey));
    assert.notEqual(ids[index], objectIdFor("demo-extra", note.seedKey));
  }
});

test("missing record planning keys on seedKey and preserves existing data", () => {
  const existing = [{ data: { ...DEMO_CONTACTS[0], title: "Edited title" } }, { data: { unrelated: true } }];
  const snapshot = structuredClone(existing);
  assert.deepEqual(missingRecords(existing, DEMO_CONTACTS), DEMO_CONTACTS.slice(1));
  assert.deepEqual(existing, snapshot);
});

// Exercise the actual SDK request shapes and token flow without a running stack.
function gateway({ tenant = "demo", uploadStatus = 201, objectReadStatus } = {}) {
  const collections = new Map(), objects = new Map(), requests = [], adminPaths = [], messages = [];
  const base = "https://gateway.example.invalid";
  const stack = {
    tenant, base,
    admin: async path => {
      adminPaths.push(path);
      const url = new URL(path, `${base}/admin/`);
      if (url.pathname === "/admin/clients") {
        const clientId = url.searchParams.get("clientId");
        assert.match(clientId, new RegExp(`^app-${tenant}-(danhba|vanban|lichhop)$`));
        return Response.json([{ clientId, id: `${clientId}-uuid` }]);
      }
      assert.match(path, new RegExp(`^clients/app-${tenant}-(danhba|vanban|lichhop)-uuid/client-secret$`));
      return Response.json({ value: "fixture-credential" });
    },
  };
  const fetcher = async (url, options) => {
    url = new URL(url);
    assert.equal(url.origin, base, "all requests go through the public Gateway");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    if (url.pathname === "/identity/realms/junctura/protocol/openid-connect/token") {
      assert.equal(options.method, "POST");
      assert.equal(options.body.get("grant_type"), "client_credentials");
      assert.equal(options.body.get("client_secret"), "fixture-credential");
      const clientId = options.body.get("client_id");
      assert.match(clientId, new RegExp(`^app-${tenant}-`));
      requests.push({ method: "TOKEN", path: url.pathname, clientId });
      return Response.json({ access_token: clientId, token_type: "Bearer", expires_in: 300 });
    }
    const headers = new Headers(options.headers);
    const clientId = headers.get("Authorization").replace(/^Bearer /, "");
    assert.match(clientId, new RegExp(`^app-${tenant}-(danhba|vanban|lichhop)$`));
    assert.match(url.pathname, /^\/v2\/(data\/|objects\/)/);
    requests.push({ method: options.method, path: url.pathname, clientId });
    if (url.pathname.startsWith("/v2/data/")) {
      const collection = url.pathname.split("/").at(-1);
      const expectedApp = { contacts: "danhba", documents: "vanban", rooms: "lichhop", notes: "vanban" }[collection];
      assert.equal(clientId, `app-${tenant}-${expectedApp}`, "each collection belongs to its backend app");
      const key = `${clientId}/${collection}`, rows = collections.get(key) ?? [];
      if (options.method === "GET") {
        assert.equal(url.searchParams.get("limit"), "100");
        assert.equal(url.searchParams.get("order"), "asc");
        return Response.json({ items: rows, nextCursor: null });
      }
      assert.equal(options.method, "POST");
      assert.equal(headers.get("Content-Type"), "application/json");
      const body = JSON.parse(options.body);
      assert.deepEqual(Object.keys(body), ["data"]);
      assert.ok(body.data.seedKey);
      const row = { id: `fixture-${rows.length}`, data: body.data };
      collections.set(key, [...rows, row]);
      return Response.json(row, { status: 201 });
    }
    assert.equal(clientId, `app-${tenant}-vanban`, "notes are owned by Văn bản");
    const id = url.pathname.split("/").at(-1);
    if (options.method === "GET") {
      if (objectReadStatus) return Response.json({ error: "fixture_error" }, { status: objectReadStatus });
      return objects.has(id) ? new Response(objects.get(id)) : Response.json({ error: "not_found" }, { status: 404 });
    }
    assert.equal(options.method, "PUT");
    assert.equal(headers.get("Content-Type"), "application/octet-stream");
    assert.ok(Buffer.isBuffer(options.body), "the upload contains raw bytes, not JSON");
    const note = DEMO_NOTES.find(note => objectIdFor(tenant, note.seedKey) === id);
    assert.ok(note);
    assert.equal(options.body.toString("utf8"), note.text);
    if (uploadStatus !== 201) return Response.json({ error: "fixture_scan_failure" }, { status: uploadStatus });
    objects.set(id, options.body);
    return Response.json({ id, size: options.body.length }, { status: 201 });
  };
  return { stack, fetcher, collections, objects, requests, adminPaths, messages, log: message => messages.push(message) };
}

test("demo seed writes app-owned records and scanned object uploads; a second run writes nothing", async () => {
  const fake = gateway();
  const result = await seedDemoData(fake.stack, fake);
  assert.deepEqual(result, { records: 21, objects: 3 });
  assert.equal(fake.objects.size, 3);
  assert.equal(fake.collections.size, 4);
  assert.equal(fake.requests.filter(request => request.method === "TOKEN").length, 3);
  assert.equal(fake.adminPaths.length, 6);
  const before = fake.requests.length;
  assert.deepEqual(await seedDemoData(fake.stack, fake), { records: 0, objects: 0 });
  assert.ok(fake.requests.slice(before).every(({ method }) => ["GET", "TOKEN"].includes(method)));
  assert.ok(fake.messages.every(message => !message.includes("fixture-credential") && !message.includes("Bearer")));
});

test("a partial object upload can be resumed without duplicate files or metadata", async () => {
  const fake = gateway();
  const first = DEMO_NOTES[0];
  fake.objects.set(objectIdFor("demo", first.seedKey), Buffer.from(first.text));
  const client = await backendClient(fake.stack, { tenant: "demo", name: "vanban", fetcher: fake.fetcher });
  assert.deepEqual(await seedNotes(client, { tenant: "demo" }), { uploaded: 2, records: 3 });
  assert.deepEqual(await seedNotes(client, { tenant: "demo" }), { uploaded: 0, records: 0 });
});

test("scanner rejection or outage stops uploads before publishing note metadata", async () => {
  for (const uploadStatus of [422, 503]) {
    const fake = gateway({ uploadStatus });
    const client = await backendClient(fake.stack, { tenant: "demo", name: "vanban", fetcher: fake.fetcher });
    await assert.rejects(seedNotes(client, { tenant: "demo" }), error => error.status === uploadStatus);
    assert.equal(fake.objects.size, 0);
    assert.equal(fake.collections.size, 0);
    assert.equal(fake.requests.filter(({ method }) => method === "PUT").length, 1);
  }
});

test("object read failures other than 404 abort without overwriting anything", async () => {
  for (const objectReadStatus of [401, 403, 503]) {
    const fake = gateway({ objectReadStatus });
    const client = await backendClient(fake.stack, { tenant: "demo", name: "vanban", fetcher: fake.fetcher });
    await assert.rejects(seedNotes(client, { tenant: "demo" }), error => error.status === objectReadStatus);
    assert.ok(fake.requests.every(({ method }) => method !== "PUT" && method !== "POST"));
  }
});

test("collection pagination reads all pages before adding missing records", async () => {
  const calls = [], written = [];
  const client = {
    listRecords: async (collection, options) => {
      calls.push(options);
      assert.equal(collection, "contacts");
      return options.cursor
        ? { items: [{ data: DEMO_CONTACTS[1] }], nextCursor: null }
        : { items: [{ data: DEMO_CONTACTS[0] }], nextCursor: "opaque-cursor" };
    },
    createRecord: async (collection, data) => { assert.equal(calls.length, 2); written.push(data); },
  };
  assert.equal(await seedCollection(client, "contacts", DEMO_CONTACTS), 6);
  assert.deepEqual(calls, [{ limit: 100, order: "asc" }, { limit: 100, order: "asc", cursor: "opaque-cursor" }]);
  assert.deepEqual(written, DEMO_CONTACTS.slice(2));
});

test("collection read errors and repeated cursors cause no writes", async () => {
  for (const repeated of [false, true]) {
    let reads = 0;
    const client = {
      listRecords: async () => {
        if (reads++ && !repeated) throw new Error("read unavailable");
        return { items: [], nextCursor: "same-cursor" };
      },
      createRecord: () => assert.fail("must finish listing before writing"),
    };
    await assert.rejects(seedCollection(client, "contacts", DEMO_CONTACTS), /read unavailable|Invalid collection pagination/);
  }
});

test("admin and token failures never include credential response bodies in errors", async () => {
  const privateBody = "fixture-sensitive-response";
  await assert.rejects(backendClient({ admin: async () => new Response(privateBody, { status: 403 }) }, {
    tenant: "demo", name: "vanban",
  }), error => error.message === "Find backend client failed (403)");
  const fake = gateway();
  const client = await backendClient(fake.stack, {
    tenant: "demo", name: "vanban", fetcher: async () => new Response(privateBody, { status: 401 }),
  });
  await assert.rejects(client.listRecords("documents"), error => error.status === 401 && !error.message.includes(privateBody));
});

test("demo:seed connects, prepares management and seeds trust before app data", async () => {
  const fake = gateway({ tenant: "demo-extra" }), calls = [];
  fake.stack.ensureManagementClient = async () => calls.push("management");
  const connect = async options => {
    assert.deepEqual(options, { tenant: "demo-extra", createGroup: true });
    calls.push("connect");
    return fake.stack;
  };
  const seed = async (stack, options) => {
    assert.equal(stack, fake.stack);
    assert.deepEqual(options, { tenant: "demo-extra" });
    assert.equal(fake.requests.length, 0);
    calls.push("trust");
  };
  assert.deepEqual(await main(["--tenant", "demo-extra"], { ...fake, connect, seed }), { records: 21, objects: 3 });
  assert.deepEqual(calls, ["connect", "management", "trust"]);
  await main(["--help"], { connect: () => assert.fail("help must not connect"), log: () => {} });
});

test("local:demo plans setup only for a missing env file", () => {
  assert.deepEqual(planSteps({ envExists: false }), ["setup", "local:up", "directory:provision", "env:provision", "demo:seed", "demo:console"]);
  assert.deepEqual(planSteps({ envExists: true }), ["local:up", "directory:provision", "env:provision", "demo:seed", "demo:console"]);
});

test("Console URLs follow the published port, including the standard HTTP port", () => {
  assert.equal(consoleUrlFor("127.0.0.1:3456"), "http://127.0.0.1:3456");
  assert.equal(consoleUrlFor("127.0.0.1:80"), "http://127.0.0.1");
  assert.equal(consoleUrlFor("[::1]:3000"), "http://[::1]:3000");
  for (const address of ["", "unexpected output", "127.0.0.1:99999", "127.0.0.1:3000/path"]) {
    assert.throws(() => consoleUrlFor(address));
  }
});

test("local:demo executes in order and reports the Console URL and pre-filled read-only account", async () => {
  const calls = [], messages = [];
  await localDemo({
    exists: path => { assert.equal(path, ".env"); return false; },
    run: async script => calls.push(script), locateConsole: () => "http://127.0.0.1:3456", log: message => messages.push(message),
  });
  assert.deepEqual(calls, planSteps({ envExists: false }));
  assert.ok(messages.some(message => message.includes("http://127.0.0.1:3456")));
  assert.match(messages.at(-1), /read-only demo account is pre-filled/);
});

test("local:demo stops on the first failure and does not print a success message", async () => {
  const calls = [], messages = [];
  await assert.rejects(localDemo({
    exists: () => true,
    run: async script => { calls.push(script); if (script === "env:provision") throw new Error("step failed"); },
    locateConsole: () => assert.fail("should not resolve the Console after failure"), log: message => messages.push(message),
  }), /step failed/);
  assert.deepEqual(calls, ["local:up", "directory:provision", "env:provision"]);
  assert.ok(messages.every(message => !message.includes("pre-filled")));
});
