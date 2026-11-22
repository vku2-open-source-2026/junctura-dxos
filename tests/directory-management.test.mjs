// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import { handleDirectory } from "../src/modules/directory/directory.mjs";
import { HttpError, json } from "../src/platform/http/http.mjs";

const identity = {
  tenantId: "tenant-a", subject: "admin-1", issuer: "https://identity.example.invalid",
  clientId: "junctura-console", roles: ["core-reader", "core-writer"], units: [], groups: [],
};
const reader = { ...identity, roles: ["core-reader"] };
const writerWithoutPermission = { ...identity, subject: "writer-only" };
let dataDown = false;
let keycloakDown = false;
let failMembershipReadBack = false;
let gate;
const store = { types: new Map(), units: new Map(), groups: new Map(), members: new Map() };
let data, keycloak, core, mirror, base, mirrorBase;
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));

// A faithful-enough emulation of the directory RPC: prepare bumps the
// generation, confirm marks the generation as synchronized under the row's
// current generation, deletes stay durable tombstones until confirmed, a
// confirm that no longer matches the row's generation is a lost race and
// reports a conflict, and every mutation needs the relayed writer flag.
const directoryWriters = new Set(["admin-1"]);
function rpc(operation, payload, claims) {
  const table = { unit_type: store.types, unit: store.units, group: store.groups, member: store.members };
  const kind = operation.replace(/_(put|confirm|delete|delete_confirm|list)$/, "");
  const rows = table[kind];
  const keyOf = row => { const value = row.desired ?? row;
    return kind === "unit_type" ? value.unitType : kind === "unit" ? value.unit :
      kind === "group" ? `${value.unit}/${value.group}` : `${value.unit}/${value.subject}`; };
  const mutation = !operation.endsWith("_list");
  if (mutation && claims.directory_writer !== true) return { status: 403, error: "write_forbidden" };
  if (mutation && !directoryWriters.has(claims.sub ?? "")) return { status: 403, error: "forbidden" };
  if (operation.endsWith("_list")) {
    // Lists order and page by the collection's own key, like the SQL does.
    const listKey = row => { const value = row.desired ?? row;
      return kind === "unit_type" ? value.unitType : kind === "unit" ? value.unit :
        kind === "group" ? value.group : value.subject; };
    const visible = [...rows.values()].sort((a, b) => listKey(a) < listKey(b) ? -1 : 1)
      .filter(row => !row.pending_delete)
      .filter(row => !payload.after || listKey(row) > payload.after);
    return { status: 200, value: { items: visible.slice(0, payload.limit).map(row => kind === "member"
      ? { unit: row.desired.unit, subject: row.desired.subject, groups: row.desired.groups } : { ...row.desired }), total: visible.length } };
  }
  if (operation.endsWith("_put")) {
    const existing = rows.get(keyOf(payload));
    const desired = { ...payload };
    if ((operation === "unit_put" && ![...store.types.values()].some(row =>
          row.desired.unitType === desired.unitType && !row.pending_delete)) ||
        (operation === "group_put" && (![...store.units.values()].some(row =>
          row.desired.unit === desired.unit && !row.pending_delete))) ||
        (operation === "member_put" && (![...store.units.values()].some(row =>
          row.desired.unit === desired.unit && !row.pending_delete) ||
          desired.groups.some(group => { const groupRow = [...store.groups.values()]
            .find(row => row.desired.unit === desired.unit && row.desired.group === group);
            return !groupRow || groupRow.pending_delete; })))) {
      return { status: 404, error: "not_found" };
    }
    const same = existing && !existing.pending_delete && JSON.stringify(desired) === JSON.stringify(existing.desired);
    if (same && existing.synced_generation === existing.generation) {
      return { status: 200, generation: existing.generation, confirmed: true };
    }
    if (same) return { status: 200, generation: existing.generation };
    if (!existing) {
      rows.set(keyOf(payload), { desired, generation: 1, synced_generation: null, pending_delete: false });
      return { status: 201, generation: 1 };
    }
    const recreated = existing.pending_delete && existing.synced_generation === existing.generation;
    existing.generation += 1; existing.synced_generation = null; existing.pending_delete = false;
    existing.desired = desired;
    return { status: recreated ? 201 : 200, generation: existing.generation };
  }
  if (operation.endsWith("delete_confirm")) {
    const existing = rows.get(keyOf(payload));
    if (existing && existing.pending_delete && existing.generation === payload.generation) {
      existing.synced_generation = payload.generation;
      return { status: 204 };
    }
    return { status: 409, error: "resource_conflict" };
  }
  if (operation.endsWith("_confirm")) {
    const existing = rows.get(keyOf(payload));
    if (existing && !existing.pending_delete && existing.generation === payload.generation) {
      existing.synced_generation = payload.generation;
      return { status: 204 };
    }
    return { status: 409, error: "resource_conflict" };
  }
  if (operation.endsWith("_delete")) {
    const existing = rows.get(keyOf(payload));
    if (!existing) return { status: 204 };
    if (kind === "unit_type" && [...store.units.values()].some(row => row.desired.unitType === payload.unitType && !row.pending_delete)) {
      return { status: 409, error: "resource_conflict" };
    }
    if (kind === "unit" && ([...store.groups.values()].some(row => row.desired.unit === payload.unit && !row.pending_delete) ||
        [...store.members.values()].some(row => row.desired.unit === payload.unit && !row.pending_delete))) {
      return { status: 409, error: "resource_conflict" };
    }
    if (kind === "group" && [...store.members.values()].some(row =>
      !row.pending_delete && row.desired.unit === payload.unit && row.desired.groups.includes(payload.group))) {
      return { status: 409, error: "resource_conflict" };
    }
    if (existing.pending_delete && existing.synced_generation === existing.generation) return { status: 204 };
    if (!existing.pending_delete) {
      existing.pending_delete = true;
      existing.generation += 1;
      existing.synced_generation = null;
      if (kind === "member") existing.desired = { unit: payload.unit, subject: payload.subject, groups: [] };
    }
    return { status: 204, generation: existing.generation };
  }
  return { status: 400, error: "invalid_request" };
}

const claimsOf = request => JSON.parse(Buffer.from(request.headers.authorization.split(".")[1], "base64url").toString());

before(async () => {
  data = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (dataDown) { response.writeHead(503); return response.end(); }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(rpc(body.operation, body.payload, claimsOf(request))));
  });
  const dataUrl = await listen(data);

  // Minimal Keycloak: the admin paths and token endpoint the adapter uses.
  // Listings honor first/max and cap pages at two entries, so the adapter's
  // pagination walks every page instead of trusting the first one.
  const realm = { groups: [{ id: "g-root", name: "tenant-a", path: "/tenant-a" }],
    users: [{ id: "u-1", username: "subject-42", groupIds: ["g-root"] }, { id: "u-2", username: "outsider", groupIds: [] }] };
  const childOf = (parentId, name) => realm.groups.find(group => group.parentId === parentId && group.name === name);
  const paged = (items, url) => {
    const first = Number(url.searchParams.get("first") ?? 0);
    const max = Number(url.searchParams.get("max") ?? 2);
    return items.slice(first, first + Math.min(Math.max(max, 0), 2));
  };
  keycloak = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    if (keycloakDown || failMembershipReadBack) { response.writeHead(503); return response.end(); }
    const url = new URL(request.url, "http://identity");
    if (url.pathname === "/identity/realms/junctura/protocol/openid-connect/token") {
      response.writeHead(200, { "Content-Type": "application/json" });
      return response.end(JSON.stringify({ access_token: "sync-token", expires_in: 60 }));
    }
    const group = url.pathname.match(/^\/identity\/admin\/realms\/junctura\/groups\/([^/]+)(\/children)?$/);
    const groups = url.pathname === "/identity/admin/realms/junctura/groups";
    const userPath = url.pathname.match(/^\/identity\/admin\/realms\/junctura\/users\/([^/]+)(\/groups(\/([^/]+))?)?$/);
    response.writeHead(200, { "Content-Type": "application/json" });
    if (groups) {
      if (request.method === "POST") {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        realm.groups.push({ id: randomUUID(), name: body.name, path: `/${body.name}` });
        response.statusCode = 201;
        return response.end();
      }
      return response.end(JSON.stringify(paged(realm.groups.filter(group => !group.parentId)
        .filter(group => !url.searchParams.get("search") || group.name === url.searchParams.get("search")), url)));
    }
    if (group) {
      const parent = realm.groups.find(item => item.id === group[1]);
      if (!parent) { response.statusCode = 404; return response.end(); }
      if (group[2]) { // children
        if (request.method === "GET" && gate && gate.holds === 0) { gate.holds += 1; await gate.promise; }
        if (request.method === "POST") {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          realm.groups.push({ id: randomUUID(), name: body.name, parentId: parent.id, path: `${parent.path}/${body.name}` });
          response.statusCode = 201;
          return response.end();
        }
        return response.end(JSON.stringify(paged(realm.groups.filter(item => item.parentId === parent.id), url)));
      }
      if (request.method === "DELETE") {
        realm.groups = realm.groups.filter(item => item.id !== parent.id && item.path !== parent.path &&
          !item.path.startsWith(`${parent.path}/`));
        response.statusCode = 204;
        return response.end();
      }
      return response.end(JSON.stringify(parent));
    }
    if (userPath) {
      const person = realm.users.find(item => item.id === decodeURIComponent(userPath[1]) || item.username === decodeURIComponent(userPath[1]));
      if (!person) { response.statusCode = 404; return response.end(); }
      if (userPath[3]) { // /groups/{id}
        if (request.method === "PUT") {
          person.groupIds = [...new Set([...person.groupIds ?? [], userPath[4]])];
          response.statusCode = 204;
          return response.end();
        }
        if (request.method === "DELETE") { person.groupIds = (person.groupIds ?? []).filter(id => id !== userPath[4]); response.statusCode = 204; return response.end(); }
      }
      if (userPath[2]) {
        return response.end(JSON.stringify(paged(realm.groups.filter(item => (person.groupIds ?? []).includes(item.id))
          .map(({ id, name, path }) => ({ id, name, path })), url)));
      }
      return response.end(JSON.stringify(person));
    }
    response.end("{}");
  });
  const keycloakBase = await listen(keycloak);
  const identityUrl = `${keycloakBase}/identity/realms/junctura`;

  const config = { dataUrl, dataSecret: "x".repeat(32), identityUrl, directorySyncClientId: "junctura-directory-sync",
    directorySyncSecret: "y".repeat(32) };
  const serve = () => createServer(async (request, response) => {
    // The caller identity rides a test header so one fixture can serve several
    // principals; production resolves it from the bearer token.
    const who = { reader, "writer-only": writerWithoutPermission }[request.headers["x-fixture-subject"]] ?? identity;
    try {
      await handleDirectory(request, response, who, config, new URL(request.url, "http://core"));
    } catch (error) {
      json(response, error instanceof HttpError ? error.status : 500, { error: error.message });
    }
  });
  core = serve();
  mirror = serve(); // a second Core instance: replicas share no process state.
  base = await listen(core);
  mirrorBase = await listen(mirror);
});
after(() => { data.close(); keycloak.close(); core.close(); mirror.close(); });

const call = (path, method = "GET", body, who = identity, origin = base) => fetch(origin + path, {
  method, headers: {
    ...(who === reader ? { "x-fixture-subject": "reader" } : who === writerWithoutPermission ? { "x-fixture-subject": "writer-only" } : {}),
    ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

test("a unit type is created, confirmed, replaced and removed with idempotent deletes", async () => {
  const created = await call("/v1/directory/unit-types/office", "PUT", { name: "Office" });
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), { unitType: "office", name: "Office" });
  const same = await call("/v1/directory/unit-types/office", "PUT", { name: "Office" });
  assert.equal(same.status, 200, "identical confirmed desired state skips the provider");
  const renamed = await call("/v1/directory/unit-types/office", "PUT", { name: "Offices" });
  assert.equal(renamed.status, 200);
  const deleted = await call("/v1/directory/unit-types/office", "DELETE");
  assert.equal(deleted.status, 204);
  assert.equal((await call("/v1/directory/unit-types/office", "DELETE")).status, 204, "repeated delete stays 204");
});

test("lists paginate in ascending key order with opaque cursors", async () => {
  for (const unitType of ["b-office", "a-desk", "c-room"]) {
    await call(`/v1/directory/unit-types/${unitType}`, "PUT", { name: unitType });
  }
  const first = await (await call("/v1/directory/unit-types?limit=2")).json();
  assert.deepEqual(first.items.map(item => item.unitType), ["a-desk", "b-office"]);
  assert.notEqual(first.nextCursor, null);
  const second = await (await call(`/v1/directory/unit-types?limit=2&cursor=${first.nextCursor}`)).json();
  assert.deepEqual(second.items.map(item => item.unitType), ["c-room"]);
  assert.equal(second.nextCursor, null);
  assert.equal((await call("/v1/directory/unit-types?cursor=%%%")).status, 400, "malformed cursor");
  assert.equal((await call("/v1/directory/unit-types?limit=101")).status, 400);
  assert.equal((await call("/v1/directory/unit-types?tenant=tenant-b")).status, 400);
  assert.equal((await call("/v1/directory/unit-types/a-desk", "PUT", { name: "x" })).status, 200);
});

test("group and member pages advance on their own collection key", async () => {
  await call("/v1/directory/unit-types/office", "PUT", { name: "Office" });
  await call("/v1/directory/units/unit-a", "PUT", { unitType: "office", name: "Unit A" });
  for (const group of ["a-group", "b-group", "c-group"]) {
    await call(`/v1/directory/units/unit-a/groups/${group}`, "PUT", { name: group });
  }
  const first = await (await call("/v1/directory/units/unit-a/groups?limit=2")).json();
  assert.deepEqual(first.items.map(item => item.group), ["a-group", "b-group"]);
  assert.notEqual(first.nextCursor, null);
  const second = await (await call(`/v1/directory/units/unit-a/groups?limit=2&cursor=${first.nextCursor}`)).json();
  assert.deepEqual(second.items.map(item => item.group), ["c-group"], "the cursor follows the group column");
  await call("/v1/directory/units/unit-a/members/subject-42", "PUT", { groups: ["a-group", "b-group", "c-group"] });
  const memberPages = await (await call("/v1/directory/units/unit-a/members?limit=1")).json();
  assert.deepEqual(memberPages.items.map(item => item.subject), ["subject-42"]);
  assert.equal(memberPages.nextCursor, null);
  await call("/v1/directory/units/unit-a/members/subject-42", "DELETE");
  for (const group of ["a-group", "b-group", "c-group"]) {
    await call(`/v1/directory/units/unit-a/groups/${group}`, "DELETE");
  }
  await call("/v1/directory/units/unit-a", "DELETE");
  await call("/v1/directory/unit-types/office", "DELETE");
});

test("a unit keeps its name when only its type changes and returns the stored row", async () => {
  await call("/v1/directory/unit-types/office", "PUT", { name: "Office" });
  await call("/v1/directory/unit-types/branch", "PUT", { name: "Branch" });
  await call("/v1/directory/units/unit-a", "PUT", { unitType: "office", name: "Unit A" });
  const changed = await call("/v1/directory/units/unit-a", "PUT", { unitType: "branch", name: "Unit A" });
  assert.equal(changed.status, 200);
  assert.deepEqual(await changed.json(), { unit: "unit-a", unitType: "branch", name: "Unit A" });
  const listed = await (await call("/v1/directory/units")).json();
  assert.deepEqual(listed.items.find(item => item.unit === "unit-a"), { unit: "unit-a", unitType: "branch", name: "Unit A" });
  await call("/v1/directory/units/unit-a", "DELETE");
  await call("/v1/directory/unit-types/branch", "DELETE");
  await call("/v1/directory/unit-types/office", "DELETE");
});

test("references, conflicts and shapes fail with documented errors", async () => {
  await call("/v1/directory/unit-types/office", "PUT", { name: "Office" });
  assert.equal((await call("/v1/directory/units/unit-a", "PUT", { unitType: "missing", name: "Unit A" })).status, 404);
  const unit = await call("/v1/directory/units/unit-a", "PUT", { unitType: "office", name: "Unit A" });
  assert.equal(unit.status, 201);
  assert.deepEqual(await unit.json(), { unit: "unit-a", unitType: "office", name: "Unit A" });
  assert.equal((await call("/v1/directory/unit-types/office", "DELETE")).status, 409, "type in use");
  await call("/v1/directory/units/unit-a/groups/reviewers", "PUT", { name: "Reviewers" });
  assert.equal((await call("/v1/directory/units/unit-a", "DELETE")).status, 409, "unit with a group conflicts");
  assert.equal((await call("/v1/directory/units/unit-a/groups/reviewers", "DELETE")).status, 204);
  assert.equal((await call("/v1/directory/units/unit-a", "PUT", { unitType: "office", name: "Bad\u0000name" })).status, 400);
  assert.equal((await call("/v1/directory/units/unit-a", "PUT", { unitType: "office" })).status, 400);
  assert.equal((await call("/v1/directory/units/unit-a?x=1", "PUT", { unitType: "office", name: "Unit A" })).status, 400);
  assert.equal((await call("/v1/directory/units/unit-a", "PATCH", { unitType: "office", name: "Unit A" })).status, 405);
  assert.equal((await call("/v1/directory/nope")).status, 404);
  await call("/v1/directory/units/unit-a", "DELETE");
  await call("/v1/directory/unit-types/office", "DELETE");
});

test("mutations need the core-writer role and the directory.write permission", async () => {
  await call("/v1/directory/unit-types/office", "PUT", { name: "Office" });
  assert.equal((await call("/v1/directory/unit-types/office", "PUT", { name: "Office" }, reader)).status, 403,
    "a reader with directory.write still cannot mutate");
  assert.equal((await call("/v1/directory/unit-types/office", "DELETE", undefined, reader)).status, 403);
  assert.equal((await call("/v1/directory/units", "GET", undefined, reader)).status, 200, "lists stay readable");
  assert.equal((await call("/v1/directory/unit-types/office", "PUT", { name: "Office" }, writerWithoutPermission)).status, 403,
    "a writer without the directory.write permission is refused");
  const allowed = await call("/v1/directory/unit-types/office", "PUT", { name: "Office" });
  assert.equal(allowed.status, 200, "a writer holding directory.write proceeds");
  await call("/v1/directory/unit-types/office", "DELETE");
});

test("membership replaces the group set, syncs the provider and deletes idempotently", async () => {
  await call("/v1/directory/unit-types/office", "PUT", { name: "Office" });
  await call("/v1/directory/units/unit-a", "PUT", { unitType: "office", name: "Unit A" });
  await call("/v1/directory/units/unit-a/groups/reviewers", "PUT", { name: "Reviewers" });
  assert.equal((await call("/v1/directory/units/unit-a/members/subject-42", "PUT", { groups: ["ghost"] })).status, 404);
  assert.equal((await call("/v1/directory/units/unit-a/members/outsider", "PUT", { groups: [] })).status, 404,
    "a subject outside the tenant is refused");
  assert.equal((await call("/v1/directory/units/unit-a/members/subject-42", "PUT", { groups: ["reviewers", "reviewers"] })).status, 400, "duplicate groups violate the schema");
  const member = await call("/v1/directory/units/unit-a/members/subject-42", "PUT", { groups: ["reviewers"] });
  assert.equal(member.status, 201);
  assert.deepEqual(await member.json(), { unit: "unit-a", subject: "subject-42", groups: ["reviewers"] });
  const updated = await call("/v1/directory/units/unit-a/members/subject-42", "PUT", { groups: [] });
  assert.equal(updated.status, 200, "member update without group change of key stays 200");
  assert.deepEqual(await updated.json(), { unit: "unit-a", subject: "subject-42", groups: [] });
  assert.equal((await call("/v1/directory/units/unit-a/groups/reviewers", "DELETE")).status, 204, "member no longer references the group");
  assert.equal((await call("/v1/directory/units/unit-a/members/subject-42", "DELETE")).status, 204);
  assert.equal((await call("/v1/directory/units/unit-a/members/outsider", "DELETE")).status, 204, "the refused member's desired row still deletes cleanly");
  assert.equal((await call("/v1/directory/units/unit-a/members/subject-42", "DELETE")).status, 204);
  assert.equal((await call("/v1/directory/units/unit-a/groups/reviewers", "DELETE")).status, 204);
  assert.equal((await call("/v1/directory/units/unit-a", "DELETE")).status, 204);
  assert.equal((await call("/v1/directory/unit-types/office", "DELETE")).status, 204);
});

test("a member write can be re-created after a full delete without reusing its generation", async () => {
  await call("/v1/directory/unit-types/office", "PUT", { name: "Office" });
  await call("/v1/directory/units/unit-a", "PUT", { unitType: "office", name: "Unit A" });
  await call("/v1/directory/units/unit-a/groups/reviewers", "PUT", { name: "Reviewers" });
  const first = await call("/v1/directory/units/unit-a/members/subject-42", "PUT", { groups: ["reviewers"] });
  assert.equal(first.status, 201);
  assert.equal((await call("/v1/directory/units/unit-a/members/subject-42", "DELETE")).status, 204);
  const again = await call("/v1/directory/units/unit-a/members/subject-42", "PUT", { groups: ["reviewers"] });
  assert.equal(again.status, 201, "a re-created member reports a fresh creation");
  assert.equal((await call("/v1/directory/units/unit-a/members/subject-42", "DELETE")).status, 204);
  assert.equal((await call("/v1/directory/units/unit-a/groups/reviewers", "DELETE")).status, 204);
  assert.equal((await call("/v1/directory/units/unit-a", "DELETE")).status, 204);
  assert.equal((await call("/v1/directory/unit-types/office", "DELETE")).status, 204);
});

test("a failed provider synchronization leaves the desired state to converge on retry", async () => {
  await call("/v1/directory/unit-types/office", "PUT", { name: "Office" });
  await call("/v1/directory/units/unit-a", "PUT", { unitType: "office", name: "Unit A" });
  keycloakDown = true;
  const blocked = await call("/v1/directory/units/unit-a/groups/reviewers", "PUT", { name: "Reviewers" });
  assert.equal(blocked.status, 503);
  keycloakDown = false;
  const retried = await call("/v1/directory/units/unit-a/groups/reviewers", "PUT", { name: "Reviewers" });
  assert.equal(retried.status, 200, "the same desired state converges after recovery");
  assert.equal((await call("/v1/directory/units/unit-a/groups/reviewers", "DELETE")).status, 204);
  assert.equal((await call("/v1/directory/units/unit-a", "DELETE")).status, 204);
  assert.equal((await call("/v1/directory/unit-types/office", "DELETE")).status, 204);
});

test("an outage after a partial membership change still converges on retry", async () => {
  await call("/v1/directory/unit-types/office", "PUT", { name: "Office" });
  await call("/v1/directory/units/unit-a", "PUT", { unitType: "office", name: "Unit A" });
  await call("/v1/directory/units/unit-a/groups/reviewers", "PUT", { name: "Reviewers" });
  failMembershipReadBack = true;
  const halfDone = await call("/v1/directory/units/unit-a/members/subject-42", "PUT", { groups: ["reviewers"] });
  assert.equal(halfDone.status, 503, "the membership was applied but the read-back failed");
  failMembershipReadBack = false;
  const retried = await call("/v1/directory/units/unit-a/members/subject-42", "PUT", { groups: ["reviewers"] });
  assert.equal([200, 201].includes(retried.status), true, "the same desired state converges after the outage");
  assert.deepEqual(await retried.json(), { unit: "unit-a", subject: "subject-42", groups: ["reviewers"] });
  assert.equal((await call("/v1/directory/units/unit-a/members/subject-42", "DELETE")).status, 204);
  assert.equal((await call("/v1/directory/units/unit-a/groups/reviewers", "DELETE")).status, 204);
  assert.equal((await call("/v1/directory/units/unit-a", "DELETE")).status, 204);
  assert.equal((await call("/v1/directory/unit-types/office", "DELETE")).status, 204);
});

test("replicas racing the same row serialize by generation and the stale confirm loses", async () => {
  await call("/v1/directory/unit-types/office", "PUT", { name: "Office" });
  await call("/v1/directory/units/unit-a", "PUT", { unitType: "office", name: "Unit A" });
  // Hold the first replica between the two prepares so both rows carry
  // distinct generations before either confirms; later callers pass through.
  let release;
  gate = { holds: 0, promise: new Promise(resolve => { release = resolve; }) };
  const first = call("/v1/directory/units/unit-a/groups/reviewers", "PUT", { name: "First" }, identity, mirrorBase);
  await new Promise(resolve => setTimeout(resolve, 120));
  const second = call("/v1/directory/units/unit-a/groups/reviewers", "PUT", { name: "Second" });
  release();
  const outcomes = await Promise.all([first, second]);
  const statuses = outcomes.map(response => response.status).sort();
  assert.deepEqual(statuses, [200, 409], "the stale confirm reports a conflict instead of success");
  const settled = await (await call("/v1/directory/units/unit-a/groups")).json();
  assert.equal(settled.items.length, 1, "exactly one desired row survives the race");
  const healed = await call("/v1/directory/units/unit-a/groups/reviewers", "PUT", { name: "Settled" });
  assert.equal(healed.status, 200, "a retry of the winning desired state converges");
  assert.equal((await call("/v1/directory/units/unit-a/groups/reviewers", "DELETE")).status, 204);
  assert.equal((await call("/v1/directory/units/unit-a", "DELETE")).status, 204);
  assert.equal((await call("/v1/directory/unit-types/office", "DELETE")).status, 204);
  gate = null;
});

test("a member write racing the deletion of its group ends in a documented conflict", async () => {
  await call("/v1/directory/unit-types/office", "PUT", { name: "Office" });
  await call("/v1/directory/units/unit-a", "PUT", { unitType: "office", name: "Unit A" });
  await call("/v1/directory/units/unit-a/groups/reviewers", "PUT", { name: "Reviewers" });
  const [member, removal] = await Promise.all([
    call("/v1/directory/units/unit-a/members/subject-42", "PUT", { groups: ["reviewers"] }),
    call("/v1/directory/units/unit-a/groups/reviewers", "DELETE"),
  ]);
  assert.ok(
    (member.status === 201 && removal.status === 409) || (member.status === 404 && removal.status === 204),
    "either the member lands and the delete conflicts, or the delete wins and the member is refused");
  const groups = await (await call("/v1/directory/units/unit-a/groups")).json();
  const members = await (await call("/v1/directory/units/unit-a/members")).json();
  if (groups.items.length === 0) {
    assert.equal(members.items.length, 0, "a removed group leaves no member referencing it");
  } else {
    assert.deepEqual(members.items[0]?.groups ?? [], ["reviewers"], "a surviving member keeps its group");
  }
  // Either way, repeating the losing operation converges.
  await call("/v1/directory/units/unit-a/members/subject-42", "DELETE");
  assert.equal((await call("/v1/directory/units/unit-a/groups/reviewers", "DELETE")).status, 204);
  assert.equal((await call("/v1/directory/units/unit-a", "DELETE")).status, 204);
  assert.equal((await call("/v1/directory/unit-types/office", "DELETE")).status, 204);
});

test("the migrations bind generations, permissions and consent identity durably", () => {
  const sql = name => readFileSync(new URL(`../infra/postgres/${name}`, import.meta.url), "utf8");
  const directory = sql("037-directory-management.sql");
  assert.match(directory, /'compositions.approve','directory\.write'\]::text\[\]/, "directory.write joins the permission vocabulary");
  assert.match(directory, /PRIMARY KEY \(tenant_id, unit_type\)/);
  assert.match(directory, /synced_generation bigint/);
  assert.match(directory, /pending_delete boolean NOT NULL DEFAULT false/, "deletes stay durable tombstones");
  assert.match(directory, /pg_advisory_xact_lock\(hashtextextended\('junctura-directory:'\|\|tenant,0\)\)/,
    "replicas coordinate through a per-tenant PostgreSQL advisory lock");
  assert.match(directory, /directory_writer',''\) IS DISTINCT FROM 'true'/, "mutations need the relayed core-writer flag");
  assert.match(directory, /IF NOT FOUND THEN RETURN jsonb_build_object\('status',409,'error','resource_conflict'\); END IF;\n    RETURN jsonb_build_object\('status',204\);/,
    "a confirm that updates zero rows is a lost race, never a success");
  assert.match(directory, /SELECT generation, synced_generation, pending_delete INTO gen, synced, pending FROM app_private\.directory_members\n      WHERE tenant_id=tenant AND unit=unit_key AND subject=key FOR UPDATE;\n    created := NOT FOUND OR \(pending AND synced=gen\);/,
    "FOUND is saved before the aggregate select can overwrite it");
  assert.match(directory, /SET unit_type=key, name=desired_name/, "a unit PUT compares and updates its type");
  assert.match(directory, /GRANT EXECUTE ON FUNCTION core\.directory_command\(text,jsonb\) TO junctura_directory_api/);
  assert.doesNotMatch(directory, /WHERE[\s\S]*?key=key/, "no plpgsql variable/column ambiguity");
  assert.match(directory, /INSERT INTO core\.schema_migrations\(version\) VALUES \(37\)/);
  const bindings = sql("036-subject-bindings.sql");
  assert.match(bindings, /PRIMARY KEY \(tenant_id, issuer, subject_id\),\n  UNIQUE \(tenant_id, issuer, login_subject\)/,
    "one subjectId per login subject and per tenant/issuer");
  assert.match(bindings, /GRANT EXECUTE ON FUNCTION core\.subject_binding\(jsonb\) TO junctura_subject_api/);
  assert.match(bindings, /RESET ROLE;\nREVOKE CREATE ON SCHEMA core/, "the migration role never writes the ledger");
  const consents = sql("038-verified-subject-consents.sql");
  assert.match(consents, /s\.canonical_subject = execution_private\.canonical_subject\(p_tenant,p_issuer,p_subject\)/,
    "the capability consent check resolves the canonical identity of the named person");
  assert.match(consents, /b\.login_subject=p_subject/, "resolution joins one way, from a login to its subjectId");
  assert.match(consents, /canonical_subject text/, "rows keep a separate canonical subject key");
  assert.match(consents, /SET canonical_subject = execution_private\.canonical_subject\(s\.tenant_id, s\.issuer, s\.data_subject\)/,
    "legacy rows are backfilled through the same one-way join");
  assert.match(consents, /subject-consent-limit/, "the active-consent limit counts under its own per-subject lock");
  assert.match(consents, /subject_binding_names_disjoint/, "subjectIds and login subjects never share identifiers");
  assert.match(consents, /x\.data_subject=sid AND e\.issuer=iss/, "the access log resolves the bound subjectId");
  for (const migration of [bindings, directory, consents]) {
    assert.match(migration, /RESET ROLE;\nREVOKE CREATE ON SCHEMA core/, "the ledger is written by the migration role");
  }
  assert.match(consents, /INSERT INTO core\.schema_migrations\(version\) VALUES \(38\)/);
});
