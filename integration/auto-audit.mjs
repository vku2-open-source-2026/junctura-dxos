// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { base, jsonResult, recordTestSupport } from "./record-test-support.mjs";

const prefix = `auditops_${randomUUID().slice(0, 8)}`;
const support = recordTestSupport(prefix);
const { api, sql, q } = support;

test("important SQL operations audit once per commit, and failures and retries do not duplicate it", async () => {
  let actor;
  try {
    actor = await support.createBackend("operation-owner");
    const observe = async (response, status) => {
      const requestId = response.headers.get("x-request-id")?.split(",").at(-1).trim();
      assert.match(requestId, /^[a-f0-9-]{36}$/);
      await jsonResult(response, status);
      return requestId;
    };
    const observed = [];
    const confirm = async (event, requestId, expected = "1") => {
      const result = await sql(`SELECT count(*) FROM app_private.audit WHERE tenant_id='tenant-a' AND event=${q(event)}
        AND subject=${q(actor.subject)} AND reason=${q(requestId)};`);
      assert.equal(result, expected, event);
    };
    const key = () => ({ "Idempotency-Key": randomUUID() });
    const declaration = { schema: { type: "object", properties: { code: { type: "string" }, label: { type: "string" } }, required: ["code"] },
      indexed: ["code"], uniqueKey: "code", sensitive: [], searchable: [] };
    const schemaPath = `/v2/data-schemas/${prefix}`;
    const schemaRequest = { method: "PUT", headers: key(), body: declaration };
    observed.push(["audit.record_schema_registered", await observe(await api(schemaPath, actor, schemaRequest), 200)]);
    await confirm("audit.record_schema_registered", await observe(await api(schemaPath, actor, schemaRequest), 200), "0");
    const maskPath = `/v2/data-masking/${prefix}`;
    const mask = { method: "PUT", body: { fields: { code: { mask: "full" } } } };
    await confirm("audit.record_masking_changed", await observe(await api(maskPath, actor, mask), 409), "0");
    const validMask = { method: "PUT", body: { fields: { label: { mask: "full" } } } };
    observed.push(["audit.record_masking_changed", await observe(await api(maskPath, actor, validMask), 200)]);
    await confirm("audit.record_masking_changed", await observe(await api(maskPath, actor, validMask), 200), "0");
    const body = { operations: [{ op: "create", collection: prefix, data: { code: "one" } }] };
    const batch = { method: "POST", headers: key(), body };
    observed.push(["audit.record_batch", await observe(await api("/v2/data:batch", actor, batch), 200)]);
    await confirm("audit.record_batch", await observe(await api("/v2/data:batch", actor, batch), 200), "0");

    const refused = { method: "POST", headers: key(), body: { operations: [
      { op: "create", collection: prefix, data: { code: "rollback" } },
      { op: "create", collection: prefix, data: { code: "one" } },
    ] } };
    await confirm("audit.record_batch", await observe(await api("/v2/data:batch", actor, refused), 409), "0");
    assert.equal(await sql(`SELECT count(*) FROM core.app_records WHERE owner_app_id=${q(actor.appId)}
      AND data->>'code'='rollback';`), "0");

    const row = { collection: prefix, id: randomUUID(), data: { code: "imported" } };
    const importHeaders = { Authorization: `Bearer ${actor.token}`, "Content-Type": "application/x-ndjson", ...key() };
    const load = () => fetch(`${base}/v2/data:import`, { method: "POST", headers: importHeaders, body: JSON.stringify(row) + "\n" });
    observed.push(["audit.records_imported", await observe(await load(), 200)]);
    await confirm("audit.records_imported", await observe(await load(), 200), "0");

    const exported = await api(`/v2/data:export?collection=${prefix}`, actor);
    assert.equal(exported.status, 200);
    await exported.text();
    observed.push(["audit.records_exported", exported.headers.get("x-request-id").split(",").at(-1).trim()]);
    for (const [event, requestId] of observed) await confirm(event, requestId);
  } finally { await support.cleanup([actor]); }
});
