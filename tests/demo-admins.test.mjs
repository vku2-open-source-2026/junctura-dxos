// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ADMIN_PERMISSIONS,
  DEMO_ACCOUNTS,
  DEMO_ADMINS,
  DEMO_VIEWER,
  VIEWER_PERMISSIONS,
  buildPrincipalStatement,
  knownPasswords,
  parseHints,
  planPasswords,
  publicAccounts,
  toLoginHints,
} from "../scripts/provision-demo-admins.mjs";

test("parseHints keeps valid account passwords and ignores malformed entries", () => {
  const passwords = parseHints(JSON.stringify({ accounts: [
    { username: "admin1", password: "one" },
    { username: " ", password: "ignored" },
    { username: "admin2" },
    null,
  ] }));
  assert.deepEqual([...passwords.entries()], [["admin1", "one"]]);
  assert.deepEqual([...parseHints("not json").entries()], []);
});

test("planPasswords reuses hints, generates missing passwords, and rotates on reset", () => {
  const existing = new Map([["admin1", "kept"]]);
  const generated = ["new2", "new3"];
  const reused = planPasswords(DEMO_ADMINS.slice(0, 3), existing, () => generated.shift());
  assert.deepEqual(reused.map(({ username, password }) => [username, password]), [
    ["admin1", "kept"],
    ["admin2", "new2"],
    ["admin3", "new3"],
  ]);
  const rotated = planPasswords(DEMO_ADMINS.slice(0, 1), existing, () => "rotated", true);
  assert.equal(rotated[0].password, "rotated");
});

test("toLoginHints emits only the browser-facing fields", () => {
  const hints = toLoginHints(DEMO_ADMINS.slice(0, 1).map(profile => ({ ...profile, password: "secret" })));
  assert.deepEqual(hints, { accounts: [{ username: "admin1", password: "secret", label: "Admin 1" }] });
});

test("principal statement escapes text and grants the full demo permission set", () => {
  const statement = buildPrincipalStatement({
    tenant: "tenant-a",
    issuer: "https://demo.example/identity/realms/junctura",
    subject: "subject-id",
    profile: { ...DEMO_ADMINS[0], displayName: "Quản trị 'viên'" },
  });
  assert.match(statement, /'Quản trị ''viên'''/);
  assert.match(statement, /ON CONFLICT \(tenant_id,issuer,subject,management_client\) DO UPDATE/);
  for (const permission of ADMIN_PERMISSIONS) assert.ok(statement.includes(`'${permission}'`));
});

test("only the viewer is published unless administrators are explicitly made public", () => {
  const accounts = DEMO_ACCOUNTS.map(profile => ({ ...profile, password: "p" }));
  assert.deepEqual(publicAccounts(accounts).map(account => account.username), ["viewer"]);
  assert.deepEqual(publicAccounts(accounts, true).map(account => account.username), ["admin1", "admin2", "admin3", "viewer"]);
});

test("the viewer principal is read-only and never receives a write permission", () => {
  assert.deepEqual(VIEWER_PERMISSIONS, ["audit.read"]);
  const statement = buildPrincipalStatement({ tenant: "tenant-a", issuer: "https://demo.example/identity/realms/junctura", subject: "viewer-id", profile: DEMO_VIEWER });
  assert.ok(statement.includes("ARRAY['audit.read']::text[]"));
  for (const permission of ADMIN_PERMISSIONS.filter(name => name !== "audit.read")) assert.ok(!statement.includes(`'${permission}'`));
});

test("administrator passwords once served publicly are not reused", () => {
  const leaked = new Map([["admin1", "leaked"], ["viewer", "public"]]);
  const rotated = knownPasswords(new Map(), leaked);
  assert.deepEqual([...rotated.entries()], [["viewer", "public"]]);
  const kept = knownPasswords(new Map([["admin1", "private"]]), leaked);
  assert.equal(kept.get("admin1"), "private");
  assert.equal(knownPasswords(new Map(), leaked, true).get("admin1"), "leaked");
});
