// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Repeatable provisioning for an existing identity realm: protocol mappers for
// organization group paths and the operator-assigned subjectId, a managed
// admin-only user profile for that subjectId, and the dedicated directory
// synchronization service account with a rotated secret. Every step converges;
// running it again changes nothing. Development stacks.
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";

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

export function missingMappers(client) {
  const names = new Set((client?.protocolMappers ?? []).map(mapper => mapper?.name));
  return DESIRED_MAPPERS.filter(mapper => !names.has(mapper.name));
}

// Existing mappers whose stored configuration differs from the desired one.
export function driftedMappers(client) {
  const known = new Map((client?.protocolMappers ?? [])
    .filter(mapper => mapper?.name).map(mapper => [mapper.name, mapper]));
  return DESIRED_MAPPERS.filter(desired => {
    const existing = known.get(desired.name);
    if (!existing) return false;
    return Object.keys(desired.config).some(key => existing.config?.[key] !== desired.config[key]) ||
      existing.protocolMapper !== desired.protocolMapper;
  });
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
  const property = { name: "subject_id", displayName: "Verified subject ID", permissions: { view: ["admin"], edit: ["admin"] },
    validations: {}, annotations: {} };
  const index = profile.attributes.findIndex(attribute => attribute?.name === "subject_id");
  if (index >= 0) profile.attributes[index] = { ...profile.attributes[index], ...property };
  else profile.attributes.push(property);
  return profile;
}

function baseOf(publicUrl) {
  return (publicUrl ?? "http://127.0.0.1:8080").trim().replace(/\/+$/, "");
}

export function bindingStatement({ tenant, issuer, username, subjectId, loginSubject }) {
  // Bindings are stable: rerunning the same assignment converges, while moving
  // a subjectId to another login deliberately matches nothing and must go
  // through operator reconciliation, never through this provisioning path.
  return `INSERT INTO app_private.subject_bindings(tenant_id,issuer,subject_id,login_subject)
    VALUES('${tenant}','${issuer}','${subjectId}','${loginSubject}')
    ON CONFLICT (tenant_id,issuer,subject_id) DO UPDATE SET
      updated_at=clock_timestamp()
      WHERE app_private.subject_bindings.login_subject='${loginSubject.replaceAll("'", "''")}';`;
}

async function operator(base, password) {
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
  --clients <list>   Clients that receive the organization mappers
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

  for (const clientId of values.clients.split(",").map(value => value.trim()).filter(Boolean)) {
    const found = await expect(await admin(`clients?clientId=${encodeURIComponent(clientId)}`), [200], `Read ${clientId}`);
    const client = (await found.json())[0];
    if (!client) { log(`• client ${clientId}: not found, skipped`); continue; }
    const missing = missingMappers(client);
    for (const mapper of missing) {
      await expect(await admin(`clients/${client.id}/protocol-mappers/models`, mapper, "POST"), [201], `Map ${clientId}/${mapper.name}`);
    }
    const drifted = driftedMappers(client);
    for (const mapper of drifted) {
      const existing = (await (await expect(await admin(`clients/${client.id}/protocol-mappers/models`), [200],
        `Read mappers ${clientId}`)).json()).find(item => item.name === mapper.name);
      await expect(await admin(`clients/${client.id}/protocol-mappers/models/${existing.id}`,
        { ...mapper, id: existing.id }), [204], `Remap ${clientId}/${mapper.name}`);
    }
    if (missing.length || drifted.length) {
      log(`• client ${clientId}: ${[...missing, ...drifted].map(mapper => mapper.name).join(", ")} aligned`);
    }
  }

  const syncClient = (await (await expect(await admin(`clients?clientId=${DIRECTORY_SYNC_CLIENT}`), [200], "Read sync client")).json())[0];
  if (!syncClient) {
    // Keycloak generates a random secret when none is supplied; the operator
    // stores the configured one, or the generated default printed once below.
    const secret = env.DIRECTORY_SYNC_CLIENT_SECRET ?? randomBytes(32).toString("base64url");
    await expect(await admin("clients", { clientId: DIRECTORY_SYNC_CLIENT, enabled: true, protocol: "openid-connect",
      publicClient: false, serviceAccountsEnabled: true, standardFlowEnabled: false, directAccessGrantsEnabled: false,
      secret }, "POST"), [201], `Create ${DIRECTORY_SYNC_CLIENT}`);
    log(`• client ${DIRECTORY_SYNC_CLIENT}: created for directory synchronization`);
    if (!env.DIRECTORY_SYNC_CLIENT_SECRET) {
      log(`• generated sync secret (store it in DIRECTORY_SYNC_CLIENT_SECRET for Core): ${secret}`);
    }
  }
  const sync = (await (await expect(await admin(`clients?clientId=${DIRECTORY_SYNC_CLIENT}`), [200], "Read sync client")).json())[0];
  // Rotate any secret imported from a realm template to the configured value.
  if (env.DIRECTORY_SYNC_CLIENT_SECRET) {
    await expect(await admin(`clients/${sync.id}`, { ...sync, secret: env.DIRECTORY_SYNC_CLIENT_SECRET }), [204],
      `Rotate ${DIRECTORY_SYNC_CLIENT} secret`);
    log(`• client ${DIRECTORY_SYNC_CLIENT}: secret set to the configured value`);
  }
  const account = (await (await expect(await admin(`clients/${sync.id}/service-account-user`), [200], "Read sync account")).json());
  const management = (await (await expect(await admin("clients?clientId=realm-management"), [200], "Read realm-management")).json())[0];
  // Role assignments need the real role representation: Keycloak 26.8.1
  // requires a matching id as well as the name.
  const roleRepresentations = [];
  for (const name of DIRECTORY_SYNC_ROLES) {
    const representations = (await (await expect(await admin(`clients/${management.id}/roles`), [200], "Read client roles")).json());
    const role = representations.find(item => item.name === name);
    if (!role) throw new Error(`Realm-management role ${name} not found`);
    roleRepresentations.push(role);
  }
  const assigned = new Set((await (await expect(await admin(`users/${account.id}/role-mappings/clients/${management.id}`), [200], "Read sync roles")).json())
    .map(role => role.name));
  const lacking = roleRepresentations.filter(role => !assigned.has(role.name));
  if (lacking.length) {
    await expect(await admin(`users/${account.id}/role-mappings/clients/${management.id}`,
      lacking.map(role => ({ id: role.id, name: role.name })), "POST"), [204], "Assign sync roles");
    log(`• service account ${account.username}: added ${lacking.map(role => role.name).join(", ")}`);
  }

  // The subjectId attribute is managed: declared in the user profile, edited
  // by administrators only, and verified by reading the stored user back.
  const profile = subjectIdProfilePatch(await (await expect(await admin("users/profile"), [200], "Read user profile")).json());
  await expect(await admin("users/profile", profile), [200], "Apply user profile");
  const storedProfile = await (await expect(await admin("users/profile"), [200], "Read user profile back")).json();
  const managed = storedProfile.attributes?.find(attribute => attribute?.name === "subject_id");
  if (!managed || JSON.stringify(managed.permissions) !== JSON.stringify({ view: ["admin"], edit: ["admin"] })) {
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
