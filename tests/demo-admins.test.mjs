// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ADMIN_PERMISSIONS,
  DEMO_ADMINS,
  buildPrincipalStatement,
  parseHints,
  planPasswords,
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
