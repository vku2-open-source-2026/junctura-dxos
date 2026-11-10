// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Recreate the local competition demo administrators on a running stack. The
// accounts, their console principals and the browser login hints are generated
// here instead of being committed so a fresh server deploy can reproduce the
// local demo without carrying credentials or database volumes in Git.
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

export function buildPrincipalStatement({ tenant, issuer, subject, profile }) {
  return `INSERT INTO app_private.principals
    (tenant_id,issuer,subject,management_client,permissions,display_name,organization,job_title,kind,enabled)
    VALUES (${q(tenant)},${q(issuer)},${q(subject)},${q(MANAGEMENT_CLIENT)},
      ARRAY[${ADMIN_PERMISSIONS.map(q).join(",")}]::text[],
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
    "reset-passwords": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  } });
  if (values.help) {
    console.log(`Usage: node scripts/provision-demo-admins.mjs [options]

  --tenant <name>          Tenant for the demo administrators (default tenant-a)
  --base <url>             Public URL used for the token issuer (default PUBLIC_URL)
  --admin-base <url>       Internal Gateway URL for Keycloak admin calls (default loopback)
  --hints <path>           Browser login hints output (default console/public/login-hints.json)
  --reset-passwords        Rotate passwords even when hints already exist
`);
    return;
  }
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(values.tenant)) throw new Error("Invalid --tenant");
  if (!values.base.trim()) throw new Error("--base must not be empty");
  if (!values["admin-base"].trim()) throw new Error("--admin-base must not be empty");

  let existing = new Map();
  try { existing = parseHints(readFileSync(values.hints, "utf8")); } catch { /* create below */ }
  const accounts = planPasswords(DEMO_ADMINS, existing, undefined, values["reset-passwords"]);
  const issuer = `${publicBase(values.base)}/identity/realms/junctura`;
  const stack = await connectDemoStack({ tenant: values.tenant, base: publicBase(values["admin-base"]) });
  const { admin, must, idFrom, group, roles, sql } = stack;
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
    await must(await admin(`users/${id}/role-mappings/realm`, roles), [204], `Assign roles to ${account.username}`);
    await sql(buildPrincipalStatement({ tenant: values.tenant, issuer, subject: id, profile: account }));
  }

  mkdirSync(dirname(values.hints), { recursive: true });
  writeFileSync(values.hints, `${JSON.stringify(toLoginHints(accounts), null, 2)}\n`, { mode: 0o644 });
  chmodSync(values.hints, 0o644);

  console.log(`• Tài khoản demo: ${accounts.map(account => account.username).join(", ")}`);
  console.log(`• Tạo mới: ${created.length ? created.join(", ") : "không"}; đặt lại mật khẩu: ${reset.length ? reset.join(", ") : "không"}`);
  console.log(`• Login hints: ${values.hints} (đọc được bởi nginx, KHÔNG commit)`);
  console.log("• Rebuild Console để đưa hints vào image: docker compose --profile console build console && docker compose --profile console up -d console");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
