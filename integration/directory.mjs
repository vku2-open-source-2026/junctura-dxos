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
const { operatorToken, admin, login, human, verifiedSubject, cleanupSubjectBindings } = fixture;
let manager, member, raceMember;

before(async () => {
  await operatorToken();
  const importedProfile = await (await admin("users/profile")).json();
  assert.deepEqual(importedProfile.attributes.find(entry => entry.name === "subject_id")?.permissions,
    { view: ["admin"], edit: ["admin"] }, "realm import protects subject_id before provisioning");
  // A dedicated operator-managed PKCE client keeps fixture changes local, the
  // way the capability suite prepares its own management client.
  const template = (await (await admin("clients?clientId=tenant-a")).json())[0];
  const source = await (await admin(`clients/${template.id}`)).json();
  const protocolMappers = structuredClone(source.protocolMappers);
  for (const mapper of protocolMappers) delete mapper.id;
  protocolMappers.find(mapper => mapper.name === "tenant-memberships").config["full.path"] = "false";
  const createdClient = await admin("clients", { clientId: `${prefix}-management-tenant-a`, enabled: true,
    protocol: "openid-connect", publicClient: true, standardFlowEnabled: true, directAccessGrantsEnabled: false,
    redirectUris: ["http://127.0.0.1:9876/callback"], attributes: { "pkce.code.challenge.method": "S256" },
    protocolMappers }, "POST");
  assert.equal(createdClient.status, 201);
  clientIds.push(createdClient.headers.get("location").split("/").at(-1));
  // This older client predates provisioning and is absent from its default names.
  await provisionDirectory([], { log: () => {}, env: process.env });
  manager = await human("manager", "tenant-a", ["directory.write"]);
  member = await human("member", "tenant-a", []);
  raceMember = await human("race-member", "tenant-a", []);
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
    DELETE FROM app_private.principals WHERE tenant_id='tenant-a' AND subject IN (${users.map(q).join(",") || "NULL"});`);
  await cleanupSubjectBindings();
  for (const id of users) await admin(`users/${id}`, undefined, "DELETE");
  for (const id of clientIds) await admin(`clients/${id}`, undefined, "DELETE");
  await verifyContracts("directory");
});

const unitType = `${prefix}-office`;
const unit = `${prefix}-unit-a`;
const group = `${prefix}-reviewers`;

test("provisioning upgrades old client tokens and rejects a nested group with the tenant root name", async () => {
  const identity = await api("/v1/identity", manager);
  assert.equal(identity.status, 200);
  const claims = JSON.parse(Buffer.from(manager.token.split(".")[1], "base64url"));
  assert.ok(claims.tenant_memberships.includes("/tenant-a"));
  const roots = await (await admin("groups")).json();
  const tenantA = roots.find(item => item.path === "/tenant-a");
  const tenantB = roots.find(item => item.path === "/tenant-b");
  const nested = await admin(`groups/${tenantB.id}/children`, { name: "tenant-a" }, "POST");
  assert.equal(nested.status, 201);
  const nestedId = nested.headers.get("location").split("/").at(-1);
  try {
    assert.equal((await admin(`users/${raceMember.id}/groups/${nestedId}`, undefined, "PUT")).status, 204);
    assert.equal((await admin(`users/${raceMember.id}/groups/${tenantA.id}`, undefined, "DELETE")).status, 204);
    const token = await login(raceMember.username, raceMember.password, raceMember.clientId);
    const rejected = await api("/v1/identity", token);
    assert.equal(rejected.status, 403);
    assert.equal((await rejected.json()).error, "tenant_required");
  } finally {
    await admin(`groups/${nestedId}`, undefined, "DELETE");
    await admin(`users/${raceMember.id}/groups/${tenantA.id}`, undefined, "PUT");
  }
});

test("the Account API cannot change subject_id, and new tokens carry the operator assignment", async () => {
  const subjectId = `${prefix}:member`;
  const assigned = await verifiedSubject(member, subjectId);
  const account = `${issuer}/account/`;
  const headers = { Authorization: `Bearer ${assigned.token}`, Accept: "application/json", "Content-Type": "application/json" };
  const view = await globalThis.fetch(account, { headers });
  assert.equal(view.status, 200);
  const profile = await view.json();
  const response = await globalThis.fetch(account, { method: "POST", headers,
    body: JSON.stringify({ ...profile, attributes: { ...profile.attributes, subject_id: [`${prefix}:forged`] } }) });
  assert.ok([204, 400].includes(response.status), await response.text());
  const stored = await (await admin(`users/${member.id}`)).json();
  assert.deepEqual(stored.attributes.subject_id, [subjectId]);
  const token = await login(member.username, member.password, member.clientId);
  assert.equal(JSON.parse(Buffer.from(token.split(".")[1], "base64url")).subject_id, subjectId);
  assert.equal((await (await api("/v1/identity", token)).json()).subjectId, subjectId);
});

test("directory changes store desired state, sync Keycloak and confirm only the read-back generation", async () => {
  const created = await api(`/v1/directory/unit-types/${unitType}`, manager, { name: "Technical office" }, {}, "PUT");
  assert.equal(created.status, 201, await created.clone().text());
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
  assert.equal(memberPut.status, 201, await memberPut.clone().text());
  assert.deepEqual(await memberPut.json(), { unit, subject: member.id, groups: [group] });

  // The provider state is verified through the operator admin API: the member
  // belongs to /tenant-a/{unit}/{group}, and the unit group exists.
  const memberGroups = await (await admin(`users/${member.id}/groups`)).json();
  assert.ok(memberGroups.some(item => item.path === `/tenant-a/${unit}/${group}`),
    JSON.stringify(memberGroups.map(item => item.path)));

  const secondUnit = `${prefix}-unit-b`;
  assert.equal((await api(`/v1/directory/units/${secondUnit}`, manager,
    { unitType, name: "Unit B" }, {}, "PUT")).status, 201);
  try {
    assert.equal((await api(`/v1/directory/units/${secondUnit}/members/${member.id}`, manager,
      { groups: [] }, {}, "PUT")).status, 201);

    const renewed = await login(member.username, member.password, member.clientId);
    const response = await api("/v1/identity", renewed, undefined, { "X-Junctura-Unit": `${prefix}-outside` });
    assert.equal(response.status, 200);
    const identity = await response.json();
    assert.deepEqual(identity.units, [unit, secondUnit]);
    assert.deepEqual(identity.unitPaths, [{ id: unit, path: `/tenant-a/${unit}` },
      { id: secondUnit, path: `/tenant-a/${secondUnit}` }]);
    assert.deepEqual(identity.groups, [`/${unit}/${group}`]);
    assert.equal(identity.subject, member.id);
  } finally {
    assert.equal((await api(`/v1/directory/units/${secondUnit}/members/${member.id}`, manager,
      undefined, {}, "DELETE")).status, 204);
    assert.equal((await api(`/v1/directory/units/${secondUnit}`, manager, undefined, {}, "DELETE")).status, 204);
  }
});

test("lists paginate in ascending order with cursors and require the permission", async () => {
  // A second unit type of this run makes the fixture hold two pages.
  const deskType = `${prefix}-desk`;
  const desk = await api(`/v1/directory/unit-types/${deskType}`, manager, { name: "Desk" }, {}, "PUT");
  assert.equal(desk.status, 201, await desk.clone().text());
  try {
    const types = await (await api(`/v1/directory/unit-types?limit=1`, manager)).json();
    assert.equal(types.items.length, 1);
    assert.ok(types.items[0].unitType.startsWith(prefix), "this run owns the first page");
    assert.notEqual(types.nextCursor, null);
    const rest = await (await api(`/v1/directory/unit-types?limit=100&cursor=${types.nextCursor}`, manager)).json();
    assert.deepEqual(rest.items.map(item => item.unitType), [unitType]);
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
  } finally {
    assert.equal((await api(`/v1/directory/unit-types/${deskType}`, manager, undefined, {}, "DELETE")).status, 204);
  }
});

test("references, conflicts, racing writes and deletes follow the documented contract", async () => {
  assert.equal((await api(`/v1/directory/units/${prefix}-other`, manager,
    { unitType: `${prefix}-missing`, name: "X" }, {}, "PUT")).status, 404);
  assert.equal((await api(`/v1/directory/units/${prefix}-absent/groups/${prefix}-ghost`, manager,
    { name: "X" }, {}, "PUT")).status, 404);
  assert.equal((await api(`/v1/directory/units/${unit}/members/99999999-outside-tenant`, manager,
    { groups: [] }, {}, "PUT")).status, 404, "the login subject must exist in this tenant");
  assert.equal((await api(`/v1/directory/units/${unit}`, manager, { unitType, name: "" }, {}, "PUT")).status, 400,
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
  const statuses = races.map(response => response.status).sort();
  assert.equal(statuses[0], 200);
  assert.ok([200, 409].includes(statuses[1]));
  const root = (await (await admin(`groups?search=tenant-a&exact=true`)).json()).find(item => item.name === "tenant-a");
  const children = await (await admin(`groups/${root.id}/children`)).json();
  assert.ok(children.some(item => item.name === unit), "the racing renames leave the provider group in place");
  const members = await (await api(`/v1/directory/units/${unit}/members`, manager)).json();
  assert.equal(members.items[0].groups[0], group, "the membership survives racing group renames");

  // A member write racing the deletion of its group ends in exactly one
  // documented outcome and the desired state stays consistent.
  assert.equal((await api(`/v1/directory/units/${unit}/members/${member.id}`, manager, undefined, {}, "DELETE")).status, 204);
  const shared = await Promise.all([
    api(`/v1/directory/units/${unit}/members/${raceMember.id}`, manager, { groups: [group] }, {}, "PUT"),
    api(`/v1/directory/units/${unit}/groups/${group}`, manager, undefined, {}, "DELETE"),
  ]);
  assert.ok(
    (shared[0].status === 201 && shared[1].status === 409) ||
      ([404, 409].includes(shared[0].status) && shared[1].status === 204),
    `the race ends in one documented outcome, got ${shared[0].status}/${shared[1].status}`);
  const providerGroups = await (await admin(`users/${raceMember.id}/groups`)).json();
  if (shared[0].status === 201) {
    assert.ok(providerGroups.some(item => item.path === `/tenant-a/${unit}/${group}`),
      "a surviving member holds its group at the provider");
    assert.equal((await api(`/v1/directory/units/${unit}/members/${raceMember.id}`, manager, undefined, {}, "DELETE")).status, 204);
  } else {
    assert.ok(!providerGroups.some(item => item.path?.startsWith(`/tenant-a/${unit}`)),
      "a refused member leaves no provider membership");
  }

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

test("recreating a deleted type, unit and group returns 201 and allows a new member with no groups", async () => {
  for (const [path, body] of [
    [`/v1/directory/unit-types/${unitType}`, { name: "Office" }],
    [`/v1/directory/units/${unit}`, { unitType, name: "Unit" }],
    [`/v1/directory/units/${unit}/groups/${group}`, { name: "Group" }],
  ]) {
    const recreated = await api(path, manager, body, {}, "PUT");
    assert.equal(recreated.status, 201, await recreated.clone().text());
  }
  const path = `/v1/directory/units/${unit}/members/${raceMember.id}`;
  const empty = await api(path, manager, { groups: [] }, {}, "PUT");
  assert.equal(empty.status, 201, await empty.clone().text());
  assert.deepEqual((await empty.json()).groups, []);
  for (const deletedPath of [path, `/v1/directory/units/${unit}/groups/${group}`,
    `/v1/directory/units/${unit}`, `/v1/directory/unit-types/${unitType}`]) {
    assert.equal((await api(deletedPath, manager, undefined, {}, "DELETE")).status, 204);
  }
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
  assert.equal(healed.status, 200, await healed.clone().text());
  const memberPut = await api(`/v1/directory/units/${unit}/members/${member.id}`, manager, { groups: [group] }, {}, "PUT");
  assert.equal(memberPut.status, 201);
  const after = await (await admin(`users/${member.id}/groups`)).json();
  assert.ok(after.some(item => item.path === `/tenant-a/${unit}/${group}`), "the recreated subtree holds the member again");
  assert.equal((await api(`/v1/directory/units/${unit}/members/${member.id}`, manager, undefined, {}, "DELETE")).status, 204);
  assert.equal((await api(`/v1/directory/units/${unit}/groups/${group}`, manager, undefined, {}, "DELETE")).status, 204);
  assert.equal((await api(`/v1/directory/units/${unit}`, manager, undefined, {}, "DELETE")).status, 204);
  assert.equal((await api(`/v1/directory/unit-types/${unitType}`, manager, undefined, {}, "DELETE")).status, 204);
});
