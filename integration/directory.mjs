// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Directory management against the real stack: the desired state, the
// per-row generations and the Keycloak synchronization through the dedicated
// service account. Runs on CI where the full Compose stack is available.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { before, after, test } from "node:test";
import { promisify } from "node:util";
import { contractFetch as fetch, verifyContracts } from "./contract.mjs";
import { createAuthorityFixture } from "./fixtures/authority.mjs";
import { main as provisionDirectory } from "../scripts/provision-directory.mjs";

const base = process.env.PUBLIC_URL ?? "http://127.0.0.1:8080";
const issuer = `${base}/identity/realms/junctura`;
const prefix = `dir-test-${randomBytes(6).toString("hex")}`;
const clientIds = [];
const users = [];
const run = (...args) => promisify(execFile)("docker", args, { timeout: 180000 });
const sql = text => run("compose", "exec", "-T", "database", "psql", "-U", "junctura_admin", "-d", "junctura_data",
  "-v", "ON_ERROR_STOP=1", "-Atc", text);
const q = value => `'${String(value).replaceAll("'", "''")}'`;
const api = (path, who, body, headers = {}, method = body === undefined ? "GET" : "POST") =>
  fetch(base + path, { method, headers: { ...(who ? { Authorization: `Bearer ${who.token ?? who}` } : {}),
    ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
const fixture = createAuthorityFixture({ base, prefix, sql, q, api, clientIds, users });
const { operatorToken, admin, login, human } = fixture;
let manager, member;

before(async () => {
  // Repeatable realm provisioning: mappers, the sync service account, its roles.
  await provisionDirectory([], { log: () => {}, env: process.env });
  manager = await human("manager", "tenant-a", ["directory.write"]);
  member = await human("member", "tenant-a", []);
});

after(async () => {
  await operatorToken();
  const groups = await (await admin(`groups?search=tenant-a&exact=true`)).json();
  const root = groups.find(group => group.name === "tenant-a");
  if (root) for (const child of (await (await admin(`groups/${root.id}/children`)).json()) ?? []) {
    if (child.name.startsWith(prefix)) await admin(`groups/${child.id}`, undefined, "DELETE");
  }
  await sql(`DELETE FROM app_private.directory_memberships WHERE tenant_id='tenant-a' AND unit LIKE '${prefix}%';
    DELETE FROM app_private.directory_members WHERE tenant_id='tenant-a' AND unit LIKE '${prefix}%';
    DELETE FROM app_private.directory_groups WHERE tenant_id='tenant-a' AND unit LIKE '${prefix}%';
    DELETE FROM app_private.directory_units WHERE tenant_id='tenant-a' AND unit LIKE '${prefix}%';
    DELETE FROM app_private.directory_unit_types WHERE tenant_id='tenant-a' AND unit_type LIKE '${prefix}%';
    DELETE FROM app_private.subject_bindings WHERE tenant_id='tenant-a' AND subject_id LIKE '${prefix}%';`);
  for (const id of users) await admin(`users/${id}`, undefined, "DELETE");
  for (const id of clientIds) await admin(`clients/${id}`, undefined, "DELETE");
  await verifyContracts("directory");
});

const unitType = `${prefix}-office`;
const unit = `${prefix}-unit-a`;
const group = `${prefix}-reviewers`;

test("directory changes store desired state, sync Keycloak and confirm only the read-back generation", async () => {
  const created = await api(`/v1/directory/unit-types/${unitType}`, manager, { name: "Technical office" }, {}, "PUT");
  assert.equal(created.status, 201, await created.text());
  assert.deepEqual(await created.json(), { unitType, name: "Technical office" });
  const same = await api(`/v1/directory/unit-types/${unitType}`, manager, { name: "Technical office" }, {}, "PUT");
  assert.equal(same.status, 200, "an identical confirmed desired state is a no-op");
  assert.equal((await same.json()).name, "Technical office");

  const renamed = await api(`/v1/directory/unit-types/${unitType}`, manager, { name: "Technical offices" }, {}, "PUT");
  assert.equal(renamed.status, 200);

  const unitBody = { unitType, name: "Unit A" };
  const unitPut = await api(`/v1/directory/units/${unit}`, manager, unitBody, {}, "PUT");
  assert.equal(unitPut.status, 201);
  assert.deepEqual(await unitPut.json(), { unit, ...unitBody });

  const groupPut = await api(`/v1/directory/units/${unit}/groups/${group}`, manager, { name: "Reviewers" }, {}, "PUT");
  assert.equal(groupPut.status, 201);
  assert.deepEqual(await groupPut.json(), { unit, group, name: "Reviewers" });

  const memberPut = await api(`/v1/directory/units/${unit}/members/${member.id}`, manager, { groups: [group] }, {}, "PUT");
  assert.equal(memberPut.status, 201, await memberPut.text());
  assert.deepEqual(await memberPut.json(), { unit, subject: member.id, groups: [group] });

  // The provider state is verified through the operator admin API: the member
  // belongs to /tenant-a/{unit}/{group}, and the unit group exists.
  const memberGroups = await (await admin(`users/${member.id}/groups`)).json();
  assert.ok(memberGroups.some(item => item.path === `/tenant-a/${unit}/${group}`),
    JSON.stringify(memberGroups.map(item => item.path)));

  // A renewed token carries the verified organization context.
  const renewed = await login(member.username, member.password, member.clientId);
  const identity = await (await api("/v1/identity", renewed)).json();
  assert.deepEqual(identity.units, [unit]);
  assert.deepEqual(identity.groups, [`/${unit}/${group}`]);
  assert.equal(identity.subject, member.id);
});

test("lists paginate in ascending order with cursors and require the permission", async () => {
  const types = await (await api(`/v1/directory/unit-types?limit=1`, manager)).json();
  assert.equal(types.items.length, 1);
  assert.notEqual(types.nextCursor, null);
  const rest = await (await api(`/v1/directory/unit-types?limit=100&cursor=${types.nextCursor}`, manager)).json();
  assert.ok(rest.items.every(item => item.unitType > types.items[0].unitType));
  assert.equal(rest.nextCursor, null);
  const units = await (await api("/v1/directory/units", manager)).json();
  assert.ok(units.items.some(item => item.unit === unit && item.unitType === unitType));
  const groups = await (await api(`/v1/directory/units/${unit}/groups`, manager)).json();
  assert.ok(groups.items.some(item => item.group === group));
  const members = await (await api(`/v1/directory/units/${unit}/members`, manager)).json();
  assert.ok(members.items.some(item => item.subject === member.id && item.groups[0] === group));

  for (const who of [member]) assert.equal((await api("/v1/directory/units", who)).status, 403,
    "without directory.write the lists refuse");
  assert.equal((await api("/v1/directory/units?cursor=%00", manager)).status, 400);
  assert.equal((await api(`/v1/directory/units/${unit}/groups`, manager, undefined, {}, "POST")).status, 405);
});

test("references, conflicts, racing writes and deletes follow the documented contract", async () => {
  assert.equal((await api(`/v1/directory/units/${prefix}-other`, manager,
    { unitType: `${prefix}-missing`, name: "X" }, {}, "PUT")).status, 404);
  assert.equal((await api(`/v1/directory/units/${unit}/groups/${prefix}-ghost`, manager,
    { name: "X" }, {}, "PUT")).status, 404);
  assert.equal((await api(`/v1/directory/units/${unit}/members/99999999-outside-tenant`, manager,
    { groups: [] }, {}, "PUT")).status, 404, "the login subject must exist in this tenant");
  assert.equal((await api(`/v1/directory/units/${unit}`, manager, { unitType, name: "x" }, {}, "PUT")).status, 400,
    "name shape violations stay 400");
  assert.equal((await api(`/v1/directory/unit-types/${unitType}`, manager, { name: "x".repeat(121) }, {}, "PUT")).status, 400);

  // Deleting anything still referenced conflicts.
  assert.equal((await api(`/v1/directory/unit-types/${unitType}`, manager, undefined, {}, "DELETE")).status, 409);
  assert.equal((await api(`/v1/directory/units/${unit}`, manager, undefined, {}, "DELETE")).status, 409);
  assert.equal((await api(`/v1/directory/units/${unit}/groups/${group}`, manager, undefined, {}, "DELETE")).status, 409);

  // Racing PUTs serialize; the final desired state and the provider agree.
  const races = await Promise.all([
    api(`/v1/directory/units/${unit}/groups/${group}`, manager, { name: "Race A" }, {}, "PUT"),
    api(`/v1/directory/units/${unit}/groups/${group}`, manager, { name: "Race B" }, {}, "PUT"),
  ]);
  assert.deepEqual(races.map(response => response.status).sort(), [200, 200]);
  const root = (await (await admin(`groups?search=tenant-a&exact=true`)).json()).find(item => item.name === "tenant-a");
  const children = await (await admin(`groups/${root.id}/children`)).json();
  assert.ok(children.some(item => item.name === unit), "the racing renames leave the provider group in place");
  const members = await (await api(`/v1/directory/units/${unit}/members`, manager)).json();
  assert.equal(members.items[0].groups[0], group, "the membership survives racing group renames");

  // Deletes converge and repeat as 204; the provider loses the membership.
  assert.equal((await api(`/v1/directory/units/${unit}/members/${member.id}`, manager, undefined, {}, "DELETE")).status, 204);
  assert.equal((await api(`/v1/directory/units/${unit}/members/${member.id}`, manager, undefined, {}, "DELETE")).status, 204);
  const memberGroups = await (await admin(`users/${member.id}/groups`)).json();
  assert.ok(!memberGroups.some(item => item.path?.startsWith(`/tenant-a/${unit}`)), "the provider removed the membership");
  assert.equal((await api(`/v1/directory/units/${unit}/groups/${group}`, manager, undefined, {}, "DELETE")).status, 204);
  assert.equal((await api(`/v1/directory/units/${unit}`, manager, undefined, {}, "DELETE")).status, 204);
  assert.equal((await api(`/v1/directory/unit-types/${unitType}`, manager, undefined, {}, "DELETE")).status, 204);
  assert.equal((await api(`/v1/directory/unit-types/${unitType}`, manager, undefined, {}, "DELETE")).status, 204);
});

test("a wiped provider subtree heals on the next write of the same desired state", async () => {
  await api(`/v1/directory/unit-types/${unitType}`, manager, { name: "Technical office" }, {}, "PUT");
  await api(`/v1/directory/units/${unit}`, manager, { unitType, name: "Unit A" }, {}, "PUT");
  await api(`/v1/directory/units/${unit}/groups/${group}`, manager, { name: "Reviewers" }, {}, "PUT");
  const root = (await (await admin(`groups?search=tenant-a&exact=true`)).json()).find(group => group.name === "tenant-a");
  const children = await (await admin(`groups/${root.id}/children`)).json();
  const unitGroup = children.find(item => item.name === unit);
  await admin(`groups/${unitGroup.id}`, undefined, "DELETE");
  const healed = await api(`/v1/directory/units/${unit}/groups/${group}`, manager, { name: "Reviewers" }, {}, "PUT");
  assert.equal(healed.status, 200, await healed.text());
  const rebuilt = await (await admin(`users/${member.id}/groups`)).json();
  const memberPut = await api(`/v1/directory/units/${unit}/members/${member.id}`, manager, { groups: [group] }, {}, "PUT");
  assert.equal(memberPut.status, 201);
  const after = await (await admin(`users/${member.id}/groups`)).json();
  assert.ok(after.some(item => item.path === `/tenant-a/${unit}/${group}`), "the recreated subtree holds the member again");
  assert.equal((await api(`/v1/directory/units/${unit}/members/${member.id}`, manager, undefined, {}, "DELETE")).status, 204);
  assert.equal((await api(`/v1/directory/units/${unit}/groups/${group}`, manager, undefined, {}, "DELETE")).status, 204);
  assert.equal((await api(`/v1/directory/units/${unit}`, manager, undefined, {}, "DELETE")).status, 204);
  assert.equal((await api(`/v1/directory/unit-types/${unitType}`, manager, undefined, {}, "DELETE")).status, 204);
});
