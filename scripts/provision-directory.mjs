// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Repeatable provisioning for an existing identity realm: protocol mappers for
// organization group paths and the operator-assigned subjectId, a managed
// admin-only user profile for that subjectId, and the dedicated directory
// synchronization service account with a rotated secret. Every step converges;
// running it again changes nothing. Development stacks.
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { createApplicationProvider } from "../src/modules/applications/keycloak.mjs";

export const DEFAULT_CLIENTS = ["junctura-console", "junctura-local", "tenant-a", "tenant-b", "reader"];

export const ORG_GROUPS_MAPPER = {
  name: "org-groups", protocol: "openid-connect", protocolMapper: "oidc-group-membership-mapper",
  config: { "access.token.claim": "true", "claim.name": "groups", "full.path": "true", "introspection.token.claim": "true" },
};

export const SUBJECT_ID_MAPPER = {
  name: "subject-id", protocol: "openid-connect", protocolMapper: "oidc-usermodel-attribute-mapper",
  config: { "user.attribute": "subject_id", "claim.name": "subject_id", "jsonType.label": "String",
    "access.token.claim": "true", "introspection.token.claim": "true" },
};

// The token's tenant membership names the tenant root group by full path;
// leaf group names can repeat across tenants, so only the exact path proves
// enrollment.
export const TENANT_MEMBERSHIPS_MAPPER = {
  name: "tenant-memberships", protocol: "openid-connect", protocolMapper: "oidc-group-membership-mapper",
  config: { "access.token.claim": "true", "claim.name": "tenant_memberships", "full.path": "true",
    "introspection.token.claim": "true" },
};

export const DESIRED_MAPPERS = [ORG_GROUPS_MAPPER, SUBJECT_ID_MAPPER, TENANT_MEMBERSHIPS_MAPPER];

export const DIRECTORY_SYNC_CLIENT = "junctura-directory-sync";
// manage-users covers group management under Keycloak 26.8.1 default group
// permissions; manage-realm is broader than synchronization needs.
export const DIRECTORY_SYNC_ROLES = ["view-realm", "query-users", "query-groups", "manage-users"];

function mapsClaim(mapper, desired) {
  if (DESIRED_MAPPERS.some(candidate => candidate.name === mapper?.name)) return mapper.name === desired.name;
  return mapper?.config?.["claim.name"] === desired.config["claim.name"];
}

const mapperDiffers = (mapper, desired) => mapper.protocolMapper !== desired.protocolMapper ||
  mapper.protocol !== desired.protocol || Object.keys(desired.config).some(key => mapper.config?.[key] !== desired.config[key]);

export function missingMappers(client) {
  return DESIRED_MAPPERS.filter(desired => !(client?.protocolMappers ?? []).some(mapper => mapsClaim(mapper, desired)));
}

export function driftedMappers(client) {
  return DESIRED_MAPPERS.filter(desired => (client?.protocolMappers ?? [])
    .some(mapper => mapsClaim(mapper, desired) && mapperDiffers(mapper, desired)));
}

export function parseAssignments(values = []) {
  const assignments = [];
  for (const value of values) {
    const match = /^(?<username>[^=]+)=(?<subjectId>[A-Za-z0-9:_-]{1,128})$/.exec(value ?? "");
    if (!match || !match.groups.username.trim()) throw new Error(`--assign expects <username>=<subjectId>: ${value}`);
    assignments.push({ username: match.groups.username.trim(), subjectId: match.groups.subjectId });
  }
  return assignments;
}

export function mapperPatch(source, additions) {
  const client = structuredClone(source);
  client.protocolMappers = [...(client.protocolMappers ?? []),
    ...additions.map(mapper => structuredClone(mapper))];
  for (const mapper of client.protocolMappers) delete mapper.id;
  return client;
}

// The managed subjectId attribute: declared in the user profile so Keycloak
// never drops it, editable by administrators only, never by the account user.
export function subjectIdProfilePatch(current) {
  const profile = structuredClone(current ?? {});
  profile.attributes ??= [];
  if (!profile.attributes.some(attribute => attribute?.name === "tenant_id")) {
    profile.attributes.push({ name: "tenant_id", displayName: "Tenant ID", permissions: { view: ["admin"], edit: ["admin"] } });
  }
  const property = { name: "subject_id", displayName: "Verified subject ID", permissions: { view: ["admin"], edit: ["admin"] },
    validations: {}, annotations: {} };
  const unit = { name: "junctura_unit", displayName: "Application unit", permissions: { view: ["admin"], edit: ["admin"] } };
  const unitIndex = profile.attributes.findIndex(attribute => attribute?.name === unit.name);
  if (unitIndex >= 0) profile.attributes[unitIndex] = { ...profile.attributes[unitIndex], ...unit };
  else profile.attributes.push(unit);
  const index = profile.attributes.findIndex(attribute => attribute?.name === "subject_id");
  if (index >= 0) profile.attributes[index] = { ...profile.attributes[index], ...property };
  else profile.attributes.push(property);
  return profile;
}

function baseOf(publicUrl) {
  return (publicUrl ?? "http://127.0.0.1:8080").trim().replace(/\/+$/, "");
}

export function bindingStatement({ tenant, issuer, subjectId, loginSubject }) {
  const literal = value => `'${value.replaceAll("'", "''")}'`;
  // Bindings are stable: rerunning the same assignment converges, while moving
  // a subjectId to another login deliberately matches nothing and must go
  // through operator reconciliation, never through this provisioning path.
  return `INSERT INTO app_private.subject_bindings(tenant_id,issuer,subject_id,login_subject)
    VALUES(${[tenant, issuer, subjectId, loginSubject].map(literal).join(",")})
    ON CONFLICT (tenant_id,issuer,subject_id) DO UPDATE SET
      updated_at=clock_timestamp()
      WHERE app_private.subject_bindings.login_subject=${literal(loginSubject)};`;
}

export async function operator(base, password) {
  const issued = await fetch(`${base}/identity/realms/master/protocol/openid-connect/token`, { method: "POST",
    body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username: "junctura-admin", password }) });
  if (issued.status !== 200) throw new Error(`Keycloak operator login failed (${issued.status}); is the stack running?`);
  const token = (await issued.json()).access_token;
  return async (path, body, method = body === undefined ? "GET" : "PUT") => fetch(`${base}/identity/admin/realms/junctura/${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) });
}

export async function main(args = process.argv.slice(2), {
  log = console.log, env = process.env, runOperator = operator,
} = {}) {
  const { values } = parseArgs({ args, options: {
    base: { type: "string", default: baseOf(env.PUBLIC_URL) },
    clients: { type: "string", default: DEFAULT_CLIENTS.join(",") },
    assign: { type: "string", multiple: true, default: [] },
    tenant: { type: "string", default: env.WORKFLOW_TENANTS?.split(",")[0] ?? "tenant-a" },
    help: { type: "boolean", default: false },
  } });
  if (values.help) {
    log(`Usage: npm run directory:provision -- [options]

  --base <url>       Gateway origin for identity administration (default PUBLIC_URL)
  --clients <list>   Additional client IDs to align alongside discovered Junctura clients
  --assign <k=v>     Bind a login username to an operator-assigned subjectId (repeatable)
  --tenant <name>    Tenant used for binding rows (default first workflow tenant)
  --help             Show this help
`);
    return;
  }
  const base = baseOf(values.base);
  if (!env.KEYCLOAK_ADMIN_PASSWORD) throw new Error("KEYCLOAK_ADMIN_PASSWORD missing: run from the repository root after npm run setup");
  const admin = await runOperator(base, env.KEYCLOAK_ADMIN_PASSWORD);
  const expect = async (response, expected, what) => {
    if (!expected.includes(response.status)) throw new Error(`${what} failed (${response.status})`);
    return response;
  };

  const read = async (path, what) => (await expect(await admin(path), [200], what)).json();
  const namedClients = new Set(values.clients.split(",").map(value => value.trim()).filter(Boolean));
  const syncClientId = env.DIRECTORY_SYNC_CLIENT_ID || DIRECTORY_SYNC_CLIENT;
  const syncSecret = env.DIRECTORY_SYNC_CLIENT_SECRET?.trim();
  const clients = [];
  for (let first = 0; ; ) {
    const page = await read(`clients?first=${first}&max=100`, "List realm clients");
    if (!page.length) break;
    clients.push(...page);
    first += page.length;
  }

  async function configureSync(clientId, secret, existing, permissions = DIRECTORY_SYNC_ROLES) {
    const policy = { clientId, protocol: "openid-connect", publicClient: false, serviceAccountsEnabled: true,
      standardFlowEnabled: false, directAccessGrantsEnabled: false, enabled: false };
    if (!existing) {
      await expect(await admin("clients", { ...policy, ...(secret ? { secret } : {}) }, "POST"), [201], `Create ${clientId}`);
      existing = (await read(`clients?clientId=${encodeURIComponent(clientId)}`, `Read ${clientId}`))
        .find(client => client.clientId === clientId);
    }
    const path = `clients/${existing.id}`;
    const disable = async () => expect(await admin(path,
      { ...policy, notBefore: Math.floor(Date.now() / 1000) }), [204], `Disable ${clientId}`);
    if (existing.enabled && !secret) await disable();
    const account = await read(`${path}/service-account-user`, "Read sync account");
    const management = clients.find(client => client.clientId === "realm-management");
    const mapping = `users/${account.id}/role-mappings/clients/${management.id}`;
    const assigned = await read(mapping, "Read sync roles");
    const extra = assigned.filter(role => !permissions.includes(role.name));
    const missing = permissions.filter(name => !assigned.some(role => role.name === name));
    const policyDrift = Object.entries(policy).some(([key, value]) => key !== "enabled" && existing[key] !== value);
    const storedSecret = secret && (await read(`${path}/client-secret`, "Read current sync secret")).value;
    const needsUpdate = !secret || !existing.enabled || policyDrift || extra.length > 0 ||
      missing.length > 0 || storedSecret !== secret;
    if (existing.enabled && secret && needsUpdate) await disable();
    if (extra.length) await expect(await admin(mapping, extra, "DELETE"), [204], "Remove excess sync roles");
    await expect(await admin(`${path}/client-secret/rotated`, undefined, "DELETE"), [204], "Invalidate the rotated sync secret");
    if (!secret) {
      log(`• client ${clientId}: disabled pending a replacement secret`);
      return;
    }
    if (missing.length) {
      const roles = await read(`clients/${management.id}/roles?max=100`, "Read realm-management roles");
      const additions = missing.map(name => {
        const role = roles.find(item => item.name === name);
        if (!role) throw new Error(`Realm-management role ${name} not found`);
        return { id: role.id, name };
      });
      await expect(await admin(mapping, additions, "POST"), [204], "Assign sync roles");
    }
    if (needsUpdate) await expect(await admin(path, { ...policy, enabled: true, secret }), [204], `Enable ${clientId} with the replacement secret`);
  }

  const formerSync = clients.find(client => client.clientId === DIRECTORY_SYNC_CLIENT);
  if (formerSync && syncClientId !== DIRECTORY_SYNC_CLIENT) await configureSync(DIRECTORY_SYNC_CLIENT, undefined, formerSync);
  await configureSync(syncClientId, syncSecret, clients.find(client => client.clientId === syncClientId));
  const appSyncClientId = env.APP_SYNC_CLIENT_ID || "junctura-app-sync";
  const appSyncSecret = env.APP_SYNC_CLIENT_SECRET?.trim();
  if (appSyncSecret) {
    if (appSyncClientId === syncClientId) throw new Error("Use distinct directory and application sync clients");
    await configureSync(appSyncClientId, appSyncSecret, clients.find(client => client.clientId === appSyncClientId),
      [...DIRECTORY_SYNC_ROLES, "manage-clients", "manage-realm"]);
    await createApplicationProvider({ identityUrl: `${base}/identity/realms/junctura`,
      appSyncClientId, appSyncSecret }).configure("junctura-console", "junctura-console");
  }


  for (const client of clients.filter(client => client.protocol === "openid-connect" || namedClients.has(client.clientId))) {
    const { id, clientId } = client;
    const path = `clients/${id}/protocol-mappers/models`;
    const protocolMappers = await read(path, `Read mappers for ${clientId}`);
    if (!namedClients.has(clientId) && !protocolMappers.some(mapper =>
      ["tenant_id", "tenant_memberships"].includes(mapper.config?.["claim.name"]))) continue;
    const current = { protocolMappers };
    for (const mapper of missingMappers(current)) {
      await expect(await admin(path, mapper, "POST"), [201], `Map ${clientId}/${mapper.name}`);
    }
    for (const mapper of driftedMappers(current)) {
      for (const existing of protocolMappers.filter(item => mapsClaim(item, mapper) && mapperDiffers(item, mapper))) {
        await expect(await admin(`${path}/${existing.id}`, { ...mapper, id: existing.id, name: existing.name }),
          [204], `Remap ${clientId}/${existing.name}`);
      }
    }
    log(`• client ${clientId}: organization mappers aligned`);
  }

  // The subjectId attribute is managed: declared in the user profile, edited
  // by administrators only, and verified by reading the stored user back.
  const profile = subjectIdProfilePatch(await (await expect(await admin("users/profile"), [200], "Read user profile")).json());
  await expect(await admin("users/profile", profile), [200], "Apply user profile");
  const storedProfile = await (await expect(await admin("users/profile"), [200], "Read user profile back")).json();
  const managed = storedProfile.attributes?.find(attribute => attribute?.name === "subject_id");
  if (!managed || ["view", "edit"].some(action => managed.permissions?.[action]?.join(",") !== "admin")) {
    throw new Error("subject_id is not a managed admin-only attribute; refusing to continue");
  }

  for (const assignment of parseAssignments(values.assign)) {
    const found = (await (await expect(await admin(`users?username=${encodeURIComponent(assignment.username)}&exact=true`), [200], `Find ${assignment.username}`)).json());
    const person = found[0];
    if (!person) throw new Error(`User ${assignment.username} does not exist`);
    await expect(await admin(`users/${person.id}`, { ...person, attributes: { ...person.attributes, subject_id: [assignment.subjectId] } }), [204], `Assign ${assignment.username}`);
    const verified = (await (await expect(await admin(`users/${person.id}`), [200], `Read ${assignment.username} back`)).json());
    if (verified.attributes?.subject_id?.[0] !== assignment.subjectId) {
      throw new Error(`subject_id for ${assignment.username} was not stored; the user profile may reject managed attributes`);
    }
    log(`• ${assignment.username}: subjectId ${assignment.subjectId} assigned (binding row is an operator SQL task)`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
