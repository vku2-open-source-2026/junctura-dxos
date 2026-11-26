// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { backupName, compose, sha256 } from "./backup.mjs";

const format = "junctura-app-backup/1";
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const tenantPattern = /^[a-z][a-z0-9-]{0,62}$/;
const queueMessages = "app_private.queue_messages";
const dataTables = [
  ["app_private.record_collections", "owner_app_id"],
  ["core.app_records", "owner_app_id"],
  ["app_private.resource_objects", "owner_app_id"],
  ["app_private.object_quotas", "owner_app_id"],
  ["app_private.resource_shares", "owner_app_id"],
  ["app_private.record_read_grants", "owner_app_id"],
  ["app_private.app_audit_actions", "app_id"],
  ["app_private.audit_app_units", "app_id"],
  ["app_private.audit_app_delegates", "app_id"],
  ["app_private.message_queues", "owner_app_id"],
  [queueMessages, null],
];
const sqlQuote = value => "'" + String(value).replaceAll("'", "''") + "'";
const appWhere = (column, tenant, appId) => `tenant_id=${sqlQuote(tenant)} AND ${column}=${sqlQuote(appId)}`;
const objectFile = id => `object-${id}.bin`;
const tableNames = dataTables.map(([table]) => table);
const legacyTables = tableNames.slice(0, tableNames.indexOf("app_private.message_queues"));
const rowsOf = (snapshot, table) => snapshot.rows[table] ?? [];

export function parseArgs(argv) {
  const [command, subject, ...args] = argv;
  if (command === "backup" && uuid.test(subject ?? "") &&
      (args.length === 0 || (args.length === 2 && args[0] === "--out" && args[1] && !args[1].startsWith("--")))) {
    return { command, appId: subject, out: args[1] };
  }
  if (command === "restore" && subject && !subject.startsWith("--") && args.includes("--yes") &&
      new Set(args).size === args.length && args.every(arg => ["--yes", "--replace"].includes(arg))) {
    return { command, directory: subject, replace: args.includes("--replace") };
  }
  throw new Error("Usage: app-backup.mjs backup <appId> [--out dir] | restore <dir> --yes [--replace]");
}

function regularFile(path) {
  if (!lstatSync(path).isFile()) throw new Error(`Archive entry is not a regular file: ${basename(path)}`);
  return path;
}

export async function validateArchive(directory) {
  const manifest = JSON.parse(readFileSync(regularFile(join(directory, "manifest.json")), "utf8"));
  const { tenant, appId, schemaVersion, files } = manifest;
  if (manifest.format !== format || typeof tenant !== "string" || !tenantPattern.test(tenant) || !uuid.test(appId) ||
      !Number.isSafeInteger(schemaVersion) || schemaVersion < 65 || !Number.isFinite(Date.parse(manifest.createdAt)) ||
      !Array.isArray(files)) throw new Error("Invalid application backup manifest");
  const names = new Set();
  for (const { name, sha256: digest } of files) {
    if (typeof name !== "string" || !(name === "snapshot.json" || name === "audit.json" || (name.startsWith("object-") && name.endsWith(".bin") &&
        uuid.test(name.slice(7, -4)))) || names.has(name) || !/^[a-f0-9]{64}$/.test(digest)) {
      throw new Error("Invalid file inventory");
    }
    if (await sha256(regularFile(join(directory, name))) !== digest) throw new Error(`Checksum mismatch: ${name}`);
    names.add(name);
  }
  if (!names.has("snapshot.json") || !names.has("audit.json") ||
      readdirSync(directory).some(name => name !== "manifest.json" && !names.has(name))) throw new Error("Unexpected archive contents");
  const readMetadata = name => JSON.parse(readFileSync(join(directory, name), "utf8"));
  const snapshot = readMetadata("snapshot.json");
  if (snapshot.appId !== appId || snapshot.tenant !== tenant || snapshot.schemaVersion !== schemaVersion ||
      typeof snapshot.issuer !== "string" || typeof snapshot.client !== "string" || typeof snapshot.owner !== "string" || typeof snapshot.provider !== "string" ||
      !snapshot.rows || ![[...tableNames].sort(), [...legacyTables].sort()].some(names =>
        JSON.stringify(names) === JSON.stringify(Object.keys(snapshot.rows).sort()))) {
    throw new Error("Snapshot scope differs from the manifest");
  }
  const ownedQueues = [];
  for (const [table, column] of dataTables) {
    const rows = rowsOf(snapshot, table);
    if (!Array.isArray(rows)) throw new Error(`Invalid ownership in ${table}`);
    const owned = table === queueMessages
      ? row => ownedQueues.some(queue => queue.queue_id === row.queue_id)
      : row => row[column] === appId;
    if (rows.some(row => row.tenant_id !== tenant || !owned(row))) throw new Error(`Invalid ownership in ${table}`);
    if (table === "app_private.message_queues" && rows.some(row =>
        !Array.isArray(row.producer_apps) || !Array.isArray(row.consumer_apps) ||
        !Array.isArray(row.producer_versions) || !Array.isArray(row.consumer_versions) ||
        !Number.isSafeInteger(row.max_attempts))) {
      throw new Error(`Invalid queue shape in ${table}`);
    }
    if (table === "app_private.message_queues") ownedQueues.push(...rows);
    if (table === queueMessages && rows.some(row => row.lease_app_id != null || row.lease_token != null)) {
      throw new Error("Queue lease credentials in app_private.queue_messages");
    }
  }
  const objects = snapshot.rows["app_private.resource_objects"].filter(row => !row.deleted);
  const expected = new Set(objects.map(row => objectFile(row.id)));
  if (objects.some(row => !uuid.test(row.id) || !uuid.test(row.version) || !names.has(objectFile(row.id)) ||
      !Number.isSafeInteger(row.size_bytes) || row.size_bytes < 1 || row.size_bytes > 5242880 ||
      lstatSync(join(directory, objectFile(row.id))).size !== row.size_bytes) || objects.length !== expected.size ||
      names.size !== expected.size + 2) throw new Error("Object inventory does not match metadata");
  const audit = readMetadata("audit.json");
  if (audit.tenant !== tenant || audit.appId !== appId || !Array.isArray(audit.entries) || audit.entries.some(entry =>
    entry.tenant_id !== tenant || entry.actor_app_id !== appId)) throw new Error("Audit evidence scope differs from the manifest");
  return { manifest, snapshot, objects };
}

const psql = ["exec", "-T", "database", "psql", "-XAtq", "-U", "junctura_admin", "-d", "junctura_data",
  "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=terse"];
async function sql(scratch, text) {
  const input = join(scratch, "command.sql"), output = join(scratch, "result");
  writeFileSync(input, "SET standard_conforming_strings=on;\n" + text, { mode: 0o600 });
  await compose([...psql, "-f", "-"], { input, output });
  return readFileSync(output, "utf8").trim();
}

// A fresh UUID remains inaccessible through Core until PostgreSQL references it.
async function objectBytes(method, tenant, appId, id, version, transfer = {}) {
  if (!tenantPattern.test(tenant) || ![appId, id, version].every(value => uuid.test(value))) throw new Error("Invalid object path");
  await compose(["exec", "-T", "core", "node", "--input-type=module", "-e", `
    import { pipeline } from "node:stream/promises";
    import { Readable } from "node:stream";
    import { requireCleanObject } from "./src/modules/objects/malware-scan.mjs";
    const [method, path] = process.argv.slice(1);
    const options = { method, redirect: "error", signal: AbortSignal.timeout(30000) };
    if (method === "POST") {
      const data = new FormData();
      const bytes = await new Response(Readable.toWeb(process.stdin)).arrayBuffer();
      await requireCleanObject(Buffer.from(bytes), {
        clamavHost: process.env.CLAMAV_HOST, clamavPort: Number(process.env.CLAMAV_PORT),
      });
      data.append("file", new Blob([bytes]), "backup.bin");
      options.body = data;
    }
    const result = await fetch(process.env.OBJECTS_URL + "/" + path, options);
    if (!result.ok && !(method === "DELETE" && result.status === 404)) throw new Error("Object transfer failed (" + result.status + ")");
    if (method === "GET") await pipeline(result.body, process.stdout);
    else await result.arrayBuffer();
  `, method, `junctura-app/${tenant}/${appId}/${id}/${version}`], transfer);
}

function unsupported(tenant, app) {
  return [
    ["app_private.object_upload_staging", "owner_app_id"],
    ["app_private.app_assignments", "app_id"],
    ["app_private.capability_versions", "provider_app_id"],
    ["execution_private.executions", "consumer_app_id"],
    ["composition_private.executions", "consumer_app_id"],
  ].map(([table, col]) => `EXISTS (SELECT FROM ${table} WHERE ${col}=${app} AND tenant_id=${tenant})`).join(" OR ");
}

function snapshotSql(appId) {
  const app = sqlQuote(appId);
  const ownedQueues = "EXISTS (SELECT FROM app_private.message_queues q WHERE (q.tenant_id,q.queue_id)=(r.tenant_id,r.queue_id) AND q.owner_app_id=a.app_id)";
  return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
    SELECT jsonb_build_object('tenant',a.tenant_id,'appId',a.app_id,'issuer',a.issuer,'client',a.oauth_client_id,
      'owner',a.owner_subject,'provider',a.provider_origin,'schemaVersion',(SELECT max(version) FROM core.schema_migrations),
      'unsupported', ${unsupported("a.tenant_id", "a.app_id")},'leased',EXISTS (SELECT FROM app_private.queue_messages r
        WHERE r.tenant_id=a.tenant_id AND r.lease_app_id IS NOT NULL AND r.dead_at IS NULL
          AND r.available_at>statement_timestamp() AND ${ownedQueues}),'rows',jsonb_build_object(
        ${dataTables.map(([table, column]) => `${sqlQuote(table)},(SELECT coalesce(jsonb_agg(${table === queueMessages
          ? "to_jsonb(r) - 'lease_app_id' - 'lease_token'" : "to_jsonb(r)"}), '[]'::jsonb)
          FROM ${table} r WHERE r.tenant_id=a.tenant_id AND ${table === queueMessages ? ownedQueues
            : `r.${column}=a.app_id`})`).join(",\n")}
      ),'audit',jsonb_build_object('tenant',a.tenant_id,'appId',a.app_id,'entries',(
        SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.chain_seq), '[]'::jsonb)
        FROM app_private.audit e WHERE e.tenant_id=a.tenant_id AND e.actor_app_id=a.app_id)))
    FROM app_private.applications a WHERE a.app_id=${app};
    COMMIT;`;
}

const operatorClaims = tenant => sqlQuote(JSON.stringify({ tenant_id: tenant,
  iss: "urn:junctura:operator", sub: "compose-operator", client_id: "app-backup" }));

async function backup(options, scratch) {
  const result = await sql(scratch, snapshotSql(options.appId));
  if (!result || result.split("\n").length !== 1) throw new Error("Application ID did not identify one application");
  const { audit, unsupported: unsupportedState, leased, ...snapshot } = JSON.parse(result);
  if (unsupportedState) throw new Error("Application has state outside the supported backup tables");
  if (leased) throw new Error("Application has an active queue lease");
  const { tenant, appId, schemaVersion } = snapshot;
  const directory = resolve(options.out ?? `backups/app-${appId.slice(0, 8)}-${backupName()}`);
  if (existsSync(directory)) throw new Error("Backup directory already exists");
  mkdirSync(dirname(directory), { recursive: true });
  const temporary = mkdtempSync(join(dirname(directory), ".app-backup-"));
  let audited = false;
  try {
    writeFileSync(join(temporary, "snapshot.json"), JSON.stringify(snapshot));
    writeFileSync(join(temporary, "audit.json"), JSON.stringify(audit));
    for (const row of snapshot.rows["app_private.resource_objects"]) {
      if (row.deleted) continue;
      const path = join(temporary, objectFile(row.id));
      await objectBytes("GET", tenant, appId, row.id, row.version, { output: path });
    }
    const files = [];
    for (const name of readdirSync(temporary).sort()) files.push({ name, sha256: await sha256(join(temporary, name)) });
    writeFileSync(join(temporary, "manifest.json"), JSON.stringify({
      format, tenant, appId, schemaVersion, createdAt: new Date().toISOString(), files,
    }, null, 2) + "\n");
    await validateArchive(temporary);
    if (existsSync(directory)) throw new Error("Backup directory already exists");
    const digest = await sha256(join(temporary, "manifest.json"));
    await sql(scratch, `BEGIN;
      SELECT set_config('request.jwt.claims',${operatorClaims(tenant)},true);
      SELECT app_private.audit_append('application.backed_up','application',${sqlQuote(appId)},0,
        'success','app_backup',${sqlQuote(digest)});
      COMMIT;`);
    audited = true;
    try { renameSync(temporary, directory); }
    catch { throw new Error(`Verified backup remains at ${temporary}`); }
    console.log(`Application backup: ${directory}`);
  } finally { if (!audited) rmSync(temporary, { recursive: true, force: true }); }
}

function requireDependencies(snapshot) {
  const source = table => `jsonb_populate_recordset(NULL::${table}, ${sqlQuote(JSON.stringify(rowsOf(snapshot, table)))}::jsonb)`;
  return `
    IF EXISTS (SELECT FROM ${source("app_private.resource_shares")} s
      WHERE (s.grantee_app_id IS NOT NULL AND NOT EXISTS (SELECT FROM app_private.applications a
              WHERE (a.tenant_id,a.app_id)=(s.tenant_id,s.grantee_app_id)))
        OR (s.grantee_app_group IS NOT NULL AND NOT EXISTS (SELECT FROM app_private.app_groups g
              WHERE (g.tenant_id,g.app_group)=(s.tenant_id,s.grantee_app_group))))
      THEN RAISE EXCEPTION 'Missing dependency for a resource share'; END IF;
    IF EXISTS (SELECT FROM ${source("app_private.record_read_grants")} r
      WHERE NOT EXISTS (SELECT FROM app_private.principals p
        WHERE (p.tenant_id,p.issuer,p.subject,p.management_client)=(r.tenant_id,r.issuer,r.subject,r.management_client)))
      THEN RAISE EXCEPTION 'Missing dependency for a record read grant'; END IF;
    IF EXISTS (SELECT FROM ${source("app_private.audit_app_units")} r
      WHERE NOT EXISTS (SELECT FROM app_private.directory_units u
        WHERE (u.tenant_id,u.unit)=(r.tenant_id,r.unit) AND NOT u.pending_delete))
      THEN RAISE EXCEPTION 'Missing dependency for an audit unit'; END IF;
    IF EXISTS (SELECT FROM ${source("app_private.message_queues")} q, unnest(q.producer_apps) peer
      WHERE NOT EXISTS (SELECT FROM app_private.applications a WHERE (a.tenant_id,a.app_id)=(q.tenant_id,peer)))
      THEN RAISE EXCEPTION 'Missing dependency for a queue producer app'; END IF;
    IF EXISTS (SELECT FROM ${source("app_private.message_queues")} q, unnest(q.consumer_apps) peer
      WHERE NOT EXISTS (SELECT FROM app_private.applications a WHERE (a.tenant_id,a.app_id)=(q.tenant_id,peer)))
      THEN RAISE EXCEPTION 'Missing dependency for a queue consumer app'; END IF;
    IF EXISTS (SELECT FROM ${source(queueMessages)} m
      WHERE NOT EXISTS (SELECT FROM app_private.applications a WHERE (a.tenant_id,a.app_id)=(m.tenant_id,m.producer_app_id)))
      THEN RAISE EXCEPTION 'Missing dependency for a queue message producer'; END IF;
    IF EXISTS (SELECT FROM ${source("app_private.message_queues")} q,
        unnest(q.producer_versions || q.consumer_versions) capability_version
      WHERE NOT EXISTS (SELECT FROM app_private.capability_versions v
        WHERE (v.tenant_id,v.provider_app_id,v.version_id)=(q.tenant_id,q.owner_app_id,capability_version)))
      THEN RAISE EXCEPTION 'Missing dependency for a queue capability version'; END IF;
  `;
}

function ownedState(table, column, tenant, appId) {
  return table === queueMessages
    ? `EXISTS (SELECT FROM ${table} m WHERE m.tenant_id=${sqlQuote(tenant)} AND EXISTS (SELECT FROM app_private.message_queues q
        WHERE (q.tenant_id,q.queue_id)=(m.tenant_id,m.queue_id) AND q.owner_app_id=${sqlQuote(appId)}))`
    : `EXISTS (SELECT FROM ${table} WHERE ${appWhere(column, tenant, appId)})`;
}

function targetChecks(snapshot, replace) {
  const { tenant, appId, schemaVersion, issuer, client, owner, provider } = snapshot;
  const t = sqlQuote(tenant), a = sqlQuote(appId);
  const owned = column => appWhere(column, tenant, appId);
  const uncovered = dataTables.filter(([table]) => !(table in snapshot.rows));
  return `
    PERFORM pg_advisory_xact_lock(hashtextextended(${sqlQuote(`junctura.app-backup:${tenant}:${appId}`)},0));
    PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('object-quota',${t}::text,${a}::uuid)::text,0));
    PERFORM FROM app_private.applications
      WHERE ${owned("app_id")} AND issuer=${sqlQuote(issuer)} AND oauth_client_id=${sqlQuote(client)}
        AND owner_subject=${sqlQuote(owner)} AND provider_origin=${sqlQuote(provider)} FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Matching application enrollment is required'; END IF;
    PERFORM FROM app_private.enrollments WHERE tenant_id=${t} AND issuer=${sqlQuote(issuer)}
      AND oauth_client_id=${sqlQuote(client)} AND owner_subject=${sqlQuote(owner)} FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Matching application enrollment is required'; END IF;
    PERFORM FROM app_private.message_queues WHERE ${owned("owner_app_id")} FOR UPDATE;
    IF EXISTS (SELECT FROM app_private.queue_messages m WHERE m.tenant_id=${t} AND m.lease_app_id IS NOT NULL
        AND m.dead_at IS NULL AND m.available_at>statement_timestamp() AND EXISTS (
          SELECT FROM app_private.message_queues q WHERE (q.tenant_id,q.queue_id)=(m.tenant_id,m.queue_id)
            AND q.owner_app_id=${a}))
      THEN RAISE EXCEPTION 'Target application has an active queue lease'; END IF;
    IF (SELECT max(version) FROM core.schema_migrations)<${schemaVersion}
      THEN RAISE EXCEPTION 'Target database is older than the backup'; END IF;
    IF ${unsupported(t, a)} THEN RAISE EXCEPTION 'Target application has unsupported state'; END IF;
    ${requireDependencies(snapshot)}
    ${replace && uncovered.length ? `IF ${uncovered.map(([table, column]) => ownedState(table, column, tenant, appId)).join(" OR ")}
        THEN RAISE EXCEPTION 'Target application has state outside the archive'; END IF;` : ""}
    ${replace ? "" : `IF ${dataTables.map(([table, column]) => ownedState(table, column, tenant, appId)).join(" OR ")}
        THEN RAISE EXCEPTION 'Target application has existing state, use --replace'; END IF;`}
    `;
}

function restoreSql(snapshot, replace, operation) {
  const t = sqlQuote(snapshot.tenant), a = sqlQuote(snapshot.appId);
  const owned = column => appWhere(column, snapshot.tenant, snapshot.appId);
  const claims = operatorClaims(snapshot.tenant);
  const records = "core.app_records";
  const rows = table => `jsonb_populate_recordset(NULL::${table}, ${sqlQuote(JSON.stringify(rowsOf(snapshot, table)))}::jsonb)`;
  const inserts = dataTables.filter(([table]) => rowsOf(snapshot, table).length).map(([table]) =>
    `INSERT INTO ${table} SELECT x.* FROM ${rows(table)} x${table === records
      ? " WHERE NOT EXISTS (SELECT FROM core.app_records y WHERE (y.tenant_id,y.id)=(x.tenant_id,x.id))" : ""};`).join("\n");
  const immutableRecords =
    `IF EXISTS (SELECT FROM core.app_records r WHERE r.${owned("owner_app_id")} AND to_jsonb(r)->>'archived_at' IS NOT NULL
        AND NOT EXISTS (SELECT FROM ${rows(records)} x WHERE to_jsonb(r)=to_jsonb(x)))
      THEN RAISE EXCEPTION 'Replace cannot alter an archived record'; END IF;`;
  const queueLeases = `IF EXISTS (SELECT FROM ${rows(queueMessages)} x
      WHERE (x.lease_app_id IS NOT NULL OR x.lease_token IS NOT NULL) AND x.dead_at IS NULL)
    THEN RAISE EXCEPTION 'Active queue lease cannot be restored'; END IF;`;
  return `BEGIN;
    SET LOCAL lock_timeout='10s';
    DO $checks$ BEGIN ${targetChecks(snapshot, replace)} ${immutableRecords} ${queueLeases} END $checks$;
    ${replace ? dataTables.filter(([table]) => table in snapshot.rows).reverse().map(([table, col]) =>
      `DELETE FROM ${table} r WHERE ${col === null
        ? `r.tenant_id=${t} AND EXISTS (SELECT FROM app_private.message_queues q
            WHERE (q.tenant_id,q.queue_id)=(r.tenant_id,r.queue_id) AND q.owner_app_id=${a})`
        : owned(col)}${table === records ? " AND to_jsonb(r)->>'archived_at' IS NULL" : ""};`).join("\n") : ""}
    ${inserts}
    SELECT app_private.record_replace_projection(r) FROM core.app_records r WHERE ${owned("owner_app_id")};
    DO $audit$ BEGIN
      PERFORM set_config('request.jwt.claims',${claims},true);
      PERFORM app_private.audit_append('application.restored','application',${a},0,'success','app_restore',${sqlQuote(operation)});
    END $audit$;
    COMMIT;`;
}

async function restore(options, scratch) {
  const directory = resolve(options.directory);
  const { manifest, snapshot, objects } = await validateArchive(directory);
  const checksums = new Map(manifest.files.map(file => [file.name, file.sha256]));
  await sql(scratch, `DO $checks$ BEGIN ${targetChecks(snapshot, options.replace)} END $checks$;`);
  const { tenant, appId } = snapshot;
  const staged = [];
  const operation = randomUUID();
  let mayBeCommitted = false;
  try {
    for (const row of objects) {
      row.version = randomUUID();
      staged.push(row);
      const input = join(directory, objectFile(row.id)), checked = join(scratch, "object");
      await objectBytes("POST", tenant, appId, row.id, row.version, { input });
      await objectBytes("GET", tenant, appId, row.id, row.version, { output: checked });
      if (checksums.get(objectFile(row.id)) !== await sha256(checked)) throw new Error("Staged object checksum mismatch");
    }
    mayBeCommitted = true;
    try {
      await sql(scratch, restoreSql(snapshot, options.replace, operation));
    } catch (error) {
      const confirmed = await sql(scratch, `SELECT count(*) FROM app_private.audit WHERE ${appWhere("resource_id", tenant, appId)}
        AND event='application.restored' AND reason=${sqlQuote(operation)};`);
      if (confirmed !== "1") { mayBeCommitted = false; throw error; }
    }
    console.log(`Restored application ${appId} in ${tenant}`);
  } finally {
    if (!mayBeCommitted) for (const row of staged) {
      await objectBytes("DELETE", tenant, appId, row.id, row.version).catch(() => {});
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const scratch = mkdtempSync(join(resolve(process.env.TMPDIR ?? "/tmp"), "junctura-app-backup-"));
  chmodSync(scratch, 0o700);
  try {
    if (options.command === "backup") await backup(options, scratch);
    else await restore(options, scratch);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
