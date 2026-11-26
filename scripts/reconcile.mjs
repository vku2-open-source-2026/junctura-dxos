// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { operator } from "./provision-directory.mjs";

const consoleId = "junctura-console";
const realm = JSON.parse(readFileSync(new URL("../infra/keycloak/realm.json", import.meta.url), "utf8"));
const policyFile = new URL("../infra/openbao/junctura-core.hcl", import.meta.url);

export async function reconcileRealm(admin, { apply = false, desired = realm } = {}) {
  const drift = [], changes = [];
  async function request(path, status, method = "GET", body) {
    const response = await admin(path, body, method);
    if (response.status !== status) throw new Error(`Keycloak ${method} for managed configuration failed (${response.status})`);
    if (status === 200) return response.json();
  }
  const read = path => request(path, 200);
  async function add(message, path, status, body, method = "POST") {
    if (!apply) return drift.push(message);
    await request(path, status, method, body);
    changes.push(message);
  }

  const desiredClient = desired.clients.find(client => client.clientId === consoleId);
  const consoleScopes = desiredClient.defaultClientScopes ?? [];
  const findClient = async () => (await read(`clients?clientId=${consoleId}`)).find(client => client.clientId === consoleId);
  let client = await findClient();
  if (!client) {
    await add(`Keycloak client ${consoleId} missing`, "clients", 201, desiredClient);
    if (apply) client = await findClient();
  }
  const roles = await read("roles");
  for (const role of desired.roles.realm) {
    if (!roles.some(current => current.name === role.name)) {
      await add(`Keycloak realm role ${role.name} missing`, "roles", 201, { name: role.name });
    }
  }
  if (!client) return { drift, changes };

  const path = `clients/${client.id}`;
  const config = await read(path);
  for (const key of ["protocol", "publicClient", "standardFlowEnabled", "directAccessGrantsEnabled"]) {
    if (config[key] !== desiredClient[key]) drift.push(`Keycloak client ${consoleId} ${key} differs`);
  }
  const mapperPath = `${path}/protocol-mappers/models`;
  for (const mapper of desiredClient.protocolMappers) {
    const current = config.protocolMappers?.find(item => item.name === mapper.name);
    if (!current) {
      await add(`Keycloak mapper ${mapper.name} missing`, mapperPath, 201, mapper);
    } else if (current.protocol !== mapper.protocol || current.protocolMapper !== mapper.protocolMapper ||
      Object.entries(mapper.config).some(([key, value]) => current.config?.[key] !== value)) {
      drift.push(`Keycloak mapper ${mapper.name} differs`);
    }
  }
  const scopes = await read(`${path}/default-client-scopes`);
  const missing = consoleScopes.filter(name => !scopes.some(scope => scope.name === name));
  if (missing.length && apply) {
    const available = await read("client-scopes");
    for (const name of missing) {
      const scope = available.find(item => item.name === name);
      if (!scope) { drift.push(`Keycloak realm scope ${name} missing`); continue; }
      await add(`Keycloak Console scope ${name} missing`, `${path}/default-client-scopes/${scope.id}`, 204, undefined, "PUT");
    }
  } else {
    drift.push(...missing.map(name => `Keycloak Console scope ${name} missing`));
  }

  const rolePath = `${path}/roles`;
  let clientRoles = await read(rolePath);
  const desiredRoles = desired.roles.client[consoleId];
  for (const role of desiredRoles) {
    if (!clientRoles.some(current => current.name === role.name)) {
      await add(`Keycloak Console role ${role.name} missing`, rolePath, 201, { name: role.name });
    }
  }
  if (apply) clientRoles = await read(rolePath);
  const access = clientRoles.find(role => role.name === "junctura-access");
  if (access) for (const role of desiredRoles.filter(role => role.composite)) {
    const current = clientRoles.find(item => item.name === role.name);
    if (!current) continue;
    const composites = `roles-by-id/${current.id}/composites`;
    if (!(await read(composites)).some(item => item.id === access.id)) {
      await add(`Keycloak Console role ${role.name} missing junctura-access`, composites, 204, [access]);
    }
  }
  return { drift, changes };
}

function checked(command, args, label) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 45000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${label} failed`);
  return result.stdout.trim();
}

function openBaoPolicy(apply) {
  const bootstrap = `BAO_TOKEN="$(awk -F'"' '/"root_token"/{print $4; exit}' "$OPERATOR_DIR/init.json")";
    export BAO_TOKEN; test -n "$BAO_TOKEN";`;
  const run = command => checked("docker", ["compose", "run", "--rm", "-T", "--no-deps", "--entrypoint", "/bin/sh",
    "secrets-init", "-ec", `${bootstrap}\n${command}`], "OpenBao policy inspection");
  const current = run(`policies=$(bao policy list); if printf '%s\\n' "$policies" | grep -qx junctura-core; then bao policy read junctura-core; fi`);
  const expected = readFileSync(policyFile, "utf8").trim();
  if (current === expected) return { drift: [], changes: [] };
  if (!apply) return { drift: ["OpenBao junctura-core policy differs"], changes: [] };
  run("bao policy write junctura-core /policy/junctura-core.hcl >/dev/null");
  return { drift: [], changes: ["OpenBao junctura-core policy differs"] };
}

function migrationDrift() {
  const dir = new URL("../infra/postgres/", import.meta.url);
  const files = readdirSync(dir).filter(name => /^\d{3}-.+\.sql$/.test(name));
  const local = new Map(files.map(name => [Number(name.slice(0, 3)), {
    name, hash: createHash("sha256").update(readFileSync(new URL(name, dir))).digest("hex"),
  }]));
  const ledger = JSON.parse(checked("docker", ["compose", "exec", "-T", "database", "psql", "-XAtq",
    "-v", "ON_ERROR_STOP=1", "-U", "junctura_admin", "-d", "junctura_data", "-c",
    `SELECT json_build_object('entries',coalesce(json_agg(json_build_array(m.version,c.filename,c.sha256)),'[]'::json),
       'latest',(SELECT last_version FROM core.schema_migration_state WHERE id=1))
     FROM core.schema_migrations m FULL JOIN core.schema_migration_checksums c USING(version);`], "Migration ledger inspection"));
  const applied = new Map(ledger.entries.map(([version, name, hash]) => [version, { name, hash }]));
  const drift = [];
  if (local.size !== files.length) drift.push("Duplicate local migration version");
  for (const [version, expected] of local) {
    const current = applied.get(version);
    if (current?.name !== expected.name || current?.hash !== expected.hash) drift.push(`Migration ${version} missing or differs`);
  }
  if (ledger.latest !== Math.max(...local.keys()) || [...applied.keys()].some(version => !local.has(version))) {
    drift.push("Migration ledger includes a missing or unexpected version");
  }
  const schema = spawnSync(process.execPath, ["scripts/check-schema-drift.mjs"], { stdio: "ignore", timeout: 45000 });
  if (schema.status !== 0) drift.push("Installed database schema differs from recorded state");
  return drift;
}

async function main(args = process.argv.slice(2), env = process.env) {
  if (args.length !== 1 || !["--check", "--apply"].includes(args[0])) throw new Error("Usage: npm run reconcile -- --check|--apply");
  const apply = args[0] === "--apply";
  if (!env.KEYCLOAK_ADMIN_PASSWORD) throw new Error("KEYCLOAK_ADMIN_PASSWORD is required");
  const base = env.ADMIN_BASE ?? `http://127.0.0.1:${env.PORT ?? "8080"}`;
  const keycloak = await reconcileRealm(await operator(base.replace(/\/+$/, ""), env.KEYCLOAK_ADMIN_PASSWORD), { apply });
  const openbao = openBaoPolicy(apply);
  const migrations = migrationDrift();
  for (const change of [...keycloak.changes, ...openbao.changes]) console.log(`Reconciled ${change}`);
  const drift = [...keycloak.drift, ...openbao.drift, ...migrations];
  for (const item of drift) console.log(item);
  if (migrations.length) console.log("Inspect migration drift with the migration runner and docs/DEVELOPING.md.");
  if (drift.length) process.exitCode = 1;
  else console.log("Managed Keycloak, OpenBao and migration state is current");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
