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
let dataDown = false;
let keycloakDown = false;
const store = { types: new Map(), units: new Map(), groups: new Map(), members: new Map() };
let data, keycloak, core, base;
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));

// A faithful-enough emulation of the directory RPC: prepare bumps the
// generation, confirm marks the generation as synchronized, deletes prepare
// under conflicts and confirm under the same generation.
function rpc(operation, payload) {
  const table = { unit_type: store.types, unit: store.units, group: store.groups, member: store.members };
  const kind = operation.replace(/_(put|confirm|delete|delete_confirm|list)$/, "");
  const rows = table[kind];
  const keyOf = row => { const value = row.desired ?? row;
    return kind === "unit_type" ? value.unitType : kind === "unit" ? value.unit :
      kind === "group" ? `${value.unit}/${value.group}` : `${value.unit}/${value.subject}`; };
  if (operation.endsWith("_list")) {
    const visible = [...rows.values()].sort((a, b) => keyOf(a) < keyOf(b) ? -1 : 1)
      .filter(row => !payload.after || keyOf(row) > payload.after);
    return { status: 200, value: { items: visible.slice(0, payload.limit).map(row => kind === "member"
      ? { unit: row.unit, subject: row.subject, groups: row.desired.groups } : { ...row.desired }), total: visible.length } };
  }
  if (operation.endsWith("_put")) {
    const existing = rows.get(keyOf(payload));
    const desired = { ...payload };
    if ((operation === "unit_put" && !store.types.has(desired.unitType)) ||
        (operation === "group_put" && !store.units.has(desired.unit)) ||
        (operation === "member_put" && (!store.units.has(desired.unit) ||
          desired.groups.some(group => !store.groups.has(`${desired.unit}/${group}`))))) {
      return { status: 404, error: "not_found" };
    }
    const same = existing && JSON.stringify(desired) === JSON.stringify(existing.desired);
    if (same && existing.synced_generation === existing.generation) {
      return { status: 200, generation: existing.generation, confirmed: true };
    }
    if (same) return { status: 200, generation: existing.generation };
    if (!existing) {
      rows.set(keyOf(payload), { desired, generation: 1, synced_generation: null });
      return { status: 201, generation: 1 };
    }
    existing.generation += 1; existing.synced_generation = null; existing.desired = desired;
    return { status: 200, generation: existing.generation };
  }
  if (operation.endsWith("_confirm")) {
    const existing = rows.get(keyOf(payload));
    if (operation.endsWith("delete_confirm")) {
      if (existing && existing.generation === payload.generation) rows.delete(keyOf(payload));
      return { status: 204 };
    }
    if (existing && existing.generation === payload.generation) existing.synced_generation = payload.generation;
    return { status: 204 };
  }
  if (operation.endsWith("_delete")) {
    const existing = rows.get(keyOf(payload));
    if (!existing) return { status: 204 };
    if (kind === "unit_type" && [...store.units.values()].some(row => row.desired.unitType === payload.unitType)) {
      return { status: 409, error: "resource_conflict" };
    }
    if (kind === "unit" && ([...store.groups.values()].some(row => row.desired.unit === payload.unit) ||
        [...store.members.values()].some(row => row.desired.unit === payload.unit))) {
      return { status: 409, error: "resource_conflict" };
    }
    if (kind === "group" && [...store.members.values()].some(row =>
      row.desired.unit === payload.unit && row.desired.groups.includes(payload.group))) {
      return { status: 409, error: "resource_conflict" };
    }
    return { status: 204, generation: existing.generation };
  }
  return { status: 400, error: "invalid_request" };
}

before(async () => {
  data = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (dataDown) { response.writeHead(503); return response.end(); }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(rpc(body.operation, body.payload)));
  });
  const dataUrl = await listen(data);

  // Minimal Keycloak: the admin paths and token endpoint the adapter uses.
  const realm = { groups: [{ id: "g-root", name: "tenant-a", path: "/tenant-a" }],
    users: [{ id: "u-1", username: "subject-42", groupIds: ["g-root"] }, { id: "u-2", username: "outsider", groupIds: [] }] };
  const childOf = (parentId, name) => realm.groups.find(group => group.parentId === parentId && group.name === name);
  keycloak = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    if (keycloakDown) { response.writeHead(503); return response.end(); }
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
      return response.end(JSON.stringify(realm.groups.filter(group => !group.parentId)
        .filter(group => !url.searchParams.get("search") || group.name === url.searchParams.get("search"))));
    }
    if (group) {
      const parent = realm.groups.find(item => item.id === group[1]);
      if (!parent) { response.statusCode = 404; return response.end(); }
      if (group[2]) { // children
        if (request.method === "POST") {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          realm.groups.push({ id: randomUUID(), name: body.name, parentId: parent.id, path: `${parent.path}/${body.name}` });
          response.statusCode = 201;
          return response.end();
        }
        return response.end(JSON.stringify(realm.groups.filter(item => item.parentId === parent.id)));
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
        if (request.method === "PUT") { person.groupIds = [...new Set([...person.groupIds ?? [], userPath[4]])]; response.statusCode = 204; return response.end(); }
        if (request.method === "DELETE") { person.groupIds = (person.groupIds ?? []).filter(id => id !== userPath[4]); response.statusCode = 204; return response.end(); }
      }
      if (userPath[2]) return response.end(JSON.stringify(realm.groups.filter(item => (person.groupIds ?? []).includes(item.id))
        .map(({ id, name, path }) => ({ id, name, path }))));
      return response.end(JSON.stringify(person));
    }
    response.end("{}");
  });
  const keycloakBase = await listen(keycloak);
  const identityUrl = `${keycloakBase}/identity/realms/junctura`;

  core = createServer(async (request, response) => {
    try {
      await handleDirectory(request, response, identity,
        { dataUrl, dataSecret: "x".repeat(32), identityUrl, directorySyncClientId: "junctura-directory-sync",
          directorySyncSecret: "y".repeat(32) }, new URL(request.url, "http://core"));
    } catch (error) {
      json(response, error instanceof HttpError ? error.status : 500, { error: error.message });
    }
  });
  base = await listen(core);
});
after(() => { data.close(); keycloak.close(); core.close(); });

const call = (path, method = "GET", body, who = identity) => fetch(base + path, {
  method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
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
  store.units.delete("unit-a");
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

test("the migrations bind generations, permissions and consent identity durably", () => {
  const sql = name => readFileSync(new URL(`../infra/postgres/${name}`, import.meta.url), "utf8");
  const directory = sql("037-directory-management.sql");
  assert.match(directory, /'compositions.approve','directory\.write'\]::text\[\]/, "directory.write joins the permission vocabulary");
  assert.match(directory, /PRIMARY KEY \(tenant_id, unit_type\)/);
  assert.match(directory, /synced_generation bigint/);
  assert.match(directory, /GRANT EXECUTE ON FUNCTION core\.directory_command\(text,jsonb\) TO junctura_directory_api/);
  assert.doesNotMatch(directory, /WHERE[\s\S]*?key=key/, "no plpgsql variable/column ambiguity");
  assert.match(directory, /INSERT INTO core\.schema_migrations\(version\) VALUES \(37\)/);
  const bindings = sql("036-subject-bindings.sql");
  assert.match(bindings, /PRIMARY KEY \(tenant_id, issuer, subject_id\),\n  UNIQUE \(tenant_id, issuer, login_subject\)/,
    "one subjectId per login subject and per tenant/issuer");
  assert.match(bindings, /GRANT EXECUTE ON FUNCTION core\.subject_binding\(jsonb\) TO junctura_subject_api/);
  const consents = sql("038-verified-subject-consents.sql");
  assert.match(consents, /data_subject=ANY\(execution_private\.subject_variants\(p_tenant,p_issuer,p_subject\)\)/,
    "the capability consent check resolves the bound identifiers");
  assert.match(consents, /idempotency_key_reused/);
  assert.match(consents, /INSERT INTO core\.schema_migrations\(version\) VALUES \(38\)/);
});
