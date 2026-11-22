// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DESIRED_MAPPERS,
  DIRECTORY_SYNC_CLIENT,
  DIRECTORY_SYNC_ROLES,
  bindingStatement,
  driftedMappers,
  mapperPatch,
  main,
  missingMappers,
  parseAssignments,
  subjectIdProfilePatch,
} from "../scripts/provision-directory.mjs";

const clientWith = mappers => ({ id: "client-1", protocolMappers: mappers });
const existing = config => ({ id: "mapper-id", name: "tenant-memberships", protocol: "openid-connect",
  protocolMapper: "oidc-group-membership-mapper",
  config: { "access.token.claim": "true", "claim.name": "tenant_memberships", "introspection.token.claim": "true", ...config } });

test("desired mappers carry full tenant membership paths and the subjectId claim", () => {
  const memberships = DESIRED_MAPPERS.find(mapper => mapper.name === "tenant-memberships");
  assert.equal(memberships.config["full.path"], "true");
  assert.equal(DESIRED_MAPPERS.some(mapper => mapper.name === "subject-id"), true);
});

test("missing mappers are added and drifted ones are aligned, including a leaf-name membership mapper", () => {
  const client = clientWith([existing({ "claim.name": "tenant_memberships", "full.path": "false" })]);
  const missing = missingMappers(client);
  assert.deepEqual(missing.map(mapper => mapper.name), ["org-groups", "subject-id"]);
  const drifted = driftedMappers(client);
  assert.deepEqual(drifted.map(mapper => mapper.name), ["tenant-memberships"],
    "a mapper with full.path=false is a drift, not a match");
  assert.deepEqual(driftedMappers(clientWith([existing({ "claim.name": "tenant_memberships", "full.path": "true" })])), []);
});

test("mapper patches never leak provider ids into an update", () => {
  const patched = mapperPatch(clientWith([existing({ "claim.name": "tenant_memberships", "full.path": "true" })]),
    DESIRED_MAPPERS.filter(mapper => mapper.name !== "tenant-memberships"));
  for (const mapper of patched.protocolMappers) assert.equal(mapper.id, undefined);
  assert.equal(patched.protocolMappers.length, 3);
});

test("the sync service account never needs manage-realm", () => {
  assert.equal(DIRECTORY_SYNC_ROLES.includes("manage-realm"), false,
    "group management under Keycloak 26.8.1 comes with manage-users");
  assert.ok(DIRECTORY_SYNC_CLIENT.length > 0);
});

test("assignments parse strictly and keep their shape", () => {
  assert.deepEqual(parseAssignments(["alice=subject-1", " bob =subject:2"]), [
    { username: "alice", subjectId: "subject-1" }, { username: "bob", subjectId: "subject:2" }]);
  for (const value of ["", "=x", "no-equals", "bad=has space"]) {
    assert.throws(() => parseAssignments([value]));
  }
});

test("the binding statement converges on its own assignment and never rebinds silently", () => {
  const values = { tenant: "tenant-a", issuer: "https://issuer.invalid", username: "alice",
    subjectId: "subject-1", loginSubject: "login-1" };
  const statement = bindingStatement(values);
  assert.match(statement, /VALUES\('tenant-a','https:\/\/issuer\.invalid','subject-1','login-1'\)/);
  assert.match(statement, /WHERE app_private\.subject_bindings\.login_subject='login-1';\s*$/);
  assert.doesNotMatch(statement, /login_subject=EXCLUDED\.login_subject/,
    "a different login for the same subjectId must go through reconciliation, not provisioning");
  const quoted = bindingStatement({ ...values, loginSubject: "log'in" });
  assert.match(quoted, /'log''in'/, "SQL literals are escaped");
});

test("the subjectId profile property is managed and admin-only", () => {
  const profile = subjectIdProfilePatch(undefined);
  const property = profile.attributes.find(attribute => attribute.name === "subject_id");
  assert.deepEqual(property.permissions, { view: ["admin"], edit: ["admin"] });
  const merged = subjectIdProfilePatch({ attributes: [{ name: "subject_id", permissions: { view: ["admin", "user"], edit: ["user"] } },
    { name: "tenant_id" }] });
  assert.deepEqual(merged.attributes.find(attribute => attribute.name === "subject_id").permissions,
    { view: ["admin"], edit: ["admin"] }, "an existing user-editable declaration is overridden");
  assert.equal(merged.attributes.length, 2, "unrelated attributes are preserved");
});

test("provisioning creates the sync client, aligns old clients and removes excess authority", async () => {
  const clients = [{ id: "management", clientId: "realm-management", protocol: "openid-connect" },
    { id: "legacy", clientId: "previously-enrolled-app", protocol: "openid-connect" }];
  const mappers = [existing({ "full.path": "false" })];
  const roles = DIRECTORY_SYNC_ROLES.map(name => ({ id: `id-${name}`, name }));
  let assigned = [];
  let rotatedSecretInvalidated = false;
  let profile = { attributes: [] };
  let writes = 0;
  const response = value => Response.json(value);
  const ok = status => new Response(null, { status });
  const admin = async (path, body, method = body === undefined ? "GET" : "PUT") => {
    if (path === "clients") {
      assert.equal(method, "POST");
      clients.push({ ...body, id: "sync" });
      return ok(201);
    }
    if (path.startsWith("clients?")) {
      const query = new URLSearchParams(path.split("?")[1]);
      return response(query.has("clientId") ? clients.filter(client => client.clientId === query.get("clientId"))
        : clients.slice(Number(query.get("first")), Number(query.get("first")) + 2));
    }
    if (path === "clients/sync/service-account-user") return response({ id: "sync-user" });
    if (path === "clients/sync/client-secret") return response({ value: clients.find(client => client.id === "sync").secret });
    if (path === "clients/sync/client-secret/rotated") {
      assert.equal(method, "DELETE");
      rotatedSecretInvalidated = true;
      return ok(204);
    }
    if (path === "clients/sync") {
      assert.equal(method, "PUT");
      Object.assign(clients.find(client => client.id === "sync"), body);
      writes++;
      return ok(204);
    }
    if (path === "users/sync-user/role-mappings/clients/management") {
      if (method === "GET") return response(assigned);
      if (method === "DELETE") assigned = assigned.filter(role => !body.some(item => role.id === item.id));
      if (method === "POST") { assert.deepEqual(body, roles); assigned.push(...body); }
      return ok(204);
    }
    if (path === "clients/management/roles?max=100") return response(roles);
    if (path.endsWith("/protocol-mappers/models")) {
      if (path !== "clients/legacy/protocol-mappers/models") return response([]);
      if (method === "GET") return response(mappers);
      mappers.push({ ...body, id: body.name });
      return ok(201);
    }
    if (path === "clients/legacy/protocol-mappers/models/mapper-id") {
      assert.equal(method, "PUT");
      mappers[0] = structuredClone(body);
      return ok(204);
    }
    if (path === "users/profile") {
      if (method === "PUT") profile = body;
      return response(profile);
    }
    assert.fail(`Unknown fixture endpoint ${method} ${path}`);
  };
  const env = { KEYCLOAK_ADMIN_PASSWORD: "fixture", DIRECTORY_SYNC_CLIENT_SECRET: "fixture-replacement" };
  const provision = current => main([], { env: current, log: () => {}, runOperator: async () => admin });
  await provision(env);
  const sync = clients.find(client => client.id === "sync");
  assert.equal(sync.enabled, true);
  assert.equal(sync.secret, env.DIRECTORY_SYNC_CLIENT_SECRET);
  assert.deepEqual(assigned, roles);
  assert.deepEqual(profile.attributes.find(entry => entry.name === "subject_id").permissions,
    { view: ["admin"], edit: ["admin"] });
  assert.equal(mappers.length, 3);
  assert.equal(mappers[0].config["full.path"], "true");

  mappers[0].config["full.path"] = "false";
  await provision(env);
  assert.equal(mappers[0].config["full.path"], "true");
  assert.equal(writes, 1, "fixing a mapper leaves a healthy client online");
  assigned.push({ id: "excess", name: "manage-realm" });
  rotatedSecretInvalidated = false;
  await provision({ KEYCLOAK_ADMIN_PASSWORD: "fixture" });
  assert.equal(sync.enabled, false);
  assert.equal(rotatedSecretInvalidated, true);
  assert.deepEqual(assigned, roles);
});
