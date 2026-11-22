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
