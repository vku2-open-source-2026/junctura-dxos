// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseArgs, validateArchive } from "../scripts/app-backup.mjs";

const appId = randomUUID();
const peer = randomUUID();
const historical = randomUUID();
const tenant = "tenant-a";
const queueId = randomUUID();
const messageId = randomUUID();
const queue = { tenant_id: tenant, queue_id: queueId, name: "queue-backup-unit", owner_app_id: appId,
  producer_apps: [peer], consumer_apps: [peer], producer_versions: [], consumer_versions: [], max_attempts: 3 };
const message = { tenant_id: tenant, queue_id: queueId, message_id: messageId, producer_app_id: historical,
  idempotency_key: randomUUID(), request_digest: "\\x00", payload_json: '{"task":"unit"}',
  available_at: new Date().toISOString(), max_attempts: 3, attempts: 0, dead_at: null };
const emptyRows = {
  "app_private.record_collections": [], "core.app_records": [], "app_private.resource_objects": [],
  "app_private.object_quotas": [], "app_private.resource_shares": [], "app_private.record_read_grants": [],
  "app_private.app_audit_actions": [], "app_private.audit_app_units": [], "app_private.audit_app_delegates": [],
  "app_private.message_queues": [], "app_private.queue_messages": [],
};
const legacyRows = Object.fromEntries(Object.entries(emptyRows).slice(0, 9));

let root;
function buildArchive(name, rows, schemaVersion = 74) {
  root ??= mkdtempSync(join(tmpdir(), "app-backup-unit-"));
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  const snapshot = { appId, tenant, schemaVersion, issuer: "https://unit.example.invalid", client: "unit-client",
    owner: "unit-owner", provider: "https://unit.example.invalid", rows };
  const audit = { tenant, appId, entries: [] };
  const files = ["snapshot.json", "audit.json"].map(file => {
    const bytes = JSON.stringify(file === "snapshot.json" ? snapshot : audit);
    writeFileSync(join(directory, file), bytes);
    return { name: file, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  writeFileSync(join(directory, "manifest.json"), JSON.stringify({
    format: "junctura-app-backup/1", tenant, appId, schemaVersion,
    createdAt: new Date().toISOString(), files,
  }));
  return directory;
}
process.once("exit", () => { if (root) rmSync(root, { recursive: true, force: true }); });

test("restore argument parsing still accepts only the known flags", () => {
  assert.deepEqual(parseArgs(["backup", appId, "--out", "archive"]), { command: "backup", appId, out: "archive" });
  assert.deepEqual(parseArgs(["restore", "archive", "--yes", "--replace"]),
    { command: "restore", directory: "archive", replace: true });
  assert.throws(() => parseArgs(["restore", "archive"]), /Usage/);
  assert.throws(() => parseArgs(["backup", appId, "--out", "--replace"]), /Usage/);
});

test("archives with owned queues and historical message producers validate", async () => {
  await validateArchive(buildArchive("current", {
    ...emptyRows,
    "app_private.message_queues": [queue],
    "app_private.queue_messages": [message],
  }));
});

test("version one archives remain readable", async () => {
  await validateArchive(buildArchive("legacy", legacyRows, 65));
});

test("lease credentials never pass archive validation", async () => {
  for (const dead of [false, true]) {
    assert.rejects(validateArchive(buildArchive(`leased-${dead}`, { ...emptyRows,
      "app_private.message_queues": [queue],
      "app_private.queue_messages": [{ ...message, lease_app_id: peer, lease_token: randomUUID(),
        dead_at: dead ? new Date().toISOString() : null }] })), /lease credentials/);
  }
  assert.rejects(validateArchive(buildArchive("token-only", { ...emptyRows,
    "app_private.message_queues": [queue],
    "app_private.queue_messages": [{ ...message, lease_token: randomUUID() }] })), /lease credentials/);
});

test("queue messages outside the owned queues are refused", async () => {
  assert.rejects(validateArchive(buildArchive("foreign-queue", { ...emptyRows,
    "app_private.message_queues": [queue],
    "app_private.queue_messages": [{ ...message, queue_id: randomUUID() }] })),
    /Invalid ownership in app_private\.queue_messages/);
  assert.rejects(validateArchive(buildArchive("foreign-tenant", { ...emptyRows,
    "app_private.message_queues": [queue],
    "app_private.queue_messages": [{ ...message, tenant_id: "tenant-b" }] })),
    /Invalid ownership in app_private\.queue_messages/);
});

test("queues owned by another application or malformed are refused", async () => {
  assert.rejects(validateArchive(buildArchive("foreign-owner", { ...emptyRows,
    "app_private.message_queues": [{ ...queue, owner_app_id: peer }] })),
    /Invalid ownership in app_private\.message_queues/);
  assert.rejects(validateArchive(buildArchive("bad-shape", { ...emptyRows,
    "app_private.message_queues": [{ ...queue, producer_apps: peer }] })),
    /Invalid queue shape in app_private\.message_queues/);
});
