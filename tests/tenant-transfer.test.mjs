// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  PRESERVED_TABLES, REFUSED_TABLES, classifyData, classifyWorkflow,
  classifyTables, loopbackBase, parseArgs, projectPattern, resolveProject, summarize,
} from "../scripts/tenant-transfer.mjs";
import { auditChainSql, dockerEnv } from "../scripts/tenant-preflight.mjs";

const good = ["--from", "old-tenant", "--to", "new-tenant", "--name", "New tenant", "--project", "jx-transfer-1"];

test("transfer rehearsal arguments require explicit ids, name, project and flags", () => {
  assert.deepEqual(parseArgs(good), { from: "old-tenant", to: "new-tenant", name: "New tenant",
    project: "jx-transfer-1", report: undefined });
  for (const argv of [
    [], ["--from", "old-tenant", "--to", "new-tenant", "--name", "New tenant"],
    ["--from", "old-tenant", "--to", "old-tenant", "--name", "New tenant", "--project", "jx-transfer-1"],
    ["--from", "Bad_Id", "--to", "new-tenant", "--name", "New tenant", "--project", "jx-transfer-1"],
    ["--from", "old-tenant", "--to", "new-tenant", "--name", "bad\nname", "--project", "jx-transfer-1"],
    ["--from", "old-tenant", "--to", "new-tenant", "--name", "New tenant", "--project", "junctura"],
    ["--from", "old-tenant", "--to", "new-tenant", "--name", "New tenant", "--project", "jx-transfer-1", "--report", "--snapshot"],
    ["positional", ...good],
    [...good, "--snapshot"],
  ]) assert.throws(() => parseArgs(argv), /Usage|Unknown option/);
  assert.equal(projectPattern.test("jx-transfer-1"), true);
  assert.equal(projectPattern.test("junctura"), false);
});

test("the project guard only accepts the checkout's isolated jx- project", () => {
  assert.equal(resolveProject({ envFile: { COMPOSE_PROJECT_NAME: "jx-transfer-1" }, project: "jx-transfer-1" }), "jx-transfer-1");
  assert.throws(() => resolveProject({ envFile: {}, project: "jx-transfer-1" }), /No Compose project/);
  assert.throws(() => resolveProject({ envFile: { COMPOSE_PROJECT_NAME: "junctura" }, project: "jx-transfer-1" }), /default Compose project/);
  assert.throws(() => resolveProject({ envFile: { COMPOSE_PROJECT_NAME: "junctura-prod" }, project: "jx-transfer-1" }), /not an isolated/);
  assert.throws(() => resolveProject({ envFile: { COMPOSE_PROJECT_NAME: "jx-other" }, project: "jx-transfer-1" }), /does not match/);
});

test("classification preserves the sealed audit chain and refuses guarded tables", () => {
  const inventory = [
    { table: "app_private.audit", sourceRows: 3, targetRows: 0 },
    { table: "app_private.audit_chain_heads", sourceRows: 1, targetRows: 0 },
    { table: "app_private.subject_bindings", sourceRows: 2, targetRows: 0 },
    { table: "app_private.object_upload_staging", sourceRows: 1, targetRows: 0 },
    { table: "core.app_records", sourceRows: 4, targetRows: 0 },
    { table: "trust_private.grants", sourceRows: 0, targetRows: 0 },
  ];
  const { transferable, preserved, refused } = classifyTables(inventory);
  assert.deepEqual(transferable.map(item => item.table), ["core.app_records"]);
  assert.deepEqual(preserved.map(item => item.table), PRESERVED_TABLES);
  assert.deepEqual(refused.map(item => item.table), Object.keys(REFUSED_TABLES));
  assert.throws(() => classifyTables([{ table: "evil; drop table", sourceRows: 1, targetRows: 0 }]), /Unexpected table/);
});

test("the read-only data classification never re-identifies preserved or refused rows and embeds no SQL", () => {
  const inventory = [
    { table: "app_private.audit", sourceRows: 3, targetRows: 0 },
    { table: "app_private.subject_bindings", sourceRows: 2, targetRows: 0 },
    { table: "core.app_records", sourceRows: 4, targetRows: 0 },
  ];
  const classification = classifyData(inventory);
  assert.equal(classification.ok, false);
  assert.deepEqual(classification.tables, ["core.app_records"]);
  assert.deepEqual(classification.preserved, ["app_private.audit"]);
  assert.deepEqual(classification.refused.map(item => item.table), ["app_private.subject_bindings"]);
  assert.equal(classification.rows, 4);
  assert.doesNotMatch(JSON.stringify(classification), /UPDATE|INSERT|DELETE|ALTER|BEGIN|COMMIT/);
  const clean = classifyData([{ table: "core.app_records", sourceRows: 4, targetRows: 0 }]);
  assert.equal(clean.ok, true);
  assert.equal(clean.refused.length, 0);
  const occupied = classifyData([{ table: "core.app_records", sourceRows: 4, targetRows: 2 }]);
  assert.equal(occupied.ok, false);
  assert.deepEqual(occupied.occupied, ["core.app_records"]);
  const empty = classifyData([]);
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.tables, []);
  assert.equal(empty.rows, 0);
});

test("the workflow classification only counts populated Flowable tables, refuses collisions and embeds no SQL", () => {
  const classification = classifyWorkflow([
    { table: "act_ru_task", sourceRows: 2, targetRows: 0 },
    { table: "act_re_procdef", sourceRows: 0, targetRows: 1 },
  ]);
  assert.equal(classification.ok, true);
  assert.deepEqual(classification.tables, ["act_ru_task"]);
  assert.doesNotMatch(JSON.stringify(classification), /UPDATE|INSERT|DELETE|ALTER|BEGIN|COMMIT/);
  const occupied = classifyWorkflow([{ table: "act_ru_task", sourceRows: 2, targetRows: 1 }]);
  assert.equal(occupied.ok, false);
  assert.deepEqual(occupied.occupied, ["act_ru_task"]);
});

test("the audit chain check is read-only and tenant-scoped", () => {
  const sql = auditChainSql("old-tenant");
  assert.match(sql, /tenant_id = 'old-tenant'/);
  assert.match(sql, /FROM app_private\.audit a\n\s*WHERE a\.tenant_id = 'old-tenant' AND a\.chain_seq IS NOT NULL ORDER BY a\.chain_seq/);
  assert.match(sql, /SELECT a AS entry, a\.chain_seq, a\.prev_hash, a\.entry_hash AS stored, a\.event_id/);
  assert.match(sql, /app_private\.audit_entry_hash\(r\.entry, r\.chain_seq, r\.prev_hash\)/);
  assert.match(sql, /SELECT 'audit-chain-ok';/);
  assert.doesNotMatch(sql, /UPDATE|INSERT|DELETE|ALTER/);
});

test("docker invocations ignore session Compose and Docker overrides", () => {
  const env = dockerEnv({ PATH: "/bin", HOME: "/root", COMPOSE_PROJECT_NAME: "junctura",
    COMPOSE_FILE: "/tmp/evil.yaml", COMPOSE_PROFILES: "console", DOCKER_HOST: "tcp://evil:2375",
    DOCKER_CONTEXT: "evil" });
  assert.equal(env.COMPOSE_PROJECT_NAME, undefined);
  assert.equal(env.COMPOSE_FILE, undefined);
  assert.equal(env.COMPOSE_PROFILES, undefined);
  assert.equal(env.DOCKER_HOST, undefined);
  assert.equal(env.DOCKER_CONTEXT, undefined);
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/root");
});

test("local readiness probes only the loopback gateway, never PUBLIC_URL", () => {
  assert.equal(loopbackBase({ PORT: "18080" }), "http://127.0.0.1:18080");
  assert.equal(loopbackBase({}), "http://127.0.0.1:8080");
  for (const port of ["8 080", "99999", "0x50", "", "08080x"]) {
    assert.throws(() => loopbackBase({ PORT: port }), /Invalid local gateway port/);
  }
});

test("the planner exchanges no tokens and probes no secret values or digests", () => {
  const source = readFileSync(new URL("../scripts/tenant-transfer.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /keycloakOperatorToken|SECRETS_DIGEST_SCRIPT|operatorLogin|secretsMount|"--snapshot"|options\.snapshot/);
  assert.doesNotMatch(source, /backup, sha256, verifyManifest/);
  assert.match(source, /redirect: "error"/);
  assert.match(source, /dockerEnv\(\)/);
  assert.match(source, /"-p", project/);
});

test("summaries never fold blocked, unavailable or failed stores into success", () => {
  assert.deepEqual(summarize({ a: { status: "ready" }, b: { status: "ready" } }),
    { ready: ["a", "b"], blocked: [], unavailable: [], failed: [] });
  assert.deepEqual(summarize({ a: { status: "ready" }, b: { status: "blocked" },
    c: { status: "unavailable" }, d: { status: "failed" } }),
    { ready: ["a"], blocked: ["b"], unavailable: ["c"], failed: ["d"] });
  assert.deepEqual(summarize({}), { ready: [], blocked: [], unavailable: [], failed: [] });
});

test("no store status vocabulary can be confused with an executed transfer", () => {
  for (const status of ["ready", "blocked", "unavailable", "failed"]) {
    assert.ok(!["verified", "transferred", "complete", "pass"].includes(status));
  }
});