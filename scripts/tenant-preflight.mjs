// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Read-only tenant transfer preflight (development stacks only):
//   npm run tenant:preflight -- --from <old-id> --to <new-id> --name <display-name>
// Inventories Core/Postgres, Flowable and Keycloak tenant data and fails when the
// destination namespace is already populated. Collection functions are exported for
// the guarded transfer rehearsal (scripts/tenant-transfer.mjs); the CLI output is
// unchanged.
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const tenantPattern = /^[a-z][a-z0-9-]{0,62}$/;

const q = value => `'${String(value).replaceAll("'", "''")}'`;

export function parsePreflightArgs(argv) {
  const { values, positionals } = parseArgs({ allowPositionals: true, args: argv, options: {
    from: { type: "string" }, to: { type: "string" }, name: { type: "string" },
  } });
  const from = values.from;
  const to = values.to;
  const name = values.name?.trim();
  if (positionals.length || !tenantPattern.test(from ?? "") || !tenantPattern.test(to ?? "") ||
      from === to || !name || name.length > 120 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new Error("Usage: npm run tenant:preflight -- --from <old-id> --to <new-id> --name <display-name>");
  }
  return { from, to, name };
}

// Session COMPOSE_* and DOCKER_HOST/DOCKER_CONTEXT overrides are stripped from
// every Docker invocation, so a session environment cannot point these tools at
// another running stack or another Docker daemon: the checkout's .env governs.
// A guarded caller passes its verified project explicitly with `-p`.
export function dockerEnv(env = process.env) {
  const stripped = { ...env };
  for (const key of Object.keys(stripped)) {
    if (/^COMPOSE_/i.test(key) || key === "DOCKER_HOST" || key === "DOCKER_CONTEXT") delete stripped[key];
  }
  return stripped;
}

export function psql(database, statement, project) {
  const input = "BEGIN READ ONLY;\n" + statement + "\nCOMMIT;\n";
  return execFileSync("docker",
    ["compose", ...(project ? ["-p", project] : []), "exec", "-T", "database", "psql", "-XAtq", "-F", "|",
      "-U", "junctura_admin", "-d", database, "-v", "ON_ERROR_STOP=1", "-f", "-"],
    { input, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 60000, env: dockerEnv() });
}

export function inventory(database, schemas, column, from, to, project) {
  // The catalog supplies identifiers for format(%I). The two tenant IDs
  // have been restricted to the command's public identifier grammar.
  const statement = `
    SELECT format('SELECT %L, count(*) FILTER (WHERE %I=%L), count(*) FILTER (WHERE %I=%L) FROM %I.%I',
      c.table_schema||'.'||c.table_name,c.column_name,'${from}',c.column_name,'${to}',c.table_schema,c.table_name)
    FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema,table_name)
    WHERE t.table_type='BASE TABLE' AND c.table_schema IN (${schemas.map(schema => `'${schema}'`).join(",")})
      AND c.column_name='${column}' ORDER BY c.table_schema,c.table_name
    \\gexec`;
  return psql(database, statement, project).trim().split("\n").filter(Boolean).map(line => {
    const [table, sourceRows, targetRows] = line.split("|");
    return { table, sourceRows: Number(sourceRows), targetRows: Number(targetRows) };
  }).filter(row => row.sourceRows || row.targetRows);
}

export function keycloakTenantGroupCounts(from, to, project) {
  const [source, target] = psql("junctura_identity", `
    SELECT count(*) FILTER (WHERE name='${from}'),count(*) FILTER (WHERE name='${to}')
    FROM keycloak_group WHERE parent_group IS NULL OR parent_group=' ';`, project).trim().split("|").map(Number);
  return { source, target };
}

// Independent read-only re-verification of a sealed tenant audit chain, using
// the same link algorithm as core.audit_verify without requiring an audit
// principal. Read-only: the DO block only reads and reports. A broken chain
// aborts the surrounding transaction (and the read-only statement); an intact
// chain answers "audit-chain-ok" on stdout.
export function auditChainSql(tenant) {
  return `DO $chain$ DECLARE
    r record; prev text := repeat('0', 64); seq bigint := 0; head app_private.audit_chain_heads;
  BEGIN
    FOR r IN SELECT a AS entry, a.chain_seq, a.prev_hash, a.entry_hash AS stored, a.event_id
        FROM app_private.audit a
        WHERE a.tenant_id = ${q(tenant)} AND a.chain_seq IS NOT NULL ORDER BY a.chain_seq LOOP
      IF r.chain_seq <> seq + 1 THEN RAISE EXCEPTION 'audit chain broken at % (missing_entry)', seq + 1; END IF;
      IF r.prev_hash <> prev THEN RAISE EXCEPTION 'audit chain broken at % (chain_link_mismatch)', r.chain_seq; END IF;
      IF app_private.audit_entry_hash(r.entry, r.chain_seq, r.prev_hash) <> r.stored THEN
        RAISE EXCEPTION 'audit chain broken at % (content_modified)', r.chain_seq; END IF;
      seq := r.chain_seq; prev := r.stored;
    END LOOP;
    SELECT * INTO head FROM app_private.audit_chain_heads WHERE tenant_id = ${q(tenant)};
    IF head.tenant_id IS NOT NULL AND (head.last_seq <> seq OR head.last_hash <> prev) THEN
      RAISE EXCEPTION 'audit chain head mismatch for ${tenant}'; END IF;
    IF head.tenant_id IS NULL AND seq > 0 THEN RAISE EXCEPTION 'audit chain head missing for ${tenant}'; END IF;
  END $chain$;
  SELECT 'audit-chain-ok';`;
}

export function collectPreflight({ from, to, name }, project) {
  const core = inventory("junctura_data", ["core", "app_private", "trust_private", "execution_private", "composition_private"], "tenant_id", from, to, project);
  const flowable = inventory("junctura_workflow", ["public"], "tenant_id_", from, to, project);
  const { source: identitySource, target: identityTarget } = keycloakTenantGroupCounts(from, to, project);
  const conflicts = [
    ...core.filter(item => item.targetRows).map(item => `Core ${item.table}`),
    ...flowable.filter(item => item.targetRows).map(item => `Flowable ${item.table}`),
    ...(identityTarget ? ["Keycloak tenant group"] : []),
  ];
  if (core.length === 0 && flowable.length === 0 && !identitySource) conflicts.push("Source tenant has no inventoried data");
  return { from, to, name, core, flowable, keycloakTenantGroups: { source: identitySource, target: identityTarget }, conflicts };
}

function main() {
  const { from, to, name } = parsePreflightArgs(process.argv.slice(2));
  const report = collectPreflight({ from, to, name });
  console.log(JSON.stringify(report, null, 2));
  if (report.conflicts.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`✖ ${error.message}`);
    process.exitCode = 1;
  }
}
