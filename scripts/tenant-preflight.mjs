// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  from: { type: "string" }, to: { type: "string" }, name: { type: "string" },
} });
const from = values.from;
const to = values.to;
const name = values.name?.trim();
const tenant = /^[a-z][a-z0-9-]{0,62}$/;
if (positionals.length || !tenant.test(from ?? "") || !tenant.test(to ?? "") ||
    from === to || !name || name.length > 120 || /[\u0000-\u001f\u007f]/u.test(name)) {
  throw new Error("Usage: npm run tenant:preflight -- --from <old-id> --to <new-id> --name <display-name>");
}

function psql(database, statement) {
  const input = "BEGIN READ ONLY;\n" + statement + "\nCOMMIT;\n";
  return execFileSync("docker", ["compose", "exec", "-T", "database", "psql", "-XAtq", "-F", "|",
    "-U", "junctura_admin", "-d", database, "-v", "ON_ERROR_STOP=1", "-f", "-"],
  { input, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 60000 });
}

function inventory(database, schemas, column) {
  // The catalog supplies identifiers for format(%I). The two tenant IDs
  // have been restricted to the command's public identifier grammar.
  const statement = `
    SELECT format('SELECT %L, count(*) FILTER (WHERE %I=%L), count(*) FILTER (WHERE %I=%L) FROM %I.%I',
      c.table_schema||'.'||c.table_name,c.column_name,'${from}',c.column_name,'${to}',c.table_schema,c.table_name)
    FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema,table_name)
    WHERE t.table_type='BASE TABLE' AND c.table_schema IN (${schemas.map(schema => `'${schema}'`).join(",")})
      AND c.column_name='${column}' ORDER BY c.table_schema,c.table_name
    \\gexec`;
  return psql(database, statement).trim().split("\n").filter(Boolean).map(line => {
    const [table, sourceRows, targetRows] = line.split("|");
    return { table, sourceRows: Number(sourceRows), targetRows: Number(targetRows) };
  }).filter(row => row.sourceRows || row.targetRows);
}
const core = inventory("junctura_data", ["core", "app_private", "trust_private", "execution_private", "composition_private"], "tenant_id");
const flowable = inventory("junctura_workflow", ["public"], "tenant_id_");
const [identitySource, identityTarget] = psql("junctura_identity", `
  SELECT count(*) FILTER (WHERE name='${from}'),count(*) FILTER (WHERE name='${to}')
  FROM keycloak_group WHERE parent_group IS NULL OR parent_group=' ';`).trim().split("|").map(Number);
const conflicts = [
  ...core.filter(item => item.targetRows).map(item => `Core ${item.table}`),
  ...flowable.filter(item => item.targetRows).map(item => `Flowable ${item.table}`),
  ...(identityTarget ? ["Keycloak tenant group"] : []),
];
if (core.length === 0 && flowable.length === 0 && !identitySource) conflicts.push("Source tenant has no inventoried data");
console.log(JSON.stringify({ from, to, name, core, flowable, keycloakTenantGroups: { source: identitySource, target: identityTarget },
  conflicts }, null, 2));
if (conflicts.length) process.exitCode = 1;
