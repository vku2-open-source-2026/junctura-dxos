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
    // A legacy consent row keyed by the login subject and one nobody can reach.
    await sql(`INSERT INTO app_private.applications
      (tenant_id,app_id,issuer,oauth_client_id,owner_subject,provider_origin,display_name,digest,state)
      VALUES('tenant-a','${appId}','https://fixture.invalid','fixture','subject','https://fixture.invalid',
        'Consent fixture','sha256:${"0".repeat(64)}','active');
      INSERT INTO execution_private.subject_consents(tenant_id,issuer,data_subject,consumer_app_id,capability_id,purposes,expires_at)
        VALUES('tenant-a','https://fixture.invalid','legacy-person','${appId}',
          'urn:junctura:capability:${appId}:lookup',ARRAY['service_review']::text[],now()+interval '2 hours'),
          ('tenant-a','https://fixture.invalid','unmapped-foreign-subject','${appId}',
          'urn:junctura:capability:${appId}:lookup',ARRAY['service_review']::text[],now()+interval '2 hours');`, database);
    for (const migration of migrations.filter(file => Number(file.slice(0, 3)) > 35)) {
      cpSync(join(directory, migration), join(upgradeDir, migration));
    }
    await migrate({ MIGRATION_DIR: "/migrations/consent-upgrade" }, database);
    // The operator binds legacy-person to a verified subjectId after 036.
    await sql(`INSERT INTO app_private.subject_bindings(tenant_id,issuer,subject_id,login_subject)
      VALUES('tenant-a','https://fixture.invalid','verified-1','legacy-person');`, database);
    // The one-way backfill moved the mapped row to the canonical key and left
    // the unmapped one quarantined; only the mapped row grants authority.
    const state = await sql(`SELECT to_jsonb(u) FROM (
      SELECT (SELECT count(*) FROM execution_private.subject_consents WHERE canonical_subject='verified-1') AS mapped,
             (SELECT count(*) FROM execution_private.subject_consents WHERE canonical_subject IS NULL
               AND data_subject='unmapped-foreign-subject') AS quarantined,
             (SELECT execution_private.canonical_subject('tenant-a','https://fixture.invalid','legacy-person')) AS canonical,
             (SELECT execution_private.canonical_subject('tenant-a','https://fixture.invalid','unmapped-foreign-subject')) AS foreign_canonical) u;`, database);
    assert.deepEqual(JSON.parse(state), { mapped: 1, quarantined: 1,
      canonical: "verified-1", foreign_canonical: null });
    // Binding rows cannot collide: a subjectId that names an existing login is refused.
    let collision = "";
    try {
      await sql(`INSERT INTO app_private.subject_bindings(tenant_id,issuer,subject_id,login_subject)
        VALUES('tenant-a','https://fixture.invalid','legacy-person','another-login');`, database);
    } catch { collision = "refused"; }
    assert.equal(collision, "refused", "subject ids and login subjects never share an identifier");
  } finally {
    await sql(`DROP DATABASE ${database}`);
    rmSync(upgradeDir, { recursive: true, force: true });
  }
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
