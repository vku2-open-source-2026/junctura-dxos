// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAuthorizer, organizationContext, validateIdentity } from "../src/platform/auth/auth.mjs";

const issuer = "http://identity.test/realms/junctura";
const claims = { active: true, iss: issuer, aud: "junctura-core", exp: 2000, sub: "subject", tenant_id: "tenant-a", tenant_memberships: ["tenant-a"], realm_access: { roles: ["core-reader", "core-writer"] } };
const bare = { subject: "subject", tenantId: "tenant-a", roles: ["core-reader", "core-writer"], units: [], groups: [] };
test("verified identity uses tenant and roles from issuer claims", () => {
  assert.deepEqual(validateIdentity(claims, issuer, 1000), bare);
});
test("verified identity exposes only the caller's own preferred username", () => {
  assert.deepEqual(validateIdentity({ ...claims, preferred_username: "admin1" }, issuer, 1000), {
    ...bare, preferredUsername: "admin1",
  });
  for (const preferred_username of ["", " ", "bad\u0000name", "x".repeat(256), 12]) {
    assert.deepEqual(validateIdentity({ ...claims, preferred_username }, issuer, 1000), bare);
  }
});
test("inactive, expired, wrong issuer/audience and missing subject tokens fail closed", () => {
  for (const patch of [{ active: false }, { exp: 999 }, { exp: "2000" }, { iss: "wrong" }, { aud: "wrong" }, { sub: null }]) {
    assert.throws(() => validateIdentity({ ...claims, ...patch }, issuer, 1000), (error) => error.status === 401);
  }
});
test("tenant and read-role claims are mandatory", () => {
  for (const patch of [{ tenant_id: "../tenant-b" }, { tenant_id: "tenant-b" }, { tenant_memberships: [] }, { tenant_id: null }, { realm_access: { roles: [] } }]) {
    assert.throws(() => validateIdentity({ ...claims, ...patch }, issuer, 1000), (error) => error.status === 403);
  }
});
test("missing bearer credentials never reach the identity provider", async () => {
  const authorize = createAuthorizer({ issuer }, () => { throw new Error("Should not be called"); });
  await assert.rejects(authorize({ headers: {} }), (error) => error.status === 401);
});
test("identity outages fail closed, without trusting caller tenant headers", async () => {
  const authorize = createAuthorizer({ issuer }, async () => { throw new Error("offline"); });
  await assert.rejects(authorize({ headers: { authorization: "Bearer token", "x-tenant-id": "tenant-a" } }), (error) => error.status === 503);
});
test("organization context keeps only the tenant namespace as units and /unit/group paths", () => {
  assert.deepEqual(organizationContext(["/tenant-a/unit-a", "/tenant-a/unit-a/reviewers", "/tenant-b/unit-z", "/other/thing",
    "/tenant-a/deeply/nested/group", "tenant-a/plain", 7, null], "tenant-a"),
  { units: ["unit-a"], groups: ["/unit-a/reviewers"] });
  assert.deepEqual(organizationContext(undefined, "tenant-a"), { units: [], groups: [] });
});
test("group claims deduplicate, sort and default to empty collections", () => {
  assert.deepEqual(validateIdentity({ ...claims, groups: ["/tenant-a/unit-b/reviewers", "/tenant-a/unit-a",
    "/tenant-a/unit-a/reviewers", "/tenant-a/unit-b"] }, issuer, 1000),
  { ...bare, units: ["unit-a", "unit-b"], groups: ["/unit-a/reviewers", "/unit-b/reviewers"] });
  for (const groups of [{}, "x", ["/tenant-a/unit-a/reviewers/", ""], ["/tenant-a/"]] ) {
    assert.deepEqual(validateIdentity({ ...claims, groups }, issuer, 1000).groups, []);
  }
});
test("a subjectId claim is kept as a candidate but never as the login subject", () => {
  assert.deepEqual(validateIdentity({ ...claims, subject_id: "subject-42" }, issuer, 1000),
    { ...bare, subjectId: "subject-42", subject: "subject" });
  for (const subject_id of ["", 42, {}, "has space", "ctrl\u0000", "x".repeat(129), "../escape"]) {
    assert.deepEqual(validateIdentity({ ...claims, subject_id }, issuer, 1000), bare, String(subject_id));
  }
  assert.deepEqual(validateIdentity({ ...claims, subject_id: "x".repeat(128) }, issuer, 1000),
    { ...bare, subjectId: "x".repeat(128) });
});
