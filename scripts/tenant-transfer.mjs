// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Read-only isolated tenant transfer rehearsal and plan.
//   npm run tenant:transfer-rehearse -- --from <old-id> --to <new-id> --name "New name" \
//     --project <jx-project> [--report report.json]
//
// This tool never mutates tenant data, never renames source audit rows and
// never performs a cutover. On an isolated `jx-` rehearsal stack it summarizes
// the read-only preflight (Core/Postgres and Flowable inventory, Keycloak
// tenant group counts, destination-namespace conflicts), re-verifies the
// sealed source audit chain, records loopback-only gateway health/readiness
// and classifies every store. The plan is a draft that carries classification
// and evidence only — no SQL is generated or executed — and it is not
// executed by this tool; staging/cutover remain open gates.
//
// Store statuses: "ready" (preconditions and read-only evidence collected;
// transfer NOT executed), "blocked" (this tool refuses; explicit reason),
// "unavailable" (nothing present or not configured in this fixture) and
// "failed" (evidence collection failed). "complete" is always false here: a
// plan is not a transfer, an empty fixture is not a transfer, and unexecuted
// steps are never claimed. OpenBao and Keycloak login evidence stay blocked
// until a guarded isolated test exists: this planner performs no token
// exchange and probes no secret values or digests, so no secret material can
// reach the report.
//
// The configured Compose project is taken from this checkout's .env only and
// passed explicitly to every Docker invocation; session COMPOSE_* and
// DOCKER_HOST/DOCKER_CONTEXT overrides are stripped, so the environment cannot
// point the tool at another running stack or another Docker daemon. Local
// health/readiness probes only the loopback gateway with redirects refused;
// PUBLIC_URL is recorded as configuration metadata and is never contacted and
// never used to send credentials.
// Exit codes: 0 preconditions verified and the reviewed plan was written;
// 2 preflight refusal, blocked store (OpenBao and Keycloak binding/login
// evidence are always blocked in this mode) or failed evidence; 1 usage/guard
// error.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs as utilParseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { auditChainSql, collectPreflight, psql as readOnlyPsql, tenantPattern, dockerEnv } from "./tenant-preflight.mjs";

export const projectPattern = /^jx-[a-z0-9](?:[a-z0-9-]{0,62})$/;
const tablePattern = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const usage = "Usage: npm run tenant:transfer-rehearse -- --from <old-id> --to <new-id> --name \"New name\" --project <jx-project> [--report report.json]";
const q = value => `'${String(value).replaceAll("'", "''")}'`;

// Sealed source audit rows must never be re-identified. The other two tables
// carry guards or in-flight state that forbids reassignment by any tool.
export const PRESERVED_TABLES = ["app_private.audit", "app_private.audit_chain_heads"];
export const REFUSED_TABLES = {
  "app_private.subject_bindings": "subject bindings require operator reconciliation to reassign",
  "app_private.object_upload_staging": "in-flight object staging must be drained before a transfer",
};

export function parseArgs(argv) {
  let values;
  try {
    ({ values } = utilParseArgs({ allowPositionals: false, args: argv, options: {
      from: { type: "string" }, to: { type: "string" }, name: { type: "string" },
      project: { type: "string" }, report: { type: "string" },
    } }));
  } catch { throw new Error(usage); }
  if (!tenantPattern.test(values.from ?? "") || !tenantPattern.test(values.to ?? "") ||
      values.from === values.to || !values.name || values.name.trim().length > 120 ||
      /[\u0000-\u001f\u007f]/u.test(values.name) || !projectPattern.test(values.project ?? "") ||
      values.report !== undefined && (!values.report || values.report.startsWith("--"))) {
    throw new Error(usage);
  }
  return { from: values.from, to: values.to, name: values.name.trim(), project: values.project,
    report: values.report };
}

// The project is read from this checkout's .env only. Passing another project
// through the environment or arguments is rejected, so the tool cannot be
// pointed at an arbitrary running stack by session environment alone.
export function resolveProject({ envFile, project }) {
  const configured = envFile.COMPOSE_PROJECT_NAME?.trim();
  if (!configured) throw new Error("No Compose project is configured: run npm run setup in this isolated checkout (COMPOSE_PROJECT_NAME missing)");
  if (configured === "junctura") throw new Error(`Refusing: "${configured}" is the default Compose project, not an isolated rehearsal project`);
  if (!projectPattern.test(configured)) throw new Error(`Refusing: configured Compose project "${configured}" is not an isolated jx- rehearsal project`);
  if (configured !== project) throw new Error(`Refusing: configured Compose project "${configured}" does not match --project ${project}`);
  return configured;
}

// Local health/readiness probes the loopback gateway only, regardless of the
// configured PUBLIC_URL: this base is used for every local connection and
// credentials are never sent anywhere else.
export function loopbackBase(envFile) {
  const port = String(envFile.PORT ?? "8080");
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error(`Invalid local gateway port in .env: ${port}`);
  }
  return `http://127.0.0.1:${Number(port)}`;
}

function readEnvFile() {
  try {
    return Object.fromEntries(readFileSync(".env", "utf8").split("\n")
      .filter(line => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line))
      .map(line => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)]; }));
  } catch { return {}; }
}

// Classify the inventoried tables. Everything not preserved or refused is
// transferable by the draft plan; empty tables are not part of the plan.
export function classifyTables(inventory) {
  const transferable = [], preserved = [], refused = [];
  for (const item of inventory) {
    if (!tablePattern.test(item.table)) throw new Error(`Unexpected table identifier from the catalog: ${item.table}`);
    if (item.sourceRows === 0) continue;
    if (PRESERVED_TABLES.includes(item.table)) preserved.push(item);
    else if (REFUSED_TABLES[item.table]) refused.push({ ...item, reason: REFUSED_TABLES[item.table] });
    else transferable.push(item);
  }
  return { transferable, preserved, refused };
}

// Read-only classification of the inventoried stores. This tool never executes
// a transfer, so it generates no SQL: authoring and staging the executable
// transaction stays a separately reviewed sandbox gate (reported in gates).
export function classifyData(inventory) {
  const { transferable, preserved, refused } = classifyTables(inventory);
  const occupied = transferable.filter(item => item.targetRows > 0).map(item => item.table);
  return { ok: refused.length === 0 && occupied.length === 0, tables: transferable.map(item => item.table),
    preserved: preserved.map(item => item.table), refused, occupied,
    rows: transferable.reduce((sum, item) => sum + item.sourceRows, 0) };
}

export function classifyWorkflow(inventory) {
  const tables = inventory.filter(item => item.sourceRows > 0).map(item => item.table);
  const occupied = inventory.filter(item => item.sourceRows > 0 && item.targetRows > 0).map(item => item.table);
  return { ok: occupied.length === 0, tables, occupied };
}

export function summarize(stores) {
  const entries = Object.entries(stores);
  return {
    ready: entries.filter(([, store]) => store.status === "ready").map(([name]) => name),
    blocked: entries.filter(([, store]) => store.status === "blocked").map(([name]) => name),
    unavailable: entries.filter(([, store]) => store.status === "unavailable").map(([name]) => name),
    failed: entries.filter(([, store]) => store.status === "failed").map(([name]) => name),
  };
}

// Read-only object digest evidence, executed inside the Core container. The
// bytes are only read and hashed; nothing is written, moved or deleted.
const OBJECT_DIGEST_SCRIPT = `
import { createHash } from "node:crypto";
const jobs = JSON.parse(process.argv[1]);
const results = [];
for (const job of jobs) {
  const path = process.env.OBJECTS_URL + "/junctura-app/" + job.tenant + "/" + job.appId + "/" + job.id + "/" + job.version;
  const response = await fetch(path, { redirect: "error", signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error("object read failed (" + response.status + ")");
  const bytes = Buffer.from(await response.arrayBuffer());
  results.push({ ...job, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
}
console.log(JSON.stringify(results));
`;

// Every Docker invocation strips session COMPOSE_*/DOCKER_HOST/DOCKER_CONTEXT
// overrides and passes the guarded project explicitly, so a session
// environment can never select another running stack or daemon.
function coreNode(project, script, argv) {
  const stdout = execFileSync("docker",
    ["compose", "-p", project, "exec", "-T", "core", "node", "--input-type=module", "-e", script, ...argv],
    { env: dockerEnv(), encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 120000 });
  return JSON.parse(stdout.trim().split("\n").at(-1));
}

const step = message => console.log(`• ${message}`);

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const envFile = readEnvFile();
  const project = resolveProject({ envFile, project: options.project });
  const base = loopbackBase(envFile);
  const stores = {};
  const warnings = [];
  const report = { mode: "read-only-rehearsal-plan", from: options.from, to: options.to,
    name: options.name, project, publicUrl: base, execution: "not-executed",
    complete: false, stores, warnings };
  if (envFile.PUBLIC_URL && envFile.PUBLIC_URL !== base) {
    warnings.push(`Local probes use the loopback gateway ${base} only; the configured PUBLIC_URL is informational and is never contacted with credentials`);
  }
  if (Object.keys(process.env).some(key => /^COMPOSE_/i.test(key) || key === "DOCKER_HOST" || key === "DOCKER_CONTEXT")) {
    warnings.push("Session COMPOSE_*/DOCKER_HOST/DOCKER_CONTEXT overrides are ignored; Docker invocations use this checkout's .env and the explicit project");
  }

  step(`Preflight ${options.from} -> ${options.to}`);
  try {
    const preflight = collectPreflight(options, project);
    if (preflight.conflicts.length) throw new Error(`Preflight conflicts: ${preflight.conflicts.join("; ")}`);
    report.preflight = preflight;

    const dataClassification = classifyData(preflight.core);
    const workflowClassification = classifyWorkflow(preflight.flowable);
    report.dataPlan = { draft: true, tables: dataClassification.tables,
      preserved: dataClassification.preserved, rows: dataClassification.rows };
    report.workflowPlan = { draft: true, tables: workflowClassification.tables };

    step("Sealed audit chain evidence");
    const readonlyValue = stmt => readOnlyPsql("junctura_data", stmt, project).trim().split("\n").at(-1);
    const auditFingerprintSql = tenant => `SELECT f.entry_count || ':' || coalesce(encode(f.digest,'hex'),'')
      FROM (SELECT sha256(convert_to(coalesce(string_agg(event_id || ':' || coalesce(entry_hash, '-'), E'\\n'
        ORDER BY chain_seq NULLS FIRST, occurred_at, event_id), ''), 'UTF8')) AS digest, count(*) AS entry_count
        FROM app_private.audit WHERE tenant_id = ${q(tenant)}) f;`;
    const auditFingerprint = readonlyValue(auditFingerprintSql(options.from));
    const chainCheck = readonlyValue(auditChainSql(options.from));
    const chainIntact = chainCheck.endsWith("ok");
    stores.audit = { status: "ready", preservedTables: dataClassification.preserved, fingerprint: auditFingerprint,
      chainIntact, note: "source audit rows are never renamed; a transferred tenant starts a fresh chain under the destination identifier" };
    if (!chainIntact) stores.audit = { ...stores.audit, status: "failed", reason: chainCheck };

    step("Core/Postgres classification");
    const archivedRows = Number(readonlyValue(`SELECT count(*) FROM core.app_records WHERE tenant_id=${q(options.from)} AND archived_at IS NOT NULL;`));
    const guardInteraction = archivedRows > 0
      ? `record_guard_archived forbids UPDATE of ${archivedRows} archived record(s); tenant reassignment needs a reviewed sandbox approach`
      : null;
    if (!dataClassification.ok) {
      stores.postgresCore = { status: "blocked", refusals: dataClassification.refused.map(item =>
        ({ table: item.table, rows: item.sourceRows, reason: item.reason })),
        occupiedDestination: dataClassification.occupied, guardInteraction };
    } else if (!dataClassification.rows) {
      stores.postgresCore = { status: "unavailable", reason: "no transferable Core/Postgres rows in the source fixture" };
    } else {
      stores.postgresCore = { status: "ready", tables: dataClassification.tables, rows: dataClassification.rows, guardInteraction,
        note: "preconditions and evidence collected; the transfer is not executed by this tool" };
    }
    if (workflowClassification.ok && workflowClassification.tables.length) {
      stores.flowable = { status: "ready", tables: workflowClassification.tables,
        rows: preflight.flowable.reduce((sum, item) => sum + item.sourceRows, 0) };
    } else if (!workflowClassification.ok) stores.flowable = { status: "blocked", occupiedDestination: workflowClassification.occupied };
    else stores.flowable = { status: "unavailable", reason: "no Flowable rows for the source tenant" };

    step("Object digest evidence (read-only)");
    const objectRows = JSON.parse(readonlyValue(`SELECT coalesce(json_agg(row_to_json(o)), '[]'::json)
      FROM (SELECT owner_app_id AS "appId", id::text, version::text FROM app_private.resource_objects
        WHERE tenant_id=${q(options.from)} AND NOT deleted) o;`));
    if (objectRows.length) {
      const objects = coreNode(project, OBJECT_DIGEST_SCRIPT, [JSON.stringify(objectRows.map(row => ({ ...row, tenant: options.from })))]);
      stores.objects = { status: "ready", objects: objects.length, digests: objects.map(item => item.sha256),
        note: "object byte digests recorded; staging new copies in a verified sandbox is the next work item, source bytes are never moved by this tool" };
    } else stores.objects = { status: "unavailable", reason: "no published object rows in the source fixture" };

    stores.openbao = { status: "blocked",
      reason: "OpenBao secret evidence requires a guarded isolated test; this planner performs no token exchange and probes no secret values or digests, a KV move would not preserve per-secret version history, and the whole-platform snapshot (scripts/backup.mjs) does not cover OpenBao storage, so secret rewrites are not rollback-safe today" };

    const searchConfigured = Boolean(envFile.MEILI_MASTER_KEY);
    stores.search = searchConfigured
      ? { status: "blocked", reason: "the per-tenant index is rebuilt by the search worker for the destination tenant; synchronous verification does not exist" }
      : { status: "unavailable", reason: "Meilisearch is not configured on this stack" };
    if (envFile.WORKFLOW_TENANTS?.split(",").includes(options.to) === false) {
      warnings.push(`WORKFLOW_TENANTS does not include the destination tenant "${options.to}"; future workflow deployments would be refused`);
    }

    stores.keycloak = { status: "blocked",
      reason: "Keycloak binding and login evidence require a guarded isolated test; this planner performs no token exchange and sends no operator credentials (tenant group counts above are read-only SQL against the identity database)" };

    step("Loopback gateway health/readiness (read-only)");
    const health = await fetch(`${base}/health`, { redirect: "error", signal: AbortSignal.timeout(5000) });
    const ready = await fetch(`${base}/ready`, { redirect: "error", signal: AbortSignal.timeout(15000) });
    stores.readiness = { status: health.ok && ready.ok ? "ready" : "failed",
      gatewayHealth: health.ok, readiness: ready.ok ? (await ready.json()).status : "unready",
      base, note: "loopback-only probes with redirects refused; PUBLIC_URL is not contacted and no credentials are sent" };
  } catch (error) {
    report.error = error.message;
    process.exitCode = 2;
  } finally {
    report.summary = summarize(stores);
    report.gates = [
      "Stage the transfer inside a verified fresh sandbox (new project, restored snapshot) with explicit rollback for every staged write.",
      "Collect OpenBao and Keycloak binding/login evidence in a guarded isolated test; this planner exchanges no tokens and exposes no secret values or digests.",
      "Prove the guard interactions on archived records and subject bindings in the sandbox before any executable plan is approved.",
      "Verify Keycloak member attribute and client mapper updates and the transferred identity end to end in the sandbox.",
      "Confirm search reindex behavior for the destination tenant.",
      "Take and verify a restore point with scripts/backup.mjs in a guarded isolated workflow before any staged write; the platform snapshot does not cover OpenBao storage.",
      "Rehearse the coordinated rollback (restore into a fresh sandbox) and re-verify every store.",
      "Owner approval and integrated reviewed code before any final tag; no production cutover is authorized by this tool.",
    ];
    report.complete = false;
    report.incompleteReason = report.error
      ? "evidence collection failed or preflight refused; no transfer was executed and nothing is claimed"
      : "plan-only rehearsal: no transfer was executed, OpenBao and Keycloak binding/login evidence stay blocked until a guarded isolated test exists, and blocked/unavailable stores are listed explicitly";
    if (options.report) {
      writeFileSync(resolve(options.report), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
      console.log(`Report: ${resolve(options.report)}`);
    } else console.log(JSON.stringify(report, null, 2));
    if (!report.error && (report.summary.failed.length ||
        Object.values(stores).some(store => store.status === "blocked"))) process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch(error => { console.error(`✖ ${error.message}`); process.exitCode = 1; });
}
