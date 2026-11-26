// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    assert.ok(readFileSync(manifest).length > 0);
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
