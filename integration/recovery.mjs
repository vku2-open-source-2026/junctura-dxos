// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { test } from "node:test";
import { promisify } from "node:util";

async function docker(args, options = {}) {
  try { return await promisify(execFile)("docker", args, { timeout: 60000, ...options }); }
  catch { throw new Error(`Docker ${args[0]} failed during isolated recovery verification`); }
}

function closeCode(child) {
  return new Promise((resolve, reject) => {
    child.once("error", () => reject(new Error("Could not start backup/restore process")));
    child.once("close", resolve);
  });
}

test("pg_dump/pg_restore preserves real data and tenant RLS in an isolated temporary PostgreSQL", { timeout: 120000 }, async () => {
  const model = JSON.parse((await docker(["compose", "config", "--format", "json"])).stdout);
  const image = model.services.database.image;
  assert.match(image, /^postgres:17-bookworm@sha256:/);
  const id = randomUUID();
  const otherApp = randomUUID();
  const sourceSql = (sql) => docker(["compose", "exec", "-T", "database", "psql", "-U", "junctura_admin", "-d", "junctura_data", "-v", "ON_ERROR_STOP=1", "-Atc", sql]);
  const sourceClaim = "SET ROLE junctura_api; SELECT set_config('request.jwt.claims','{\"tenant_id\":\"tenant-a\"}',false);";
  let target;
  let seeded = false;
  let applicationSeeded = false;
  let bindingSeeded = false;
  try {
    await sourceSql(`${sourceClaim} INSERT INTO core.records(id,collection,data) VALUES ('${id}','recovery_fixture','{"fixture":"backup"}');`);
    seeded = true;
    await sourceSql(`INSERT INTO app_private.applications(tenant_id,app_id,issuer,oauth_client_id,owner_subject,provider_origin,display_name,digest)
      VALUES('tenant-a','${id}','https://recovery.example.invalid','restore-${id}','restore-${id}','https://recovery.example.invalid','Isolated restore fixture','sha256:${"0".repeat(64)}');`);
    applicationSeeded = true;
    await sourceSql(`UPDATE app_private.applications SET state='active' WHERE app_id='${id}';
      INSERT INTO app_private.applications(tenant_id,app_id,issuer,oauth_client_id,owner_subject,provider_origin,display_name,digest,state)
        VALUES('tenant-a','${otherApp}','https://recovery.example.invalid','restore-${otherApp}','restore-${id}','https://recovery.example.invalid','Restore app B','sha256:${"0".repeat(64)}','active');
      INSERT INTO app_private.enrollments(tenant_id,issuer,oauth_client_id,owner_subject,provider_origin,resource_subject)
        VALUES('tenant-a','https://recovery.example.invalid','restore-${id}','restore-${id}','https://recovery.example.invalid','subject-${id}'),
        ('tenant-a','https://recovery.example.invalid','restore-${otherApp}','restore-${id}','https://recovery.example.invalid','subject-${otherApp}');
      INSERT INTO core.app_records(tenant_id,id,owner_app_id,collection,data) VALUES('tenant-a','${id}','${id}','recovery_fixture','{"private":true}');
      INSERT INTO app_private.record_collections(tenant_id,owner_app_id,collection,record_count,searchable_fields)
        VALUES('tenant-a','${id}','recovery_fixture',1,ARRAY['private']::text[]);
      INSERT INTO app_private.principals(tenant_id,issuer,subject,management_client,permissions)
        VALUES('tenant-a','https://recovery.example.invalid','recovery-${id}','restore-${id}',ARRAY['audit.read']::text[]);
      SET ROLE junctura_app_owner;
      SELECT set_config('request.jwt.claims','{"tenant_id":"tenant-a","iss":"https://recovery.example.invalid","sub":"recovery-${id}","client_id":"restore-${id}"}',false);
      INSERT INTO app_private.audit(tenant_id,issuer,subject,management_client,event,resource_id,revision)
        VALUES('tenant-a','https://recovery.example.invalid','recovery-${id}','restore-${id}','application.recovery_fixture','${id}',1);
      RESET ROLE;`);
    const started = await docker(["run", "--detach", "--rm", "--name", `junctura-restore-${randomBytes(6).toString("hex")}`,
      "--network", "none", "--tmpfs", "/var/lib/postgresql/data:rw", "--env", "POSTGRES_USER=junctura_admin",
      "--env", "POSTGRES_PASSWORD", image], { env: { ...process.env, POSTGRES_PASSWORD: randomBytes(32).toString("hex") } });
    target = started.stdout.trim();
    assert.match(target, /^[0-9a-f]{64}$/);
    const deadline = Date.now() + 45000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        await docker(["exec", target, "sh", "-c", 'test "$(cat /proc/1/comm)" = postgres && pg_isready -U junctura_admin -d postgres']);
        ready = true;
        break;
      } catch { await new Promise((resolve) => setTimeout(resolve, 500)); }
    }
    assert.ok(ready, "Isolated PostgreSQL completed initialization");
    await docker(["exec", target, "createdb", "-U", "junctura_admin", "recovered"]);
    await docker(["exec", target, "psql", "-U", "junctura_admin", "-d", "recovered", "-v", "ON_ERROR_STOP=1", "-c", "CREATE ROLE junctura_api NOLOGIN NOBYPASSRLS; CREATE ROLE junctura_app_api NOLOGIN NOBYPASSRLS; CREATE ROLE junctura_app_owner NOLOGIN NOBYPASSRLS; CREATE ROLE junctura_resource_api NOLOGIN NOBYPASSRLS; CREATE ROLE junctura_record_api NOLOGIN NOBYPASSRLS; ALTER ROLE junctura_record_api SET statement_timeout='4s'; CREATE ROLE junctura_audit_api NOLOGIN NOBYPASSRLS; CREATE ROLE junctura_capability_api NOLOGIN NOBYPASSRLS; CREATE ROLE junctura_trust_api NOLOGIN NOBYPASSRLS; CREATE ROLE junctura_execution_api NOLOGIN NOBYPASSRLS; CREATE ROLE junctura_composition_api NOLOGIN NOBYPASSRLS; CREATE ROLE junctura_subject_api NOLOGIN NOBYPASSRLS; CREATE ROLE junctura_directory_api NOLOGIN NOBYPASSRLS; CREATE ROLE junctura_directory_worker NOLOGIN NOBYPASSRLS; CREATE ROLE junctura_storage_api NOLOGIN NOBYPASSRLS; CREATE ROLE junctura_storage_collections_api NOLOGIN NOBYPASSRLS; CREATE ROLE junctura_workflow_audit_api NOLOGIN NOBYPASSRLS; CREATE ROLE junctura_workflow_api NOLOGIN NOBYPASSRLS; CREATE ROLE junctura_workflow_worker NOLOGIN NOBYPASSRLS; CREATE ROLE junctura_application_stats_api NOLOGIN NOBYPASSRLS;" +
      "CREATE ROLE junctura_event_api NOLOGIN NOBYPASSRLS; CREATE ROLE junctura_event_observer NOLOGIN NOBYPASSRLS; " +
      "CREATE ROLE junctura_search_worker NOLOGIN NOBYPASSRLS; CREATE ROLE junctura_objects_worker NOLOGIN NOBYPASSRLS;"]);
    await sourceSql(`INSERT INTO app_private.subject_bindings(tenant_id,issuer,subject_id,login_subject)
      VALUES('tenant-a','https://recovery.example.invalid','subject-${id}','recovery-${id}');`);
    bindingSeeded = true;
    const dump = spawn("docker", ["compose", "exec", "-T", "database", "pg_dump", "-U", "junctura_admin", "--format=custom", "junctura_data"], { stdio: ["ignore", "pipe", "pipe"] });
    const restore = spawn("docker", ["exec", "-i", target, "pg_restore", "-U", "junctura_admin", "--exit-on-error", "--dbname=recovered"], { stdio: ["pipe", "ignore", "pipe"] });
    const dumpCode = closeCode(dump);
    const restoreCode = closeCode(restore);
    dump.stderr.resume();
    restore.stderr.resume();
    await pipeline(dump.stdout, restore.stdin);
    assert.equal(await dumpCode, 0, "Source dump succeeds");
    assert.equal(await restoreCode, 0, "Restore with ownership/ACL/policies succeeds");
    for (const [tenant, expected] of [["tenant-a", "1"], ["tenant-b", "0"]]) {
      const sql = `SET ROLE junctura_api; SELECT set_config('request.jwt.claims','{"tenant_id":"${tenant}"}',false); SELECT count(*) FROM core.records WHERE id='${id}';`;
      const result = await docker(["exec", target, "psql", "-U", "junctura_admin", "-d", "recovered", "-v", "ON_ERROR_STOP=1", "-Atc", sql]);
      assert.equal(result.stdout.trim().split(/\r?\n/).at(-1), expected, `Restored RLS for ${tenant}`);
    }
    for (const [tenant, expected] of [["tenant-a", "1"], ["tenant-b", "0"]]) {
      const claims = `SET ROLE junctura_app_owner; SELECT set_config('request.jwt.claims','{"tenant_id":"${tenant}"}',false);`;
      const result = await docker(["exec", target, "psql", "-U", "junctura_admin", "-d", "recovered", "-v", "ON_ERROR_STOP=1", "-Atc",
        `${claims} SELECT count(*) FROM app_private.applications WHERE app_id='${id}';`]);
      assert.equal(result.stdout.trim().split(/\r?\n/).at(-1), expected, `Restored authority RLS for ${tenant}`);
    }
    const acl = await docker(["exec", target, "psql", "-U", "junctura_admin", "-d", "recovered", "-Atc",
      "SELECT has_schema_privilege('junctura_api','app_private','USAGE'),has_function_privilege('junctura_api','core.application_command(text,jsonb)','EXECUTE'),has_function_privilege('junctura_app_api','core.application_command(text,jsonb)','EXECUTE');"]);
    assert.equal(acl.stdout.trim(), "f|f|t", "Restore preserves isolated authority RPC grants");
    for(const [tenant,appId,expected] of [['tenant-a',id,'1'],['tenant-a',otherApp,'0'],['tenant-b',id,'0']]) {
      const claims=JSON.stringify({tenant_id:tenant,iss:'https://recovery.example.invalid',client_id:`restore-${appId}`,sub:`subject-${appId}`,app_id:id,resource_writer:true});
      const result=await docker(['exec',target,'psql','-U','junctura_admin','-d','recovered','-v','ON_ERROR_STOP=1','-Atc',
        `SET ROLE junctura_resource_api; SELECT set_config('request.jwt.claims','${claims}',false); SELECT count(*) FROM core.app_records WHERE id='${id}';`]);
      assert.equal(result.stdout.trim().split(/\r?\n/).at(-1),expected,`Restored app RLS: ${tenant}/${appId}`);
    }
    const resourceAcl=await docker(['exec',target,'psql','-U','junctura_admin','-d','recovered','-Atc',
      "SELECT has_table_privilege('junctura_api','core.app_records','SELECT'),has_schema_privilege('junctura_resource_api','app_private','USAGE');"]);
    assert.equal(resourceAcl.stdout.trim(),'f|f','Restore preserves resource role separation');
    const recordAcl = await docker(["exec", target, "psql", "-U", "junctura_admin", "-d", "recovered", "-Atc",
      "SELECT has_function_privilege('junctura_record_api','core.record_command(text,jsonb)','EXECUTE'),has_table_privilege('junctura_record_api','core.app_records','SELECT'),has_table_privilege('junctura_record_api','app_private.record_collections','SELECT'),has_column_privilege('junctura_resource_api','core.app_records','data','UPDATE'),has_function_privilege('junctura_resource_api','core.record_command(text,jsonb)','EXECUTE');"]);
    assert.equal(recordAcl.stdout.trim(), "t|f|f|f|f");
    // Verified subject and directory RPCs survive the restore with their
    // dedicated roles, forced RLS and no direct table reach.
    const subjectDirectoryAcl = await docker(["exec", target, "psql", "-U", "junctura_admin", "-d", "recovered", "-Atc",
      `SELECT has_function_privilege('junctura_subject_api','core.subject_binding(jsonb)','EXECUTE'),
        has_function_privilege('junctura_subject_api','core.subject_consent(text,jsonb)','EXECUTE'),
        has_function_privilege('junctura_subject_api','core.subject_access(jsonb)','EXECUTE'),
        has_function_privilege('junctura_directory_api','core.directory_command(text,jsonb)','EXECUTE'),
        has_function_privilege('junctura_directory_worker','core.directory_command(text,jsonb)','EXECUTE'),
        has_table_privilege('junctura_directory_worker','app_private.directory_sync_leases','SELECT'),
        has_table_privilege('junctura_subject_api','app_private.subject_bindings','SELECT'),
        has_table_privilege('junctura_subject_api','execution_private.subject_consents','SELECT'),
        has_table_privilege('junctura_directory_api','app_private.directory_units','SELECT'),
        bool_and(c.relrowsecurity AND c.relforcerowsecurity)
        FROM pg_class c WHERE (c.oid='app_private.subject_bindings'::regclass OR c.oid='app_private.directory_members'::regclass
          OR c.oid='execution_private.subject_consents'::regclass OR c.oid='app_private.directory_sync_leases'::regclass
          OR c.oid='app_private.subject_binding_scopes'::regclass);`]);
    assert.equal(subjectDirectoryAcl.stdout.trim(), "t|t|t|t|t|f|f|f|f|t",
      "Restore preserves subject/directory RPC grants, private ACLs and forced tenant RLS");
    const workflowAcl = await docker(["exec", target, "psql", "-U", "junctura_admin", "-d", "recovered", "-Atc",
      `SELECT has_function_privilege('junctura_workflow_api','core.workflow_execution_command(text,jsonb)','EXECUTE'),
        has_function_privilege('junctura_workflow_api','core.workflow_task_command(text,jsonb)','EXECUTE'),
        has_function_privilege('junctura_workflow_worker','core.workflow_worker_command(text,jsonb)','EXECUTE'),
        has_function_privilege('junctura_workflow_api','core.workflow_worker_command(text,jsonb)','EXECUTE'),
        has_table_privilege('junctura_workflow_api','app_private.workflow_executions','SELECT'),
        has_column_privilege('junctura_workflow_api','app_private.workflow_executions','cancel_lease','UPDATE'),
        has_table_privilege('junctura_workflow_worker','app_private.workflow_completion_outbox','UPDATE'),
        count(*), bool_and(relrowsecurity AND relforcerowsecurity)
        FROM pg_class WHERE oid IN ('app_private.workflow_definition_policies'::regclass,
          'app_private.workflow_executions'::regclass, 'app_private.workflow_task_claims'::regclass,
          'app_private.workflow_completion_outbox'::regclass);`]);
    assert.equal(workflowAcl.stdout.trim(), "t|t|t|f|f|f|f|4|t",
      "Restore preserves workflow RPC grants, private ACLs and forced tenant RLS");
    for (const [tenant, expected] of [["tenant-a", "1"], ["tenant-b", "0"]]) {
      const guarded = await docker(["exec", target, "psql", "-U", "junctura_admin", "-d", "recovered", "-Atc",
        `SET ROLE junctura_app_owner; SELECT set_config('request.jwt.claims','{"tenant_id":"${tenant}"}',false);
          SELECT count(*) FROM app_private.record_collections WHERE owner_app_id='${id}';`]);
      assert.equal(guarded.stdout.trim().split(/\r?\n/).at(-1), expected);
    }
    const recordClaims = JSON.stringify({ tenant_id: "tenant-a", iss: "https://recovery.example.invalid",
      client_id: `restore-${id}`, sub: `subject-${id}` });
    const restoredRecord = await docker(["exec", target, "psql", "-U", "junctura_admin", "-d", "recovered", "-Atc",
      `SET ROLE junctura_record_api; SELECT set_config('request.jwt.claims','${recordClaims}',false);
        SELECT core.record_command('get','{"collection":"recovery_fixture","id":"${id}"}')->'value'->>'version';`]);
    assert.equal(restoredRecord.stdout.trim().split(/\r?\n/).at(-1), "1");
    const auditAcl=await docker(['exec',target,'psql','-U','junctura_admin','-d','recovered','-Atc',
      "SELECT has_function_privilege('junctura_audit_api','core.audit_query(jsonb)','EXECUTE'),has_table_privilege('junctura_audit_api','app_private.audit','INSERT'),has_table_privilege('junctura_app_api','app_private.audit','INSERT');"]);
    assert.equal(auditAcl.stdout.trim(),'t|f|f','Restore preserves audit role separation');
    const eventAcl = await docker(["exec", target, "psql", "-U", "junctura_admin", "-d", "recovered", "-Atc",
      `SELECT has_function_privilege('junctura_event_api','core.event_stream_command(text,jsonb)','EXECUTE'),
        has_function_privilege('junctura_event_observer','core.event_observe_tasks(jsonb)','EXECUTE'),
        has_function_privilege('junctura_event_api','core.event_observe_tasks(jsonb)','EXECUTE'),
        has_table_privilege('junctura_event_api','app_private.event_notifications','SELECT'),
        has_table_privilege('junctura_audit_api','app_private.audit_app_payloads','SELECT'),
        has_function_privilege('junctura_subject_api','core.subject_access_command(text,jsonb)','EXECUTE'),
        has_table_privilege('junctura_subject_api','app_private.subject_access_reports','UPDATE'),
        count(*), bool_and(relrowsecurity AND relforcerowsecurity)
        FROM pg_class WHERE oid IN ('app_private.audit_app_payloads'::regclass,
          'app_private.audit_export_snapshots'::regclass, 'app_private.event_notifications'::regclass,
          'app_private.event_observed_tasks'::regclass, 'app_private.object_quotas'::regclass,
          'app_private.object_upload_staging'::regclass,
          'app_private.search_index_jobs'::regclass, 'app_private.subject_access_reports'::regclass,
          'app_private.emergency_feedback'::regclass);`]);
    assert.equal(eventAcl.stdout.trim(), "t|t|f|f|f|t|f|9|t",
      "Restore preserves private audit, event, quota and search authorities");
    const capabilityAcl=await docker(['exec',target,'psql','-U','junctura_admin','-d','recovered','-Atc',
      "SELECT has_function_privilege('junctura_capability_api','core.capability_command(text,jsonb)','EXECUTE'),has_function_privilege('junctura_capability_api','core.application_command(text,jsonb)','EXECUTE'),has_table_privilege('junctura_capability_api','app_private.capability_versions','SELECT');"]);
    assert.equal(capabilityAcl.stdout.trim(),'t|f|f','Restore preserves capability registry role separation');
    const trustAcl=await docker(['exec',target,'psql','-U','junctura_admin','-d','recovered','-Atc',
      "SELECT n.nspowner::regrole, bool_and(c.relrowsecurity AND c.relforcerowsecurity) FROM pg_namespace n JOIN pg_class c ON c.relnamespace=n.oid WHERE n.nspname='trust_private' AND c.relkind='r' GROUP BY n.nspowner; SELECT has_schema_privilege('junctura_api','trust_private','USAGE'),has_table_privilege('junctura_app_api','trust_private.grants','INSERT');"]);
    assert.equal(trustAcl.stdout.trim(),'junctura_app_owner|t\nf|f','Restore preserves Trust ownership, forced RLS and private ACLs');
    const executionAcl=await docker(['exec',target,'psql','-U','junctura_admin','-d','recovered','-Atc',
      "SELECT n.nspowner::regrole,c.relrowsecurity AND c.relforcerowsecurity FROM pg_namespace n JOIN pg_class c ON c.relnamespace=n.oid WHERE n.nspname='execution_private' AND c.relname='executions'; SELECT has_function_privilege('junctura_execution_api','core.execution_command(text,jsonb)','EXECUTE'),has_function_privilege('junctura_api','core.execution_command(text,jsonb)','EXECUTE'),has_schema_privilege('junctura_execution_api','execution_private','USAGE');"]);
    assert.equal(executionAcl.stdout.trim(),'junctura_app_owner|t\nt|f|f','Restore preserves private execution authority and forced RLS');
    const compositionAcl=await docker(['exec',target,'psql','-U','junctura_admin','-d','recovered','-Atc',
      "SELECT n.nspowner::regrole,count(*),bool_and(c.relrowsecurity AND c.relforcerowsecurity) FROM pg_namespace n JOIN pg_class c ON c.relnamespace=n.oid WHERE n.nspname='composition_private' AND c.relkind='r' GROUP BY n.nspowner; SELECT has_function_privilege('junctura_composition_api','core.composition_execution_command(text,jsonb)','EXECUTE'),has_schema_privilege('junctura_composition_api','composition_private','USAGE'),has_table_privilege('junctura_api','composition_private.executions','SELECT');"]);
    assert.equal(compositionAcl.stdout.trim(),'junctura_app_owner|5|t\nt|f|f','Restore preserves Composition ownership, all forced RLS policies and restricted RPC role');
    const compositions = process.env.COMPOSITION_RECOVERY_CASES ? JSON.parse(process.env.COMPOSITION_RECOVERY_CASES) : [];
    for (const fixture of compositions) {
      assert.match(fixture.execution.execution_id, /^[0-9a-f-]{36}$/);
      for (const tenant of ['tenant-a','tenant-b']) {
        const query = `SET ROLE junctura_app_owner; SELECT set_config('request.jwt.claims','${JSON.stringify({tenant_id:tenant})}',false);
          SELECT coalesce((SELECT jsonb_build_object('execution',to_jsonb(e),'steps',
            (SELECT jsonb_agg(to_jsonb(s) ORDER BY step_index) FROM composition_private.execution_steps s WHERE s.execution_id=e.execution_id),
            'auditCount',(SELECT count(*) FROM app_private.audit WHERE resource_id=e.execution_id))
            FROM composition_private.executions e WHERE execution_id='${fixture.execution.execution_id}'),'null'::jsonb);`;
        const result = await docker(['exec',target,'psql','-U','junctura_admin','-d','recovered','-v','ON_ERROR_STOP=1','-Atc',query]);
        assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)), tenant===fixture.execution.tenant_id ? fixture : null,
          'Restored Composition state, exact steps, ticket hashes, operation IDs, output, audit and tenant RLS');
      }
    }
    if (compositions.length) console.log(`Composition restore: ${compositions.length} durable outcomes, steps, audit and tenant RLS passed`);
    // Only synthetic execution metadata is passed here, never credentials or
    // ticket plaintext. The isolated restore has no network and runs no worker.
    const liveExecutions = process.env.EXECUTION_RECOVERY_CASES ? JSON.parse(process.env.EXECUTION_RECOVERY_CASES) : [];
    for (const fixture of liveExecutions) {
      assert.match(fixture.execution_id, /^[0-9a-f-]{36}$/);
      assert.match(fixture.tenant_id, /^[a-z][a-z0-9-]{0,62}$/);
      const fields = ['execution_id','tenant_id','consumer_app_id','provider_app_id','manifest_digest','input_digest',
        'idempotency_key','operation_id','ticket_hash','state','attempt','engine_process_id','output'];
      assert.deepEqual(Object.keys(fixture).sort(), [...fields].sort());
      for (const tenant of [fixture.tenant_id, 'tenant-b']) {
        const query = `SET ROLE junctura_app_owner; SELECT set_config('request.jwt.claims','${JSON.stringify({tenant_id:tenant})}',false);
          SELECT coalesce((SELECT jsonb_build_object(${fields.map(key => `'${key}',e.${key}`).join(',')})
            FROM execution_private.executions e WHERE execution_id='${fixture.execution_id}'),'null'::jsonb);`;
        const result = await docker(['exec',target,'psql','-U','junctura_admin','-d','recovered','-v','ON_ERROR_STOP=1','-Atc',query]);
        assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)), tenant===fixture.tenant_id ? fixture : null,
          'Restored execution bindings, outcome and forced tenant RLS');
      }
    }
    if (liveExecutions.length) console.log(`Execution restore: ${liveExecutions.length} live outcomes, hashes, correlation and tenant RLS passed`);
    // The capability suite supplies real OIDC-enrolled live grants while its
    // fixtures still exist. This offline restore verifies persisted authority;
    // issuer authentication itself is exercised against Keycloak in that suite.
    const liveTrust = process.env.TRUST_RECOVERY_CASES ? JSON.parse(process.env.TRUST_RECOVERY_CASES) : null;
    if (liveTrust) {
      const literal = value => `'${String(value).replaceAll("'", "''")}'`;
      for (const fixture of liveTrust.cases) {
        for (const tenant of [liveTrust.tenant, 'tenant-b']) {
          const claims = JSON.stringify({tenant_id:tenant,iss:liveTrust.issuer,sub:liveTrust.subject,client_id:liveTrust.clientId,trust_writer:true});
          const result = await docker(['exec',target,'psql','-U','junctura_admin','-d','recovered','-v','ON_ERROR_STOP=1','-Atc',
            `SET ROLE junctura_trust_api; SELECT set_config('request.jwt.claims',${literal(claims)},false); SELECT core.trust_eligibility(${literal(JSON.stringify(fixture.reference))}::jsonb)->>'allowed';`]);
          assert.equal(result.stdout.trim().split(/\r?\n/).at(-1), String(tenant===liveTrust.tenant && fixture.state==='active'), 'Restored live Trust decision');
          const stored = await docker(['exec',target,'psql','-U','junctura_admin','-d','recovered','-v','ON_ERROR_STOP=1','-Atc',
            `SET ROLE junctura_app_owner; SELECT set_config('request.jwt.claims',${literal(claims)},false); SELECT coalesce((SELECT trust_private.grant_view(g)->>'state' FROM trust_private.grants g WHERE grant_id=${literal(fixture.grantId)}::uuid),'hidden');`]);
          assert.equal(stored.stdout.trim().split(/\r?\n/).at(-1), tenant===liveTrust.tenant ? fixture.state : 'hidden', 'Restored grant state and tenant RLS');
        }
      }
      const revoked = liveTrust.cases.find(fixture=>fixture.state==='revoked');
      const evidence = await docker(['exec',target,'psql','-U','junctura_admin','-d','recovered','-Atc',
        `SELECT count(*) FROM app_private.audit WHERE resource_id=${literal(revoked.grantId)}::uuid AND event='grant.revoked'; SELECT has_function_privilege('junctura_trust_api','core.trust_eligibility(jsonb)','EXECUTE'),has_function_privilege('junctura_api','core.trust_eligibility(jsonb)','EXECUTE'),has_table_privilege('junctura_trust_api','trust_private.grants','UPDATE');`]);
      assert.equal(evidence.stdout.trim(),'1\nt|f|f','Restored revocation audit and Trust ACLs');
      console.log(`Trust restore: ${liveTrust.cases.length} live grants, tenant RLS, revocation audit and ACLs passed`);
    }
    for(const [tenant,expected] of [['tenant-a','1'],['tenant-b','0']]) {
      const claims=JSON.stringify({tenant_id:tenant,iss:'https://recovery.example.invalid',sub:`recovery-${id}`,client_id:`restore-${id}`});
      const result=await docker(['exec',target,'psql','-U','junctura_admin','-d','recovered','-v','ON_ERROR_STOP=1','-Atc',
        `SET ROLE junctura_app_owner; SELECT set_config('request.jwt.claims','${claims}',false); SELECT count(*) FROM app_private.audit WHERE resource_id='${id}';`]);
      assert.equal(result.stdout.trim().split(/\r?\n/).at(-1),expected,`Restored audit RLS for ${tenant}`);
    }
    // The restored search index is empty on a fresh Meilisearch instance: the
    // restore runbook flags every tenant generation for a rebuild and the
    // indexer repopulates it from PostgreSQL on the next sweep. A flagged
    // tenant proves its rebuild source: preparing the rebuild enqueues the
    // restored data again instead of starting from an empty index.
    const searchRebuild = await docker(["exec", target, "psql", "-U", "junctura_admin", "-d", "recovered", "-v", "ON_ERROR_STOP=1", "-Atc",
      "UPDATE app_private.search_generations SET rebuild_requested=true; SELECT coalesce(bool_and(rebuild_requested),true) FROM app_private.search_generations;"]);
    assert.equal(searchRebuild.stdout.trim().split(/\r?\n/).at(-1), "t",
      "The restore runbook flags every search generation for a rebuild");
    const rebuildLease = randomUUID();
    const rebuild = await docker(["exec", target, "psql", "-U", "junctura_admin", "-d", "recovered", "-v", "ON_ERROR_STOP=1", "-Atc",
      "SET ROLE junctura_search_worker; SELECT set_config('request.jwt.claims','{\"role\":\"junctura_search_worker\",\"tenant_id\":\"tenant-a\"}',false);" +
      `SELECT core.search_command('acquire','{"lease":"${rebuildLease}"}'::jsonb)->>'status';` +
      `SELECT core.search_command('prepare','{"lease":"${rebuildLease}"}'::jsonb)->'value'->>'building_generation';`]);
    const [acquired, building] = rebuild.stdout.trim().split(/\r?\n/).slice(-2);
    assert.equal(acquired, "200", "the rebuild worker holds the tenant lease");
    const queued = await docker(["exec", target, "psql", "-U", "junctura_admin", "-d", "recovered", "-v", "ON_ERROR_STOP=1", "-Atc",
      "SELECT count(DISTINCT resource_id) FROM app_private.search_index_jobs WHERE tenant_id='tenant-a' AND resource_type='record';"]);
    const rebuildState = { building, records: Number(queued.stdout.trim().split(/\r?\n/).at(-1)) };
    assert.match(rebuildState.building, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      "the flagged rebuild prepares a fresh building generation");
    assert.equal(rebuildState.records, 1, "the restored records are re-enqueued from PostgreSQL");
    // The verified-subject gate still refuses unbound claims and a mapped
    // person reads only their own rows after the restore.
    const bindingClaims=JSON.stringify({tenant_id:'tenant-a',iss:'https://recovery.example.invalid',sub:`recovery-${id}`,subject_id:`subject-${id}`});
    const unboundClaims=JSON.stringify({tenant_id:'tenant-a',iss:'https://recovery.example.invalid',
      sub:`unbound-${id}`,subject_id:`subject-${id}`});
    const gated=await docker(['exec',target,'psql','-U','junctura_admin','-d','recovered','-v','ON_ERROR_STOP=1','-Atc',
      `SET ROLE junctura_subject_api; SELECT set_config('request.jwt.claims','${unboundClaims}',false);
        SELECT core.subject_binding('{}'::jsonb)->>'error';`]);
    assert.equal(gated.stdout.trim().split(/\r?\n/).at(-1),'verified_subject_required',
      'A restored binding gate still refuses an operator-less claim');

    const mapped=await docker(['exec',target,'psql','-U','junctura_admin','-d','recovered','-v','ON_ERROR_STOP=1','-Atc',
      `SET ROLE junctura_subject_api; SELECT set_config('request.jwt.claims','${bindingClaims}',false);
        SELECT core.subject_binding('{}'::jsonb)->'value'->>'subjectId';`]);
    assert.equal(mapped.stdout.trim().split(/\r?\n/).at(-1),`subject-${id}`,
      'A restored binding maps the operator-assigned subjectId to its login');
    const auditClaims=JSON.stringify({tenant_id:'tenant-a',iss:'https://recovery.example.invalid',sub:`recovery-${id}`,client_id:`restore-${id}`});
    const auditQuery=await docker(['exec',target,'psql','-U','junctura_admin','-d','recovered','-v','ON_ERROR_STOP=1','-Atc',
      `SET ROLE junctura_audit_api; SELECT set_config('request.jwt.claims','${auditClaims}',false); SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(core.audit_query('{"limit":100}'::jsonb)->'value'->'items') item WHERE item->>'resourceId'='${id}');`]);
    assert.equal(auditQuery.stdout.trim().split(/\r?\n/).at(-1),'t','Restored protected audit query returns the event');
  } finally {
    if (target && /^[0-9a-f]{64}$/.test(target)) await docker(["stop", target]);
    if (bindingSeeded) await sourceSql(`BEGIN;
      ALTER TABLE app_private.subject_bindings DISABLE TRIGGER subject_binding_guard;
      DELETE FROM app_private.subject_bindings WHERE tenant_id='tenant-a' AND issuer='https://recovery.example.invalid'
        AND login_subject='recovery-${id}' AND subject_id='subject-${id}';
      ALTER TABLE app_private.subject_bindings ENABLE TRIGGER subject_binding_guard;
      COMMIT;`);
    if (applicationSeeded) await sourceSql(`DELETE FROM core.app_records WHERE owner_app_id='${id}' AND collection='recovery_fixture';
      DELETE FROM app_private.audit WHERE tenant_id='tenant-a' AND resource_id='${id}';
      DELETE FROM app_private.principals WHERE tenant_id='tenant-a' AND subject='recovery-${id}' AND management_client='restore-${id}';
      DELETE FROM app_private.enrollments WHERE oauth_client_id IN ('restore-${id}','restore-${otherApp}');
      DELETE FROM app_private.applications WHERE app_id IN ('${id}','${otherApp}') AND owner_subject='restore-${id}';`);
    if (seeded) await sourceSql(`${sourceClaim} DELETE FROM core.records WHERE id='${id}' AND collection='recovery_fixture';`);
  }
});
