// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Recreate the competition demo accounts on a running stack: the administrators
// and one read-only viewer. The accounts, their console principals and the
// browser login hints are generated here instead of being committed so a fresh
// server deploy can reproduce the demo without carrying credentials or database
// volumes in Git. Only the viewer is published in the browser hints; the
// administrator passwords stay in a private, Git-ignored file on the host.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { connectDemoStack, q } from "./lib/demo-stack.mjs";

export const DEMO_ADMINS = [
  { username: "admin1", firstName: "Admin", lastName: "1", label: "Admin 1", displayName: "Quản trị viên 1", jobTitle: "Quản trị nền tảng" },
  { username: "admin2", firstName: "Admin", lastName: "2", label: "Admin 2", displayName: "Quản trị viên 2", jobTitle: "Người duyệt ứng dụng" },
  { username: "admin3", firstName: "Admin", lastName: "3", label: "Admin 3", displayName: "Quản trị viên 3", jobTitle: "Người duyệt năng lực" },
];

export const ADMIN_PERMISSIONS = [
  "applications.register", "applications.approve", "trust.write", "trust.approve",
  "audit.read", "capabilities.write", "capabilities.publish", "capabilities.approve",
  "compositions.write", "compositions.publish", "compositions.approve",
];

// The account whose password is published to every visitor. It holds the
// reader role and audit.read only, so it can open every page but Core rejects
// each approval, revocation, registration or other write it attempts.
export const DEMO_VIEWER = { username: "viewer", firstName: "Demo", lastName: "Viewer", label: "Khách tham quan", displayName: "Khách tham quan", jobTitle: "Chỉ xem", viewer: true };

export const VIEWER_PERMISSIONS = ["audit.read"];

export const DEMO_ACCOUNTS = [...DEMO_ADMINS, DEMO_VIEWER];

const MANAGEMENT_CLIENT = "junctura-console";

export function parseHints(text) {
  const passwords = new Map();
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.accounts)) return passwords;
    for (const account of parsed.accounts) {
      if (!account || typeof account !== "object") continue;
      const { username, password } = account;
      if (typeof username === "string" && username.trim() && typeof password === "string") {
        passwords.set(username.trim(), password);
      }
    }
  } catch {
    // A missing or malformed hints file is replaced by the generated one.
  }
  return passwords;
}

export function planPasswords(profiles, passwords, generate = () => randomBytes(9).toString("base64url"), reset = false) {
  return profiles.map((profile) => ({
    ...profile,
    password: reset ? generate() : passwords.get(profile.username) ?? generate(),
  }));
}

export function toLoginHints(accounts) {
  return {
    accounts: accounts.map(({ username, password, label }) => ({ username, password, label })),
  };
}

// Browser hints are world-readable: publish the viewer only, unless the
// operator explicitly asks for the administrators too (local development).
export function publicAccounts(accounts, publicAdmins = false) {
  return publicAdmins ? accounts : accounts.filter(account => account.viewer === true);
}

// Administrator passwords are trusted only from the private file. A password
// that was ever served in the public hints is treated as disclosed, so an
// administrator missing from the private file gets a fresh one. The viewer may
// be reused from either file because it is public by design.
export function knownPasswords(privatePasswords, publicPasswords, publicAdmins = false) {
  const known = new Map(publicAdmins ? publicPasswords : []);
  if (publicPasswords.has(DEMO_VIEWER.username)) known.set(DEMO_VIEWER.username, publicPasswords.get(DEMO_VIEWER.username));
  for (const [username, password] of privatePasswords) known.set(username, password);
  return known;
}

export function buildPrincipalStatement({ tenant, issuer, subject, profile }) {
  return `INSERT INTO app_private.principals
    (tenant_id,issuer,subject,management_client,permissions,display_name,organization,job_title,kind,enabled)
    VALUES (${q(tenant)},${q(issuer)},${q(subject)},${q(MANAGEMENT_CLIENT)},
      ARRAY[${(profile.viewer === true ? VIEWER_PERMISSIONS : ADMIN_PERMISSIONS).map(q).join(",")}]::text[],
      ${q(profile.displayName)},${q("Junctura")},${q(profile.jobTitle)},'admin',true)
    ON CONFLICT (tenant_id,issuer,subject,management_client) DO UPDATE SET
      permissions=EXCLUDED.permissions, display_name=EXCLUDED.display_name,
      organization=EXCLUDED.organization, job_title=EXCLUDED.job_title,
      kind=EXCLUDED.kind, enabled=true;`;
}

function publicBase(value) {
  return value.trim().replace(/\/+$/, "");
}

async function main() {
  const { values } = parseArgs({ options: {
    tenant: { type: "string", default: "tenant-a" },
    base: { type: "string", default: process.env.PUBLIC_URL ?? "http://127.0.0.1:8080" },
    "admin-base": { type: "string", default: process.env.ADMIN_BASE ?? `http://127.0.0.1:${process.env.PORT ?? "8080"}` },
    hints: { type: "string", default: "console/public/login-hints.json" },
    credentials: { type: "string", default: ".junctura/demo-accounts.json" },
    "public-admins": { type: "boolean", default: false },
    "reset-passwords": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  } });
  if (values.help) {
    console.log(`Usage: node scripts/provision-demo-admins.mjs [options]

  --tenant <name>          Tenant for the demo administrators (default tenant-a)
  --base <url>             Public URL used for the token issuer (default PUBLIC_URL)
  --admin-base <url>       Internal Gateway URL for Keycloak admin calls (default loopback)
  --hints <path>           Public browser login hints (default console/public/login-hints.json)
  --credentials <path>     Private file with every demo password (default .junctura/demo-accounts.json)
  --public-admins          Also publish the administrators in the browser hints (local development only)
  --reset-passwords        Rotate passwords even when hints already exist
`);
    return;
  }
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(values.tenant)) throw new Error("Invalid --tenant");
  if (!values.base.trim()) throw new Error("--base must not be empty");
  if (!values["admin-base"].trim()) throw new Error("--admin-base must not be empty");

  const read = (path) => { try { return parseHints(readFileSync(path, "utf8")); } catch { return new Map(); } };
  const existing = knownPasswords(read(values.credentials), read(values.hints), values["public-admins"]);
  const accounts = planPasswords(DEMO_ACCOUNTS, existing, undefined, values["reset-passwords"]);
  const issuer = `${publicBase(values.base)}/identity/realms/junctura`;
  const stack = await connectDemoStack({ tenant: values.tenant, base: publicBase(values["admin-base"]) });
  const { admin, must, idFrom, group, roles, sql } = stack;
  const writerRoles = roles.filter(role => role.name !== "core-reader");
  const created = [];
  const reset = [];

  for (const account of accounts) {
    const found = await (await admin(`users?username=${encodeURIComponent(account.username)}&exact=true`)).json();
    let id = Array.isArray(found) ? found[0]?.id : undefined;
    if (!id) {
      const response = await must(await admin("users", {
        username: account.username,
        enabled: true,
        email: `${account.username}@junctura.invalid`,
        emailVerified: true,
        firstName: account.firstName,
        lastName: account.lastName,
        attributes: { tenant_id: [values.tenant] },
        credentials: [{ type: "password", value: account.password, temporary: false }],
      }), [201], `Create ${account.username}`);
      id = idFrom(response);
      created.push(account.username);
    } else if (!existing.has(account.username) || values["reset-passwords"]) {
      await must(await admin(`users/${id}/reset-password`, {
        type: "password", value: account.password, temporary: false,
      }, "PUT"), [204], `Reset ${account.username}`);
      reset.push(account.username);
    }
    await must(await admin(`users/${id}/groups/${group.id}`, undefined, "PUT"), [204], `Add ${account.username} to ${values.tenant}`);
    if (account.viewer === true) {
      await must(await admin(`users/${id}/role-mappings/realm`, roles.filter(role => role.name === "core-reader")), [204], `Assign reader role to ${account.username}`);
      await must(await admin(`users/${id}/role-mappings/realm`, writerRoles, "DELETE"), [204], `Remove writer roles from ${account.username}`);
    } else {
      await must(await admin(`users/${id}/role-mappings/realm`, roles), [204], `Assign roles to ${account.username}`);
    }
    await sql(buildPrincipalStatement({ tenant: values.tenant, issuer, subject: id, profile: account }));
  }

  mkdirSync(dirname(values.credentials), { recursive: true });
  writeFileSync(values.credentials, `${JSON.stringify(toLoginHints(accounts), null, 2)}\n`, { mode: 0o600 });
  chmodSync(values.credentials, 0o600);
  const published = publicAccounts(accounts, values["public-admins"]);
  mkdirSync(dirname(values.hints), { recursive: true });
  writeFileSync(values.hints, `${JSON.stringify(toLoginHints(published), null, 2)}\n`, { mode: 0o644 });
  chmodSync(values.hints, 0o644);

  console.log(`• Tài khoản demo: ${accounts.map(account => account.username).join(", ")}`);
  console.log(`• Tạo mới: ${created.length ? created.join(", ") : "không"}; đặt lại mật khẩu: ${reset.length ? reset.join(", ") : "không"}`);
  console.log(`• Login hints công khai: ${values.hints} — ${published.map(account => account.username).join(", ")} (đọc được bởi nginx, KHÔNG commit)`);
  console.log(`• Mật khẩu mọi tài khoản demo: ${values.credentials} (chỉ chủ máy đọc được, KHÔNG commit)`);
  console.log("• Rebuild Console để đưa hints vào image: docker compose --profile console build console && docker compose --profile console up -d console");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
