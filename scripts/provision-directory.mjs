// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Repeatable provisioning for an existing identity realm: protocol mappers for
// organization group paths and the operator-assigned subjectId, the dedicated
// directory synchronization service account, and optional subjectId bindings.
// Every step converges; running it again changes nothing. Development stacks.
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

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

export const DIRECTORY_SYNC_CLIENT = "junctura-directory-sync";
export const DIRECTORY_SYNC_ROLES = ["view-realm", "query-users", "query-groups", "manage-users", "manage-realm"];

export function missingMappers(client) {
  const names = new Set((client?.protocolMappers ?? []).map(mapper => mapper?.name));
  return [ORG_GROUPS_MAPPER, SUBJECT_ID_MAPPER].filter(mapper => !names.has(mapper.name));
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

function baseOf(publicUrl) {
  return (publicUrl ?? "http://127.0.0.1:8080").trim().replace(/\/+$/, "");
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

export function bindingStatement({ tenant, issuer, username, subjectId, loginSubject }) {
  return `INSERT INTO app_private.subject_bindings(tenant_id,issuer,subject_id,login_subject)
    VALUES('${tenant}','${issuer}','${subjectId}','${loginSubject}')
    ON CONFLICT (tenant_id,issuer,subject_id) DO UPDATE SET
      login_subject=EXCLUDED.login_subject, updated_at=clock_timestamp();`;
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
    const additions = missingMappers(client);
    if (additions.length) {
      await expect(await admin(`clients/${client.id}`, mapperPatch(client, additions)), [204], `Map ${clientId}`);
      log(`• client ${clientId}: added ${additions.map(mapper => mapper.name).join(", ")}`);
    }
  }

  const syncClient = (await (await expect(await admin(`clients?clientId=${DIRECTORY_SYNC_CLIENT}`), [200], "Read sync client")).json())[0];
  if (!syncClient) {
    if (!env.DIRECTORY_SYNC_CLIENT_SECRET) throw new Error(`DIRECTORY_SYNC_CLIENT_SECRET missing: cannot create ${DIRECTORY_SYNC_CLIENT}`);
    await expect(await admin("clients", { clientId: DIRECTORY_SYNC_CLIENT, enabled: true, protocol: "openid-connect",
      publicClient: false, serviceAccountsEnabled: true, standardFlowEnabled: false, directAccessGrantsEnabled: false,
      secret: env.DIRECTORY_SYNC_CLIENT_SECRET }, "POST"), [201], `Create ${DIRECTORY_SYNC_CLIENT}`);
    log(`• client ${DIRECTORY_SYNC_CLIENT}: created for directory synchronization`);
  }
  const sync = (await (await expect(await admin(`clients?clientId=${DIRECTORY_SYNC_CLIENT}`), [200], "Read sync client")).json())[0];
  const account = (await (await expect(await admin(`clients/${sync.id}/service-account-user`), [200], "Read sync account")).json());
  const management = (await (await expect(await admin("clients?clientId=realm-management"), [200], "Read realm-management")).json())[0];
  const assigned = new Set((await (await expect(await admin(`users/${account.id}/role-mappings/clients/${management.id}`), [200], "Read sync roles")).json())
    .map(role => role.name));
  const lacking = DIRECTORY_SYNC_ROLES.filter(role => !assigned.has(role));
  if (lacking.length) {
    await expect(await admin(`users/${account.id}/role-mappings/clients/${management.id}`,
      DIRECTORY_SYNC_ROLES.filter(role => lacking.includes(role)).map(role => ({ name: role })), "POST"), [204], "Assign sync roles");
    log(`• service account ${account.username}: added ${lacking.join(", ")}`);
  }

  for (const assignment of parseAssignments(values.assign)) {
    const found = (await (await expect(await admin(`users?username=${encodeURIComponent(assignment.username)}&exact=true`), [200], `Find ${assignment.username}`)).json());
    const person = found[0];
    if (!person) throw new Error(`User ${assignment.username} does not exist`);
    await expect(await admin(`users/${person.id}`, { ...person, attributes: { ...person.attributes, subject_id: [assignment.subjectId] } }), [204], `Assign ${assignment.username}`);
    log(`• ${assignment.username}: subjectId ${assignment.subjectId} assigned (binding row is an operator SQL task)`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
