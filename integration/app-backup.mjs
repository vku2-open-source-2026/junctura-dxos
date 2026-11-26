// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main, parseArgs, validateArchive } from "../scripts/app-backup.mjs";
import { base, jsonResult, recordTestSupport } from "./record-test-support.mjs";

const prefix = `restore_${randomUUID().slice(0, 8)}`;
const support = recordTestSupport(prefix);
const { api, sql, q } = support;

test("application backup and restore require an explicit app scope and restore confirmation", () => {
  const appId = randomUUID();
  assert.deepEqual(parseArgs(["backup", appId, "--out", "archive"]), { command: "backup", appId, out: "archive" });
  assert.deepEqual(parseArgs(["restore", "archive", "--yes", "--replace"]),
    { command: "restore", directory: "archive", replace: true });
  assert.throws(() => parseArgs(["restore", "archive"]), /Usage/);
  assert.throws(() => parseArgs(["backup", appId, "--out", "--replace"]), /Usage/);
});

test("backup restore preserves record/file data, another app and the original audit chain", { timeout: 150000 }, async () => {
  assert.ok(process.env.CI === "true" || /^jx-/.test(process.env.COMPOSE_PROJECT_NAME ?? ""), "use an isolated stack");
  const directory = mkdtempSync(join(tmpdir(), "app-backup-fixture-"));
  const archive = join(directory, "backup");
  let first, second;
  const records = `/v2/data/${prefix}`;
  const create = (owner, name) => api(records, owner, { method: "POST",
    headers: { "Idempotency-Key": randomUUID() }, body: { data: { name } } });
  const suffix = id => `${records}/${id}`;
  try {
    first = await support.createBackend("backup-source");
    second = await support.createBackend("backup-peer");
    const known = await jsonResult(await create(first, "before backup"), 201);
    const other = await jsonResult(await create(second, "independent peer"), 201);
    const file = new FormData();
    file.append("file", new Blob(["fixture bytes"], { type: "application/octet-stream" }), "fixture.txt");
    const uploaded = await jsonResult(await fetch(`${base}/v2/objects`, {
      method: "POST", headers: { Authorization: `Bearer ${first.token}`, "Idempotency-Key": randomUUID() },
      body: file, signal: AbortSignal.timeout(15000),
    }), 201);
    const objectPath = `/v2/objects/${uploaded.id}`;
    const checkpoint = await sql("SELECT chain_seq||':'||entry_hash FROM app_private.audit WHERE tenant_id='tenant-a' ORDER BY chain_seq DESC LIMIT 1;");
    await main(["backup", first.appId, "--out", archive]);
    await validateArchive(archive);
    assert.equal(await sql(`SELECT count(*) FROM app_private.audit WHERE tenant_id='tenant-a'
      AND resource_id=${q(first.appId)} AND event='application.backed_up';`), "1");
    await assert.rejects(main(["restore", archive, "--yes"]), /existing state/);
    const manifest = join(archive, "manifest.json");
    const snapshot = join(archive, "snapshot.json");
    const original = readFileSync(snapshot);
    writeFileSync(snapshot, Buffer.concat([original, Buffer.from("\n")]));
    await assert.rejects(main(["restore", archive, "--yes", "--replace"]), /Checksum mismatch/);
    writeFileSync(snapshot, original);
    const unexpected = join(archive, "extra.bin");
    writeFileSync(unexpected, "");
    await assert.rejects(validateArchive(archive), /Unexpected archive contents/);
    rmSync(unexpected);
    const originalManifest = readFileSync(manifest);
    async function rejectBackupEdit(edit, failure) {
      const document = JSON.parse(original);
      const receipt = JSON.parse(originalManifest);
      edit(document, receipt);
      const bytes = JSON.stringify(document);
      receipt.files.find(file => file.name === "snapshot.json").sha256 = createHash("sha256").update(bytes).digest("hex");
      try {
        writeFileSync(snapshot, bytes);
        writeFileSync(manifest, JSON.stringify(receipt));
        await assert.rejects(main(["restore", archive, "--yes", "--replace"]), failure);
      } finally {
        writeFileSync(snapshot, original);
        writeFileSync(manifest, originalManifest);
      }
    }
    await rejectBackupEdit(document => {
      document.rows["app_private.resource_shares"].push({ tenant_id: "tenant-a", owner_app_id: first.appId,
        share_id: randomUUID(), grantee_app_id: randomUUID(), resource_type: "record", resource_id: known.id, action: "read" });
    }, /Missing dependency/);
    await rejectBackupEdit((document, receipt) => {
      document.schemaVersion += 100;
      receipt.schemaVersion = document.schemaVersion;
    }, /Target database is older/);
    const added = await jsonResult(await create(first, "after backup"), 201);
    const blocker = `fail_${prefix}`;
    await sql(`CREATE FUNCTION app_private.${blocker}() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF NEW.event='application.restored' AND NEW.resource_id=${q(first.appId)}::uuid THEN
          RAISE EXCEPTION 'restore audit fixture failure';
        END IF;
        RETURN NEW;
      END $body$;
      CREATE TRIGGER ${blocker} BEFORE INSERT ON app_private.audit
        FOR EACH ROW EXECUTE FUNCTION app_private.${blocker}();`);
    try {
      await assert.rejects(main(["restore", archive, "--yes", "--replace"]), /restore audit fixture failure/);
      assert.equal(await (await api(objectPath, first)).text(), "fixture bytes");
      assert.equal((await jsonResult(await api(suffix(added.id), first), 200)).data.name, "after backup");
    } finally {
      await sql(`DROP TRIGGER ${blocker} ON app_private.audit; DROP FUNCTION app_private.${blocker}();`);
    }
    await main(["restore", archive, "--yes", "--replace"]);
    assert.equal((await jsonResult(await api(suffix(known.id), first), 200)).data.name, "before backup");
    assert.equal((await api(suffix(added.id), first)).status, 404);
    assert.equal((await jsonResult(await api(suffix(other.id), second), 200)).data.name, "independent peer");
    assert.equal(await (await api(objectPath, first)).text(), "fixture bytes");
    if (checkpoint) assert.equal(await sql(`SELECT count(*) FROM app_private.audit WHERE tenant_id='tenant-a'
      AND chain_seq||':'||entry_hash=${q(checkpoint)};`), "1");
    assert.equal(await sql(`SELECT count(*) FROM app_private.audit WHERE tenant_id='tenant-a'
      AND resource_id=${q(first.appId)} AND event='application.restored';`), "1");
    await api(objectPath, first, { method: "DELETE" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
    await support.cleanup([first, second]);
  }
});

test("backup and restore carry owned queues without touching an independent app", { timeout: 240000 }, async () => {
  assert.ok(process.env.CI === "true" || /^jx-/.test(process.env.COMPOSE_PROJECT_NAME ?? ""), "use an isolated stack");
  const directory = mkdtempSync(join(tmpdir(), "app-backup-queues-"));
  const archive = join(directory, "backup");
  const queuePath = `/v1/queues/restore-q-${randomUUID().slice(0, 8)}`;
  let owner, peer, independent;
  try {
    owner = await support.createBackend("queue-owner");
    peer = await support.createBackend("queue-peer");
    independent = await support.createBackend("queue-independent");
    const queue = await jsonResult(await api(queuePath, owner, { method: "PUT",
      body: { producerAppIds: [peer.appId], consumerAppIds: [peer.appId], maxAttempts: 2 } }), 200);
    const payload = { task: "restore-queue-payload" };
    const key = randomUUID();
    const sent = await jsonResult(await api(`${queuePath}/messages`, peer,
      { method: "POST", headers: { "Idempotency-Key": key }, body: { payload } }), 201);
    const otherQueuePath = `/v1/queues/independent-q-${randomUUID().slice(0, 8)}`;
    const independentQueue = await jsonResult(await api(otherQueuePath, independent,
      { method: "PUT", body: { maxAttempts: 2 } }), 200);
    const independentSent = await jsonResult(await api(`${otherQueuePath}/messages`, independent,
      { method: "POST", headers: { "Idempotency-Key": randomUUID() }, body: { payload: { task: "queue-b" } } }), 201);
    const other = await jsonResult(await api("/v2/data/independent_fixture", independent, { method: "POST",
      headers: { "Idempotency-Key": randomUUID() }, body: { data: { task: "independent peer" } } }), 201);
    const checkpoint = await sql("SELECT chain_seq||':'||entry_hash FROM app_private.audit WHERE tenant_id='tenant-a' ORDER BY chain_seq DESC LIMIT 1;");
    await main(["backup", owner.appId, "--out", archive]);
    await validateArchive(archive);
    assert.equal(await sql(`SELECT count(*) FROM app_private.audit WHERE tenant_id='tenant-a'
      AND resource_id=${q(owner.appId)} AND event='application.backed_up';`), "1");
    assert.equal(await sql(`SELECT count(*) FROM app_private.audit WHERE tenant_id='tenant-a'
      AND management_client=${q(peer.clientId)} AND event='audit.queue_send' AND outcome='success';`), "1");
    const leased = (await jsonResult(await api(`${queuePath}/lease`, peer,
      { method: "POST", body: { visibilityTimeoutSeconds: 120 } }), 200)).message;
    await assert.rejects(main(["backup", owner.appId, "--out", join(directory, "leased")]), /active queue lease/);
    assert.equal(await (await api(`${queuePath}/messages/${leased.messageId}/ack`, peer,
      { method: "POST", body: { leaseToken: leased.leaseToken } })).status, 204);
    const v1 = join(directory, "v1");
    const v1Snapshot = JSON.parse(readFileSync(join(archive, "snapshot.json")));
    for (const table of ["app_private.message_queues", "app_private.queue_messages"]) delete v1Snapshot.rows[table];
    const v1Bytes = JSON.stringify(v1Snapshot);
    const auditBytes = readFileSync(join(archive, "audit.json"));
    mkdirSync(v1, { recursive: true });
    writeFileSync(join(v1, "snapshot.json"), v1Bytes);
    writeFileSync(join(v1, "audit.json"), auditBytes);
    const v1Manifest = JSON.parse(readFileSync(join(archive, "manifest.json")));
    v1Manifest.files = [["snapshot.json", v1Bytes], ["audit.json", auditBytes]]
      .map(([name, bytes]) => ({ name, sha256: createHash("sha256").update(bytes).digest("hex") }));
    writeFileSync(join(v1, "manifest.json"), JSON.stringify(v1Manifest));
    await assert.rejects(main(["restore", v1, "--yes"]), /existing state/);
    await assert.rejects(main(["restore", v1, "--yes", "--replace"]), /state outside the archive/);
    const originalSnapshot = readFileSync(join(archive, "snapshot.json"));
    const originalManifest = readFileSync(join(archive, "manifest.json"));
    async function rejectSnapshotEdit(edit, failure) {
      const document = JSON.parse(originalSnapshot);
      const receipt = JSON.parse(originalManifest);
      edit(document);
      const bytes = JSON.stringify(document);
      receipt.files.find(file => file.name === "snapshot.json").sha256 = createHash("sha256").update(bytes).digest("hex");
      try {
        writeFileSync(join(archive, "snapshot.json"), bytes);
        writeFileSync(join(archive, "manifest.json"), JSON.stringify(receipt));
        await assert.rejects(main(["restore", archive, "--yes", "--replace"]), failure);
      } finally {
        writeFileSync(join(archive, "snapshot.json"), originalSnapshot);
        writeFileSync(join(archive, "manifest.json"), originalManifest);
      }
    }
    const queueRow = JSON.parse(originalSnapshot).rows["app_private.message_queues"][0];
    await rejectSnapshotEdit(document => document.rows["app_private.message_queues"].push({
      ...queueRow, queue_id: randomUUID(), name: `restore-q-${randomUUID().slice(0, 8)}`,
      producer_apps: [randomUUID()], consumer_apps: [] }), /Missing dependency for a queue producer app/);
    await rejectSnapshotEdit(document => {
      document.rows["app_private.message_queues"][0].producer_versions = [randomUUID()];
    }, /Missing dependency for a queue capability version/);
    const blocker = `fail_q_${prefix}`;
    await sql(`CREATE FUNCTION app_private.${blocker}() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF NEW.event='application.restored' AND NEW.resource_id=${q(owner.appId)}::uuid THEN
          RAISE EXCEPTION 'restore queue fixture failure';
        END IF;
        RETURN NEW;
      END $body$;
      CREATE TRIGGER ${blocker} BEFORE INSERT ON app_private.audit
        FOR EACH ROW EXECUTE FUNCTION app_private.${blocker}();`);
    try {
      await assert.rejects(main(["restore", archive, "--yes", "--replace"]), /restore queue fixture failure/);
      assert.equal(await sql(`SELECT count(*) FROM app_private.queue_messages WHERE tenant_id='tenant-a'
        AND queue_id=${q(queue.queueId)};`), "1");
    } finally {
      await sql(`DROP TRIGGER ${blocker} ON app_private.audit; DROP FUNCTION app_private.${blocker}();`);
    }
    await main(["restore", archive, "--yes", "--replace"]);
    assert.deepEqual(JSON.parse(await sql(`SELECT coalesce(jsonb_agg(jsonb_build_object('payload',payload_json,
      'settled', lease_app_id IS NULL AND lease_token IS NULL)), '[]'::jsonb) FROM app_private.queue_messages
      WHERE tenant_id='tenant-a' AND queue_id=${q(queue.queueId)};`)),
      [{ payload: JSON.stringify(payload), settled: true }]);
    assert.deepEqual(await jsonResult(await api(`${queuePath}/messages`, peer,
      { method: "POST", headers: { "Idempotency-Key": key }, body: { payload } }), 201), sent);
    assert.equal(await sql(`SELECT count(*) FROM app_private.message_queues WHERE tenant_id='tenant-a'
      AND owner_app_id=${q(independent.appId)};`), "1");
    assert.equal(await sql(`SELECT count(*) FROM app_private.queue_messages WHERE tenant_id='tenant-a'
      AND queue_id=${q(independentQueue.queueId)};`), "1");
    assert.equal((await jsonResult(await api(`/v2/data/independent_fixture/${other.id}`, independent), 200)).data.task,
      "independent peer");
    assert.equal(await sql(`SELECT count(*) FROM app_private.audit WHERE tenant_id='tenant-a'
      AND resource_id=${q(owner.appId)} AND event='application.restored';`), "1");
    if (checkpoint) assert.equal(await sql(`SELECT count(*) FROM app_private.audit WHERE tenant_id='tenant-a'
      AND chain_seq||':'||entry_hash=${q(checkpoint)};`), "1");
    assert.deepEqual(JSON.parse(await sql(`SELECT coalesce(jsonb_agg(payload_json), '[]'::jsonb) FROM app_private.queue_messages
      WHERE tenant_id='tenant-a' AND queue_id=${q(independentQueue.queueId)};`)),
      [JSON.stringify({ task: "queue-b" })]);
    assert.notEqual(independentSent.messageId, sent.messageId);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    if (owner && independent) {
      await sql(`BEGIN;
        DELETE FROM app_private.queue_messages WHERE tenant_id='tenant-a' AND queue_id IN
          (SELECT queue_id FROM app_private.message_queues WHERE tenant_id='tenant-a'
            AND owner_app_id IN (${q(owner.appId)},${q(independent.appId)}));
        DELETE FROM app_private.message_queues WHERE tenant_id='tenant-a'
          AND owner_app_id IN (${q(owner.appId)},${q(independent.appId)});
        COMMIT;`).catch(() => {});
    }
    await support.cleanup([owner, peer, independent]);
  }
});

test("restore refuses a live target lease and leaves the lease holder intact", { timeout: 240000 }, async () => {
  assert.ok(process.env.CI === "true" || /^jx-/.test(process.env.COMPOSE_PROJECT_NAME ?? ""), "use an isolated stack");
  const directory = mkdtempSync(join(tmpdir(), "app-backup-lease-"));
  const archive = join(directory, "backup");
  const queuePath = `/v1/queues/restore-lease-q-${randomUUID().slice(0, 8)}`;
  let owner, peer;
  try {
    owner = await support.createBackend("lease-owner");
    peer = await support.createBackend("lease-peer");
    const queue = await jsonResult(await api(queuePath, owner, { method: "PUT",
      body: { producerAppIds: [peer.appId], consumerAppIds: [peer.appId], maxAttempts: 2 } }), 200);
    const payload = { task: "restore-lease-payload" };
    await jsonResult(await api(`${queuePath}/messages`, peer,
      { method: "POST", headers: { "Idempotency-Key": randomUUID() }, body: { payload } }), 201);
    await main(["backup", owner.appId, "--out", archive]);
    const leased = (await jsonResult(await api(`${queuePath}/lease`, peer,
      { method: "POST", body: { visibilityTimeoutSeconds: 300 } }), 200)).message;
    await assert.rejects(main(["restore", archive, "--yes", "--replace"]), /active queue lease/);
    assert.equal(await (await api(`${queuePath}/messages/${leased.messageId}/ack`, peer,
      { method: "POST", body: { leaseToken: leased.leaseToken } })).status, 204);
    assert.equal(await sql(`SELECT count(*) FROM app_private.queue_messages WHERE tenant_id='tenant-a'
      AND queue_id=${q(queue.queueId)} AND message_id=${q(leased.messageId)}
      AND payload_json IS NULL AND dead_at IS NULL
      AND lease_app_id IS NULL AND lease_token IS NULL;`), "1");
  } finally {
    rmSync(directory, { recursive: true, force: true });
    if (owner) {
      await sql(`BEGIN;
        DELETE FROM app_private.queue_messages WHERE tenant_id='tenant-a' AND queue_id IN
          (SELECT queue_id FROM app_private.message_queues WHERE tenant_id='tenant-a' AND owner_app_id=${q(owner.appId)});
        DELETE FROM app_private.message_queues WHERE tenant_id='tenant-a' AND owner_app_id=${q(owner.appId)};
        COMMIT;`).catch(() => {});
    }
    await support.cleanup([owner, peer]);
  }
});
