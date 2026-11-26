// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Provision simulated demo/production identities and console principals.
// Only demo is published in browser hints. All other credentials stay private.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { connectDemoStack, q } from "./lib/demo-stack.mjs";

export const ENVIRONMENT_TENANTS = ["demo", "production"];
export const DEFAULT_JUDGE_EXPIRY = "2026-12-15";
export const TENANT_GROUPS = [...ENVIRONMENT_TENANTS, "tenant-a", "tenant-b"];

export const DEMO_ADMINS = [
  { username: "admin1", firstName: "Admin", lastName: "1", label: "Admin 1", displayName: "Quản trị viên 1", jobTitle: "Quản trị nền tảng" },
  { username: "admin2", firstName: "Admin", lastName: "2", label: "Admin 2", displayName: "Quản trị viên 2", jobTitle: "Người duyệt ứng dụng" },
  { username: "admin3", firstName: "Admin", lastName: "3", label: "Admin 3", displayName: "Quản trị viên 3", jobTitle: "Người duyệt năng lực" },
].map(profile => ({ ...profile, tenant: "production", readOnly: false, public: false }));

export const ADMIN_PERMISSIONS = [
  "applications.register", "applications.approve", "trust.write", "trust.approve",
  "audit.read", "directory.write", "capabilities.write", "capabilities.publish", "capabilities.approve",
  "compositions.write", "compositions.publish", "compositions.approve",
];

export const READER_PERMISSIONS = ["audit.read"];
export const DEMO_ACCOUNT = {
  username: "demo", tenant: "demo", firstName: "Demo", lastName: "Viewer",
  label: "Tài khoản demo (chỉ xem)", displayName: "Tài khoản demo (chỉ xem)",
  jobTitle: "Chỉ xem", readOnly: true, public: true,
};
export const DEMO_INSPECTOR = {
  username: "audit-inspector", tenant: "demo", firstName: "Audit", lastName: "Inspector",
  label: "Thanh tra demo", displayName: "Thanh tra demo", jobTitle: "Đọc nhật ký kiểm toán",
  readOnly: true, public: false,
};
export const JUDGE_ACCOUNT = {
  username: "giamkhao", tenant: "production", firstName: "Giám", lastName: "khảo",
  label: "Giám khảo", displayName: "Giám khảo", jobTitle: "Chỉ xem", readOnly: true, public: false,
};
export const ENVIRONMENT_ACCOUNTS = [DEMO_ACCOUNT, DEMO_INSPECTOR, ...DEMO_ADMINS, JUDGE_ACCOUNT];

const MANAGEMENT_CLIENT = "junctura-console";

export function parseTenants(text = "demo,production") {
  if (typeof text !== "string") throw new Error("Unknown environment tenant");
  const tenants = text.split(",").map(tenant => tenant.trim());
  for (const tenant of tenants) {
    if (!ENVIRONMENT_TENANTS.includes(tenant)) throw new Error(`Unknown environment tenant: ${tenant || "(empty)"}`);
  }
  return [...new Set(tenants)];
}

export function accountsFor(tenants = ENVIRONMENT_TENANTS) {
  for (const tenant of tenants) {
    if (!ENVIRONMENT_TENANTS.includes(tenant)) throw new Error(`Unknown environment tenant: ${tenant}`);
  }
  return ENVIRONMENT_ACCOUNTS.filter(account => tenants.includes(account.tenant));
}

// An expiry date remains valid through that UTC calendar day.
export function parseJudgeExpiry(text = DEFAULT_JUDGE_EXPIRY, now = new Date()) {
  const date = typeof text === "string" && /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? new Date(`${text}T00:00:00.000Z`) : new Date(NaN);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw new Error("Invalid --judge-expires: expected a valid YYYY-MM-DD date");
  }
  const current = new Date(now);
  if (!Number.isFinite(current.getTime())) throw new Error("Invalid current date");
  return { date: text, enabled: text >= current.toISOString().slice(0, 10) };
}

function parseAccountDocument(text) {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed?.accounts)) return [];
    return parsed.accounts.filter(account => account && typeof account.username === "string"
      && account.username.trim() && typeof account.password === "string" && account.password.length > 0);
  } catch {
    return [];
  }
}

export function parseHints(text) {
  return new Map(parseAccountDocument(text).map(({ username, password }) => [username.trim(), password]));
}

export function parseCredentials(text) {
  return parseAccountDocument(text).map(account => {
    const username = account.username.trim();
    const profile = ENVIRONMENT_ACCOUNTS.find(profile => profile.username === username);
    return {
      username, password: account.password, label: account.label ?? profile?.label ?? username,
      // Older private files did not record tenants; retain known accounts on partial runs.
      tenant: account.tenant ?? profile?.tenant,
    };
  }).filter(account => typeof account.tenant === "string" && account.tenant.length > 0);
}

export function planPasswords(profiles, passwords, generate = () => randomBytes(9).toString("base64url"), reset = false) {
  return profiles.map((profile) => ({
    ...profile,
    password: reset ? generate() : passwords.get(profile.username) ?? generate(),
  }));
}

export function toLoginHints(accounts) {
  return {
    accounts: publicAccounts(accounts).map(({ username, password, label }) => ({ username, password, label })),
  };
}

export function publicAccounts(accounts) {
  return accounts.filter(account => account.public === true
    && account.username === DEMO_ACCOUNT.username && account.tenant === DEMO_ACCOUNT.tenant);
}

// Public hints may reuse demo's password. Every non-public password must come
// from the private file and must not also have been disclosed in public hints.
export function knownPasswords(privatePasswords, publicPasswords) {
  const known = new Map();
  const disclosed = new Set(publicPasswords.values());
  if (publicPasswords.has(DEMO_ACCOUNT.username)) known.set(DEMO_ACCOUNT.username, publicPasswords.get(DEMO_ACCOUNT.username));
  for (const [username, password] of privatePasswords) {
    if (username === DEMO_ACCOUNT.username || !disclosed.has(password)) known.set(username, password);
  }
  return known;
}

export function mergeCredentials(existing, provisioned, tenants) {
  const selected = provisioned.filter(account => tenants.includes(account.tenant));
  const replaced = new Set(selected.map(account => account.username));
  return [
    ...existing.filter(account => !tenants.includes(account.tenant) && !replaced.has(account.username)),
    ...selected,
  ].map(({ username, password, label, tenant }) => ({ username, password, label, tenant }));
}

export function buildPrincipalStatement({ tenant, issuer, subject, profile }) {
  return `INSERT INTO app_private.principals
    (tenant_id,issuer,subject,management_client,permissions,display_name,organization,job_title,kind,enabled)
    VALUES (${q(tenant)},${q(issuer)},${q(subject)},${q(MANAGEMENT_CLIENT)},
      ARRAY[${(profile.readOnly === true ? READER_PERMISSIONS : ADMIN_PERMISSIONS).map(q).join(",")}]::text[],
      ${q(profile.displayName)},${q("Junctura")},${q(profile.jobTitle)},'admin',${profile.enabled !== false})
    ON CONFLICT (tenant_id,issuer,subject,management_client) DO UPDATE SET
      permissions=EXCLUDED.permissions, display_name=EXCLUDED.display_name,
      organization=EXCLUDED.organization, job_title=EXCLUDED.job_title,
      kind=EXCLUDED.kind, enabled=EXCLUDED.enabled;`;
}

export function buildDisablePrincipalStatement({ issuer, subject }) {
  return `UPDATE app_private.principals SET enabled=false
    WHERE tenant_id=${q(JUDGE_ACCOUNT.tenant)} AND issuer=${q(issuer)} AND subject=${q(subject)};`;
}

export function buildUserUpdate(user, account) {
  return {
    ...user,
    enabled: account.enabled !== false,
    attributes: {
      ...user.attributes,
      tenant_id: [account.tenant],
      ...(account.username === JUDGE_ACCOUNT.username ? { access_expires_at: [account.accessExpiresAt] } : {}),
    },
  };
}

function publicBase(value) {
  return value.trim().replace(/\/+$/, "");
}

export function parseOptions(args = [], now = new Date(), env = process.env) {
  if (args.some(argument => argument === "--tenant" || argument.startsWith("--tenant="))) {
    throw new Error("--tenant is no longer supported; use --tenants <demo,production>");
  }
  const { values } = parseArgs({ args, options: {
    tenants: { type: "string", default: "demo,production" },
    "judge-expires": { type: "string" },
    "disable-judge": { type: "boolean", default: false },
    base: { type: "string", default: env.PUBLIC_URL ?? "http://127.0.0.1:8080" },
    "admin-base": { type: "string", default: env.ADMIN_BASE ?? `http://127.0.0.1:${env.PORT ?? "8080"}` },
    hints: { type: "string", default: "console/public/login-hints.json" },
    credentials: { type: "string", default: ".junctura/demo-accounts.json" },
    "reset-passwords": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  } });
  if (values.help) return values;
  if (!values.base.trim()) throw new Error("--base must not be empty");
  if (!values["admin-base"].trim()) throw new Error("--admin-base must not be empty");
  return {
    ...values,
    tenants: parseTenants(values.tenants),
    judgeExpiry: parseJudgeExpiry(values["judge-expires"] ?? DEFAULT_JUDGE_EXPIRY, now),
    // Only an explicit date may re-enable a judge that an operator locked or that expired.
    judgeExplicit: values["judge-expires"] !== undefined,
  };
}

// Do not include response bodies in errors: identity servers may echo submitted credentials.
async function expectStatus(response, expected, what) {
  if (!expected.includes(response.status)) throw new Error(`${what} failed (${response.status})`);
  return response;
}

async function findUser(admin, username) {
  const response = await expectStatus(await admin(`users?username=${encodeURIComponent(username)}&exact=true`), [200], `Find ${username}`);
  return (await response.json()).find(user => user.username === username);
}

export async function disableJudge({ admin, sql }, { issuer }) {
  const judge = await findUser(admin, JUDGE_ACCOUNT.username);
  if (!judge?.id) return false;
  await expectStatus(await admin(`users/${judge.id}`, { enabled: false }, "PUT"), [204], "Disable giamkhao");
  await expectStatus(await admin(`users/${judge.id}/logout`, undefined, "POST"), [204], "End giamkhao sessions");
  await sql(buildDisablePrincipalStatement({ issuer, subject: judge.id }));
  return true;
}

export async function disableLegacyViewer({ admin }, log) {
  const viewer = await findUser(admin, "viewer");
  if (!viewer?.id) return;
  await expectStatus(await admin(`users/${viewer.id}`, { enabled: false }, "PUT"), [204], "Disable legacy viewer");
  log("legacy viewer disabled");
}

export async function provisionTenant({ admin, idFrom, group, roles, sql }, { tenant, accounts, existing, resetPasswords, issuer }) {
  const writerRoles = roles.filter(role => role.name !== "core-reader");
  const consoleClient = (await (await expectStatus(await admin(`clients?clientId=${MANAGEMENT_CLIENT}`),
    [200], "Read Console client")).json()).find(client => client.clientId === MANAGEMENT_CLIENT);
  if (!consoleClient) throw new Error("Console client missing");
  const consolePath = `clients/${consoleClient.id}`;
  const scopePath = `${consolePath}/default-client-scopes`;
  const defaults = await (await expectStatus(await admin(scopePath), [200], "Read Console default scopes")).json();
  const missing = ["basic", "roles"].filter(name => !defaults.some(scope => scope.name === name));
  if (missing.length) {
    const available = await (await expectStatus(await admin("client-scopes"), [200], "Read realm scopes")).json();
    for (const name of missing) {
      const scope = available.find(candidate => candidate.name === name);
      if (!scope) throw new Error(`Keycloak client scope ${name} missing`);
      await expectStatus(await admin(`${scopePath}/${scope.id}`, undefined, "PUT"), [204], `Assign Console scope ${name}`);
    }
  }
  const consoleRoles = await (await expectStatus(await admin(`${consolePath}/roles`),
    [200], "Read Console access roles")).json();

  const created = [];
  const reset = [];
  for (const account of accounts) {
    if (account.tenant !== tenant) throw new Error("Account does not belong to the selected environment tenant");
    let id = (await findUser(admin, account.username))?.id;
    if (!id) {
      const response = await expectStatus(await admin("users", {
        username: account.username,
        ...buildUserUpdate({}, account),
        email: `${account.username}@junctura.invalid`,
        emailVerified: true,
        firstName: account.firstName,
        lastName: account.lastName,
        credentials: [{ type: "password", value: account.password, temporary: false }],
      }), [201], `Create ${account.username}`);
      id = idFrom(response);
      created.push(account.username);
    } else {
      const user = await (await expectStatus(await admin(`users/${id}`), [200], `Read ${account.username}`)).json();
      await expectStatus(await admin(`users/${id}`, buildUserUpdate(user, account), "PUT"), [204], `Update ${account.username}`);
      if (!existing.has(account.username) || resetPasswords) {
        await expectStatus(await admin(`users/${id}/reset-password`, {
          type: "password", value: account.password, temporary: false,
        }, "PUT"), [204], `Reset ${account.username}`);
        reset.push(account.username);
      }
    }
    await expectStatus(await admin(`users/${id}/groups/${group.id}`, undefined, "PUT"), [204], `Add ${account.username} to ${tenant}`);
    const memberships = await (await expectStatus(await admin(`users/${id}/groups`), [200], `Read ${account.username} groups`)).json();
    // A moved account (e.g. admin1 formerly in tenant-a) must not keep another tenant membership:
    // Core accepts tenant_id only when it is one of the token's tenant_memberships.
    for (const other of memberships.filter(member => TENANT_GROUPS.includes(member.name) && member.name !== tenant)) {
      await expectStatus(await admin(`users/${id}/groups/${other.id}`, undefined, "DELETE"), [204], `Remove ${account.username} from ${other.name}`);
    }
    if (account.readOnly === true) {
      await expectStatus(await admin(`users/${id}/role-mappings/realm`, roles.filter(role => role.name === "core-reader")), [204], `Assign reader role to ${account.username}`);
      if (writerRoles.length) await expectStatus(await admin(`users/${id}/role-mappings/realm`, writerRoles, "DELETE"), [204], `Remove writer roles from ${account.username}`);
    } else {
      await expectStatus(await admin(`users/${id}/role-mappings/realm`, roles), [204], `Assign roles to ${account.username}`);
    }
    const consoleRole = consoleRoles.find(role => role.name === (account.readOnly ? "console-viewer" : "console-admin"));
    if (!consoleRole) throw new Error("Console access roles missing. Run directory provisioning first");
    const mapping = `users/${id}/role-mappings/clients/${consoleClient.id}`;
    const current = await (await expectStatus(await admin(mapping), [200], "Read Console role bindings")).json();
    const previous = current.filter(role => /^console-(admin|manager|viewer)$/.test(role.name) && role.id !== consoleRole.id);
    if (previous.length) await expectStatus(await admin(mapping, previous, "DELETE"), [204], "Remove previous Console roles");
    await expectStatus(await admin(mapping, [consoleRole], "POST"), [204], "Assign Console access");
    await sql(buildPrincipalStatement({ tenant, issuer, subject: id, profile: account }));
  }
  return { created, reset };
}

export async function main(args = process.argv.slice(2), {
  connect = connectDemoStack, read = readFileSync, write = writeFileSync,
  mkdir = mkdirSync, chmod = chmodSync, log = console.log, now = new Date(),
} = {}) {
  const values = parseOptions(args, now);
  if (values.help) {
    log(`Usage: npm run env:provision -- [options]

  --tenants <list>         Environment tenants (default demo,production)
  --judge-expires <date>   Judge expiry, inclusive UTC YYYY-MM-DD (default 2026-12-15)
  --disable-judge          Only disable production/giamkhao and end its sessions, then exit
  --base <url>             Public URL used for the token issuer (default PUBLIC_URL)
  --admin-base <url>       Internal Gateway URL for Keycloak admin calls (default loopback)
  --hints <path>           Public browser login hints (default console/public/login-hints.json)
  --credentials <path>     Private environment credentials (default .junctura/demo-accounts.json)
  --reset-passwords        Rotate passwords for the selected tenants
  --help                   Show this help

Only demo is public and read-only. Production accounts are never published.
All accounts and environment data are simulated. demo:provision remains an alias.
`);
    return;
  }
  const issuer = `${publicBase(values.base)}/identity/realms/junctura`;
  const base = publicBase(values["admin-base"]);
  if (values["disable-judge"]) {
    const disabled = await disableJudge(await connect({ tenant: JUDGE_ACCOUNT.tenant, base }), { issuer });
    log(disabled ? "production: giamkhao disabled; sessions ended" : "production: giamkhao does not exist");
    return;
  }

  const readDocument = path => {
    try { return read(path, "utf8"); } catch (error) {
      if (error.code !== "ENOENT") throw new Error(`Cannot read account file: ${path}`);
      return "{}";
    }
  };
  const credentialsText = readDocument(values.credentials);
  const credentials = parseCredentials(credentialsText);
  const existing = knownPasswords(parseHints(credentialsText), parseHints(readDocument(values.hints)));
  const profiles = accountsFor(values.tenants).map(account => account.username === JUDGE_ACCOUNT.username
    ? { ...account, enabled: values.judgeExpiry.enabled, accessExpiresAt: values.judgeExpiry.date }
    : { ...account, enabled: true });
  const accounts = planPasswords(profiles, existing, undefined, values["reset-passwords"]);
  let legacyChecked = false;
  for (const tenant of values.tenants) {
    const stack = await connect({ tenant, base, createGroup: true });
    if (!legacyChecked) {
      await disableLegacyViewer(stack, log);
      legacyChecked = true;
    }
    const selected = accounts.filter(account => account.tenant === tenant);
    if (tenant === JUDGE_ACCOUNT.tenant && !values.judgeExplicit) {
      const judge = await findUser(stack.admin, JUDGE_ACCOUNT.username);
      if (judge?.enabled === false) for (const account of selected) if (account.username === JUDGE_ACCOUNT.username) account.enabled = false;
    }
    const { created, reset } = await provisionTenant(stack, {
      tenant, accounts: selected, existing, resetPasswords: values["reset-passwords"], issuer,
    });
    log(`• ${tenant}: ${selected.map(account => account.username).join(", ")}`);
    log(`• ${tenant}: created: ${created.join(", ") || "none"}; reset: ${reset.join(", ") || "none"}`);
  }

  mkdir(dirname(values.credentials), { recursive: true });
  write(values.credentials, `${JSON.stringify({ accounts: mergeCredentials(credentials, accounts, values.tenants) }, null, 2)}\n`, { mode: 0o600 });
  chmod(values.credentials, 0o600);
  if (values.tenants.includes("demo")) {
    mkdir(dirname(values.hints), { recursive: true });
    write(values.hints, `${JSON.stringify(toLoginHints(accounts), null, 2)}\n`, { mode: 0o644 });
    chmod(values.hints, 0o644);
  }
  log(`• Public login hints: ${values.hints}${values.tenants.includes("demo") ? " — demo only" : " (unchanged)"}`);
  log(`• Private credentials: ${values.credentials} (mode 0600)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
