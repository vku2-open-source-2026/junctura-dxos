// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Disposable PostgreSQL proof for the migration runner: checksums, drift,
// version-only adoption, interrupted transactions and concurrent runners.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const image = readFileSync(new URL("../compose.yaml", import.meta.url), "utf8").match(/image: (postgres:[^\s]+)/)[1];
const name = `junctura-migration-test-${randomUUID()}`;
const directory = mkdtempSync(join(tmpdir(), "junctura-migrations-"));
const migrations = readdirSync(resolve("infra/postgres")).filter(file => /^\d{3}-.+\.sql$/.test(file));
const latestVersion = String(Math.max(...migrations.map(file => Number(file.slice(0, 3)))));
const migrationCount = String(migrations.length);
const run = promisify(execFile);
const docker = (...args) => run("docker", args, { timeout: 120000, maxBuffer: 2097152 });
const sql = async (text, database = "junctura_data") => (await docker("exec", name, "psql", "-X", "-U", "junctura_admin", "-d", database, "-Atq", "-v", "ON_ERROR_STOP=1", "-c", text)).stdout.trim();
async function migrate(env = {}, database = "junctura_data") {
  const args = ["exec"];
  for (const [key, value] of Object.entries(env)) args.push("-e", `${key}=${value}`);
  args.push(name, "sh", "/migrations/migrate.sh", "-U", "junctura_admin", "-d", database, "-v", "ON_ERROR_STOP=1");
  return run("docker", args, { timeout: 120000, maxBuffer: 2097152 });
}
async function refused(env = {}) {
  try { await migrate(env); } catch (error) { return String(error.stderr ?? error.message); }
  assert.fail("migration runner should have refused");
}

before(async () => {
  cpSync(resolve("infra/postgres"), directory, { recursive: true });
  await docker("run", "--detach", "--name", name, "--network", "none", "--tmpfs", "/var/lib/postgresql/data:rw",
    "-e", "POSTGRES_USER=junctura_admin", "-e", "POSTGRES_DB=junctura_data", "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
    "--mount", `type=bind,source=${directory},target=/migrations,readonly`, image);
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { await docker("exec", name, "psql", "-X", "-h", "127.0.0.1", "-U", "junctura_admin", "-d", "junctura_data", "-Atqc", "SELECT 1"); ready = true; break; }
    catch { await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  assert.ok(ready, "fresh disposable database ready");
  await sql("CREATE ROLE junctura_data NOLOGIN NOINHERIT; ALTER DATABASE junctura_data OWNER TO junctura_data;");
});

after(async () => {
  await docker("rm", "--force", name).catch(() => {});
  rmSync(directory, { recursive: true, force: true });
});

test("fresh install records every checksum atomically", async () => {
  await migrate();
  assert.equal(await sql("SELECT max(version) FROM core.schema_migrations"), latestVersion);
  assert.equal(await sql("SELECT count(*) FROM core.schema_migration_checksums WHERE length(sha256) = 64 AND NOT adopted"), migrationCount);
  assert.equal(await sql("SELECT count(*) FROM core.schema_migration_checksums c JOIN core.schema_migrations m USING (version)"), migrationCount);
  assert.equal(await sql("SELECT last_version FROM core.schema_migration_state WHERE id = 1"), latestVersion);
});

test("workflow migration preserves legacy reservations and scopes worker leases", async () => {
  const tenant = "workflow-migration";
  const key = randomUUID();
  await sql(`INSERT INTO core.workflow_requests (tenant_id, key, definition_id, input_hash, engine_id)
    VALUES ('${tenant}', '${key}', 'checkpoint:1:1', repeat('0', 64), 'old-execution');`);
  assert.equal(await sql(`SET ROLE junctura_workflow_api;
    SELECT set_config('request.jwt.claims','{"tenant_id":"${tenant}","role":"junctura_workflow_api"}',false);
    SELECT core.workflow_execution_command('get','{"executionId":"old-execution"}')->'value';`).then(result => result.split("\n").at(-1)), "null");
  assert.equal(await sql(`SELECT engine_id FROM core.workflow_requests WHERE tenant_id='${tenant}' AND key='${key}';`), "old-execution");
  assert.equal(await sql(`SELECT has_function_privilege('junctura_workflow_api','core.workflow_worker_command(text,jsonb)','EXECUTE'),
    has_table_privilege('junctura_workflow_worker','app_private.workflow_completion_outbox','SELECT'),
    has_table_privilege('junctura_api','app_private.workflow_definition_policies','INSERT');`), "f|f|f");

  await sql(`INSERT INTO app_private.workflow_executions
    (tenant_id,caller_scope,request_key,digest,definition_id,definition_key,steps,execution_id,start_result)
    VALUES ('${tenant}',sha256(''::bytea),'${key}',sha256(''::bytea),'workflow:1:1','workflow','{}','execution','{}');
    INSERT INTO app_private.workflow_completion_outbox
    (tenant_id,execution_id,definition_id,task_id,engine_execution_id,step_key,unit,candidate_group,actor_subject,variables)
    VALUES ('${tenant}','execution','workflow:1:1','task','child-execution','review','unit','group','subject','{}');`);
  const worker = async (operation, payload = {}, scope) => {
    const claims = JSON.stringify({ role: "junctura_workflow_worker", tenant_id: scope });
    const output = await sql(`SET ROLE junctura_workflow_worker;
      SELECT set_config('request.jwt.claims','${claims}',false);
      SELECT core.workflow_worker_command('${operation}','${JSON.stringify(payload)}');`);
    return JSON.parse(output.split("\n").at(-1));
  };
  const { value: leased } = await worker("lease");
  assert.equal(leased.tenant_id, tenant);
  assert.equal(leased.task_id, "task");
  assert.equal((await worker("lease")).value, null);
  const settle = { taskId: leased.task_id, lease: leased.lease, state: "cancelled" };
  await worker("settle", settle, "foreign-tenant");
  assert.equal(await sql(`SELECT state FROM app_private.workflow_completion_outbox WHERE tenant_id='${tenant}';`), "pending");
  await worker("settle", { ...settle, lease: randomUUID() }, tenant);
  assert.equal(await sql(`SELECT state FROM app_private.workflow_completion_outbox WHERE tenant_id='${tenant}';`), "pending");
  await worker("settle", settle, tenant);
  assert.equal(await sql(`SELECT state FROM app_private.workflow_completion_outbox WHERE tenant_id='${tenant}';`), "cancelled");
});

test("workflow cancellation resume is tenant-scoped and fenced by the current lease", async () => {
  const tenant = "workflow-cancel";
  await sql(`INSERT INTO app_private.workflow_executions
    (tenant_id,caller_scope,request_key,digest,definition_id,definition_key,steps,execution_id,start_result,cancel_requested)
    VALUES ('${tenant}',sha256(''::bytea),gen_random_uuid(),sha256(''::bytea),'workflow:1:1','workflow','{}','execution','{}',true);`);
  const command = async (operation, payload = {}, scope = tenant) => {
    const claims = JSON.stringify({ role: "junctura_workflow_api", tenant_id: scope, resource_writer: true });
    const output = await sql(`SET ROLE junctura_workflow_api;
      SELECT set_config('request.jwt.claims','${claims}',false);
      SELECT core.workflow_task_command('${operation}','${JSON.stringify({ executionId: "execution", ...payload })}');`);
    return JSON.parse(output.split("\n").at(-1));
  };
  const flag = () => sql(`SELECT cancel_requested FROM app_private.workflow_executions WHERE tenant_id='${tenant}';`);
  assert.deepEqual(await command("history"), { status: 200, value: [] });
  assert.deepEqual(await command("history", { executionId: "legacy" }), { status: 200, value: [] });
  const first = await command("cancel", { status: "running" });
  assert.equal(first.status, 200);
  assert.ok(first.value);
  assert.equal((await command("cancel", { status: "running" })).error, "task_conflict");
  await command("resume", { lease: first.value }, "another-tenant");
  assert.equal(await flag(), "t");
  await sql(`UPDATE app_private.workflow_executions SET cancel_lease_until='-infinity' WHERE tenant_id='${tenant}';`);
  const replacement = await command("cancel", { status: "running" });
  assert.equal(replacement.status, 200);
  assert.notEqual(replacement.value, first.value);
  await command("resume", { lease: first.value });
  assert.equal(await flag(), "t");
  assert.equal((await command("resume", { lease: replacement.value })).status, 204);
  assert.equal(await flag(), "f");
});

test("upgrading 029 preserves records and backfills incarnations without a table rewrite", async () => {
  const database = "record_upgrade";
  const upgradeDir = join(directory, "record-upgrade");
  mkdirSync(upgradeDir);
  const recordId = randomUUID();
  const appId = randomUUID();
  await sql(`CREATE DATABASE ${database} OWNER junctura_data`);
  try {
    for (const migration of migrations.filter(file => Number(file.slice(0, 3)) <= 29)) {
      cpSync(join(directory, migration), join(upgradeDir, migration));
    }
    const upgrade = () => migrate({ MIGRATION_DIR: "/migrations/record-upgrade" }, database);
    await upgrade();
    await sql(`INSERT INTO app_private.applications
      (tenant_id,app_id,issuer,oauth_client_id,owner_subject,provider_origin,display_name,digest)
      VALUES('tenant-a','${appId}','https://fixture.invalid','fixture','subject','https://fixture.invalid',
        'Migration fixture','sha256:${"0".repeat(64)}');
      INSERT INTO core.records(tenant_id,id,collection,data)
        VALUES('tenant-a','${recordId}','fixture','{"legacy":true}');
      INSERT INTO core.app_records(tenant_id,id,owner_app_id,collection,data,created_at)
        VALUES('tenant-a','${recordId}','${appId}','fixture','{"legacy":false}','2026-01-01T00:00:00Z');`, database);
    const relationFile = () => sql("SELECT pg_relation_filenode('core.app_records')", database);
    const before = await relationFile();
    for (const migration of migrations.filter(file => file.startsWith("030-"))) {
      cpSync(join(directory, migration), join(upgradeDir, migration));
    }
    await upgrade();
    assert.equal(await relationFile(), before);
    assert.equal(await sql(`SELECT version, incarnation IS NOT NULL, owner_app_id, collection,
      created_at ='2026-01-01T00:00:00Z'::timestamptz, data->>'legacy' FROM core.app_records WHERE id = '${recordId}'`, database),
    `1|t|${appId}|fixture|t|false`);
    assert.equal(await sql(`SELECT data->>'legacy' FROM core.records WHERE id = '${recordId}'`, database), "true");
    assert.equal(await sql(`SELECT record_count FROM app_private.record_collections WHERE owner_app_id = '${appId}'`, database), "1");
    assert.equal(await sql(`INSERT INTO core.app_records(tenant_id,id,owner_app_id,collection,data)
      VALUES('tenant-a',gen_random_uuid(),'${appId}','fixture','{}')
      RETURNING incarnation <> (SELECT incarnation FROM core.app_records WHERE id = '${recordId}')`, database), "t");
  } finally {
    await sql(`DROP DATABASE ${database}`);
    rmSync(upgradeDir, { recursive: true, force: true });
  }
});

test("repeat execution verifies without replaying", async () => {
  const { stdout } = await migrate();
  assert.match(stdout, /Migration 9 verified/);
  assert.doesNotMatch(stdout, /Applying migration/);
});

test("missing historical migration and duplicate version fail before application", async () => {
  const file = join(directory, "005-audit-protection.sql");
  const original = readFileSync(file);
  rmSync(file);
  try { assert.match(await refused(), /applied-version integrity/); }
  finally { writeFileSync(file, original); }
  const duplicate = join(directory, "005-duplicate.sql");
  writeFileSync(duplicate, original);
  try { assert.match(await refused(), /duplicate local migration version/); }
  finally { rmSync(duplicate); }
  await migrate();
});

test("edited applied content fails closed", async () => {
  const file = join(directory, "001-data.sql");
  const original = readFileSync(file, "utf8");
  writeFileSync(file, `${original}\n-- edited history\n`);
  try {
    assert.match(await refused(), /content differs from its recorded checksum/);
  } finally { writeFileSync(file, original); }
  await migrate();
});

test("interrupted migration leaves neither its objects nor its checksum", async () => {
  const file = join(directory, "098-interrupted.sql");
  writeFileSync(file, "BEGIN;\nCREATE TABLE core.interrupted_probe(id int);\nDO $$ BEGIN RAISE EXCEPTION 'synthetic interruption'; END $$;\nINSERT INTO core.schema_migrations(version) VALUES (98);\nCOMMIT;\n");
  try {
    assert.match(await refused(), /synthetic interruption/);
  } finally { rmSync(file); }
  assert.equal(await sql("SELECT to_regclass('core.interrupted_probe') IS NULL"), "t");
  assert.equal(await sql("SELECT count(*) FROM core.schema_migration_checksums WHERE version = 98"), "0");
  assert.equal(await sql("SELECT count(*) FROM core.schema_migrations WHERE version = 98"), "0");
});

test("concurrent runners serialize and converge", async () => {
  const results = await Promise.all([migrate(), migrate()]);
  assert.equal(results.length, 2);
  assert.equal(await sql("SELECT count(*) FROM core.schema_migration_checksums"), migrationCount);
  assert.equal(await sql("SELECT count(*) FROM core.schema_migrations"), migrationCount);
});

test("upgrading from 035 maps legacy consents one way and quarantines unmapped rows", async () => {
  const database = "consent_upgrade";
  const upgradeDir = join(directory, "consent-upgrade");
  mkdirSync(upgradeDir);
  const appId = randomUUID();
  await sql(`CREATE DATABASE ${database} OWNER junctura_data`);
  try {
    for (const migration of migrations.filter(file => Number(file.slice(0, 3)) <= 35)) {
      cpSync(join(directory, migration), join(upgradeDir, migration));
    }
    await migrate({ MIGRATION_DIR: "/migrations/consent-upgrade" }, database);
    const issuer = "https://fixture.invalid";
    const capability = `urn:junctura:capability:${appId}:lookup`;
    await sql(`INSERT INTO app_private.applications
      (tenant_id,app_id,issuer,oauth_client_id,owner_subject,provider_origin,display_name,digest,state)
      VALUES('tenant-a','${appId}','${issuer}','fixture','subject','https://fixture.invalid',
        'Consent fixture','sha256:${"0".repeat(64)}','active');
      INSERT INTO execution_private.subject_consents(tenant_id,issuer,data_subject,consumer_app_id,capability_id,purposes,expires_at)
        SELECT 'tenant-a','${issuer}',login,'${appId}','${capability}',
          ARRAY['service_review']::text[],now()+interval '2 hours'
        FROM unnest(ARRAY['legacy-person','verified-1','late-person']) login;`, database);
    const addVersions = (min, max) => {
      for (const migration of migrations.filter(file => {
        const version = Number(file.slice(0, 3));
        return version >= min && version <= max;
      })) cpSync(join(directory, migration), join(upgradeDir, migration));
    };
    const upgrade = () => migrate({ MIGRATION_DIR: "/migrations/consent-upgrade" }, database);
    addVersions(36, 36);
    await upgrade();
    const bind = (subject, login) => `INSERT INTO app_private.subject_bindings(tenant_id,issuer,subject_id,login_subject)
      VALUES('tenant-a','${issuer}','${subject}','${login}')`;
    await sql(bind("verified-1", "legacy-person"), database);
    addVersions(37, 38);
    await upgrade();
    const mappings = () => sql(`SELECT jsonb_object_agg(data_subject,canonical_subject)
      FROM execution_private.subject_consents WHERE consumer_app_id='${appId}';`, database);
    assert.deepEqual(JSON.parse(await mappings()), { "legacy-person": "verified-1", "verified-1": null, "late-person": null });
    await sql(bind("verified-2", "late-person"), database);
    assert.deepEqual(JSON.parse(await mappings()), { "legacy-person": "verified-1", "verified-1": null, "late-person": "verified-2" });
    const results = await Promise.allSettled([
      sql(`BEGIN; ${bind("cross-id", "login-a")}; SELECT pg_sleep(0.3); COMMIT;`, database),
      sql(`BEGIN; ${bind("canonical-b", "cross-id")}; SELECT pg_sleep(0.3); COMMIT;`, database),
    ]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.match(results.find(result => result.status === "rejected").reason.stderr, /must not share identifiers/);
    await assert.rejects(sql("UPDATE app_private.subject_bindings SET login_subject='different' WHERE subject_id='verified-1';", database),
      /operator reconciliation/);
    await assert.rejects(sql("DELETE FROM app_private.subject_bindings WHERE subject_id='verified-1';", database),
      /operator reconciliation/);
  } finally {
    await sql(`DROP DATABASE ${database}`);
    rmSync(upgradeDir, { recursive: true, force: true });
  }
});

test("directory confirmation requires the current lease and generation", async () => {
  const tenant = "directory-lease-test";
  const claims = { tenant_id: tenant, sub: "tester", iss: "https://directory.invalid", client_id: "manager",
    role: "junctura_directory_api", directory_writer: true };
  const rpc = async (operation, payload, session = claims) => JSON.parse((await sql(`
    SET ROLE ${session.role};
    SELECT set_config('request.jwt.claims','${JSON.stringify(session)}',true);
    SELECT core.directory_command('${operation}','${JSON.stringify(payload)}');
  `)).split("\n").at(-1));
  await sql(`INSERT INTO app_private.principals(tenant_id,issuer,subject,management_client,permissions)
    VALUES('${tenant}','${claims.iss}','${claims.sub}','${claims.client_id}',ARRAY['directory.write']);`);
  const old = randomUUID(), current = randomUUID();
  assert.equal((await rpc("unit_type_put", { unitType: "office", name: "Office" })).status, 201);
  assert.equal((await rpc("sync_acquire", { lease: old })).status, 204);
  assert.equal((await rpc("sync_acquire", { lease: current })).status, 409);
  const keys = { unit: "office-a" };
  const first = await rpc("unit_put", { ...keys, unitType: "office", name: "Old", lease: old });
  assert.equal(first.status, 201);
  assert.deepEqual((await rpc("unit_list", { limit: 10 })).value.items, []);
  await sql(`UPDATE app_private.directory_sync_leases SET expires_at='-infinity' WHERE tenant_id='${tenant}';`);
  assert.equal((await rpc("sync_acquire", { lease: current })).status, 204);
  const next = await rpc("unit_put", { ...keys, unitType: "office", name: "Current", lease: current });
  assert.equal(next.status, 200);
  assert.equal((await rpc("unit_confirm", { ...keys, lease: old, generation: next.generation })).status, 409);
  assert.equal((await rpc("unit_confirm", { ...keys, lease: current, generation: first.generation })).status, 409);
  assert.equal((await rpc("unit_confirm", { ...keys, lease: current, generation: next.generation })).status, 204);
  assert.deepEqual((await rpc("unit_list", { limit: 10 })).value.items, [{ ...keys, unitType: "office", name: "Current" }]);
  const worker = { role: "junctura_directory_worker", tenant_id: tenant };
  assert.ok((await rpc("sync_tenants", {}, worker)).value.includes(tenant));
  assert.equal((await rpc("unit_put", { ...keys, lease: current }, worker)).status, 403);
  const job = (await rpc("sync_next", { lease: current }, worker)).value;
  assert.deepEqual([job.kind, job.keys, job.generation], ["unit", keys, next.generation]);
});

test("version-only history requires explicit operator adoption", async () => {
  await sql("TRUNCATE core.schema_migration_checksums");
  assert.match(await refused(), /version-only history/);
  await migrate({ MIGRATION_ADOPT_EXISTING: 1 });
  assert.equal(await sql("SELECT count(*) FROM core.schema_migration_checksums WHERE adopted"), migrationCount);
});

test("composition RLS drift is covered after the versioned fingerprint upgrade", async () => {
  await sql("ALTER TABLE composition_private.executions DISABLE ROW LEVEL SECURITY");
  try { assert.match(await refused(), /installed schema drift detected/); }
  finally { await sql("ALTER TABLE composition_private.executions ENABLE ROW LEVEL SECURITY"); }
  await migrate();
});

test("installed schema drift is detected and only adopted after review", async () => {
  await sql("ALTER POLICY tenant_isolation ON core.records USING (true)");
  assert.match(await refused(), /installed schema drift detected/);
  await migrate({ MIGRATION_ADOPT_SCHEMA_DRIFT: 1 });
  await migrate();
  assert.equal(await sql("SELECT last_version FROM core.schema_migration_state WHERE id = 1"), latestVersion);
});

test("a database newer than the runner is refused", async () => {
  const subset = join(directory, "subset");
  mkdirSync(subset);
  try {
    for (const entry of readdirSync(directory).filter(entry => /^0(0[1-9]|10)-.*\.sql$/.test(entry))) {
      writeFileSync(join(subset, entry), readFileSync(join(directory, entry)));
    }
    assert.match(await refused({ MIGRATION_DIR: "/migrations/subset" }), /newer than this migration set/);
  } finally { rmSync(subset, { recursive: true, force: true }); }
});

test("application audit verifies hashes written before its migration", async () => {
  const database = "audit_upgrade";
  const upgradeDir = join(directory, database);
  mkdirSync(upgradeDir);
  const migrateAudit = () => migrate({ MIGRATION_DIR: `/migrations/${database}` }, database);
  const user = { tenant_id: "legacy-audit", iss: "https://audit.example.invalid", sub: "manager",
    client_id: "console", role: "junctura_audit_api" };
  const setClaims = `SELECT set_config('request.jwt.claims','${JSON.stringify(user)}',false)`;
  const verify = async () => {
    const output = await sql(`SET ROLE junctura_audit_api; ${setClaims}; SELECT core.audit_verify('{}')->'value';`, database);
    return JSON.parse(output.split("\n").at(-1));
  };
  try {
    await sql(`CREATE DATABASE ${database} OWNER junctura_data`);
    for (const file of migrations.filter(entry => Number(entry.slice(0, 3)) <= 41)) {
      cpSync(join(directory, file), join(upgradeDir, file));
    }
    await migrateAudit();
    await sql(`INSERT INTO app_private.principals(tenant_id,issuer,subject,management_client,permissions)
      VALUES('legacy-audit','https://audit.example.invalid','manager','console',ARRAY['audit.read']);
      SET ROLE junctura_app_owner; ${setClaims};
      SELECT app_private.audit_append('audit.legacy_fixture','audit','${randomUUID()}',1);`, database);
    const before = await verify();
    assert.equal(before.verified, true);
    assert.equal(before.entries, 1);
    cpSync(join(directory, "042-application-audit.sql"), join(upgradeDir, "042-application-audit.sql"));
    await migrateAudit();
    const after = await verify();
    assert.deepEqual([after.verified, after.entries, after.newlySealed, after.headHash],
      [true, 1, 0, before.headHash]);
  } finally {
    await sql(`DROP DATABASE IF EXISTS ${database}`);
    rmSync(upgradeDir, { recursive: true, force: true });
  }
});

test("workflow notification observations deduplicate across Core replicas and require a current matching group", async () => {
  const tenant = `events-${randomUUID()}`;
  const task = { taskId: "example-task", executionId: "example-run", definitionId: "review:1:example",
    stepKey: "review", createdAt: new Date().toISOString() };
  await sql(`INSERT INTO app_private.directory_unit_types(tenant_id,unit_type,name,generation,synced_generation)
      VALUES('${tenant}','office','Office',1,1);
    INSERT INTO app_private.directory_units(tenant_id,unit,unit_type,name,generation,synced_generation)
      VALUES('${tenant}','unit-a','office','Office',1,1);
    INSERT INTO app_private.directory_groups(tenant_id,unit,unit_group,name,generation,synced_generation)
      VALUES('${tenant}','unit-a','readers','Readers',1,1);
    INSERT INTO app_private.workflow_executions(tenant_id,caller_scope,request_key,digest,definition_id,
      definition_key,steps,execution_id,start_result)
      VALUES('${tenant}',sha256(''::bytea),'${randomUUID()}',sha256(''::bytea),'${task.definitionId}',
        'review','{"review":{"unit":"unit-a","groups":["readers"]}}','${task.executionId}','{}');`);
  const rpc = async (role, query, groups = []) => {
    const claims = JSON.stringify({ role, tenant_id: tenant, groups });
    const output = await sql(`SET ROLE ${role}; SELECT set_config('request.jwt.claims','${claims}',false); SELECT ${query};`);
    return JSON.parse(output.split("\n").at(-1));
  };
  const observe = () => rpc("junctura_event_observer", `core.event_observe_tasks('${JSON.stringify([task])}')`);
  await Promise.all([observe(), observe()]);
  const page = await rpc("junctura_event_api", "core.event_stream_command('poll','{\"after\":\"0\"}')");
  assert.equal(page.value.overflow, false);
  assert.deepEqual(page.value.items, [{ sequence: "1", event: "workflow.task.created", task }]);
  const deliver = groups => rpc("junctura_event_api", "core.event_stream_command('deliver','{\"sequence\":\"1\"}')", groups);
  assert.deepEqual((await deliver(["/unit-a/readers"])).value, { taskId: task.taskId, executionId: task.executionId });
  assert.equal((await deliver(["/unit-b/readers"])).value, null);
  await sql(`UPDATE app_private.directory_groups SET pending_delete=true WHERE tenant_id='${tenant}';`);
  assert.equal((await deliver(["/unit-a/readers"])).value, null);
  await assert.rejects(rpc("junctura_event_api", "core.event_observe_tasks('[]')"), /permission denied/);
});
