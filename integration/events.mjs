// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { verifyContracts } from "./contract.mjs";
import { base, issuer, recordTestSupport } from "./record-test-support.mjs";

const { sql, q, createBackend, cleanup } = recordTestSupport(`events-${randomUUID().slice(0, 8)}`);
const path = "/v1/events";

async function connect(who, lastEventId) {
  const controller = new AbortController();
  const response = await fetch(base + path, {
    headers: { Authorization: `Bearer ${who.token}`, ...(lastEventId && { "Last-Event-ID": lastEventId }) },
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  async function frame() {
    let boundary;
    while ((boundary = pending.indexOf("\n\n")) === -1) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false, "stream closed while waiting for a frame");
      pending += decoder.decode(chunk.value, { stream: true });
    }
    const next = pending.slice(0, boundary);
    pending = pending.slice(boundary + 2);
    return next;
  }
  async function event() {
    let next;
    do { next = await frame(); } while (next.startsWith(":"));
    const [type, data, extra] = next.split("\n");
    assert.match(type, /^event: /);
    assert.match(data, /^data: /);
    assert.equal(extra, undefined);
    return { event: type.slice(7), data: JSON.parse(data.slice(6)), bytes: Buffer.byteLength(next) };
  }
  assert.equal(await frame(), ": connected");
  return { response, event, close: () => controller.abort() };
}

test("gateway delivers committed live events across concurrent connections and rechecks record sharing", { timeout: 90000 }, async () => {
  const connections = [];
  let writer, peer;
  const id = randomUUID(), barrier = randomUUID(), consent = randomUUID();
  const record = recordId => ({ event: "record.status.changed", data: { recordRef: { collection: "entries", id: recordId } } });
  const withoutSize = ({ event, data }) => ({ event, data });
  try {
    writer = await createBackend("writer");
    peer = await createBackend("peer");
    await sql(`INSERT INTO core.app_records(tenant_id,id,owner_app_id,collection,data) VALUES
      ('tenant-a',${q(id)},${q(writer.appId)},'entries','{"status":"old"}'),
      ('tenant-a',${q(barrier)},${q(writer.appId)},'entries','{}');
      INSERT INTO app_private.resource_shares(tenant_id,owner_app_id,grantee_app_id,resource_type,resource_id,action,expires_at)
      VALUES('tenant-a',${q(writer.appId)},${q(peer.appId)},'record',${q(id)},'read',now()+interval '5 minutes'),
            ('tenant-a',${q(writer.appId)},${q(peer.appId)},'record',${q(barrier)},'read',now()+interval '5 minutes');
      INSERT INTO execution_private.subject_consents(tenant_id,consent_id,issuer,data_subject,consumer_app_id,
        capability_id,purposes,expires_at)
      VALUES('tenant-a',${q(consent)},${q(issuer)},${q(writer.subject)},${q(peer.appId)},
        ${q(`urn:junctura:capability:${peer.appId}:test`)},ARRAY['test'],now()+interval '5 minutes');`);
    const ownerStream = await connect(writer), sharedStream = await connect(peer);
    connections.push(ownerStream, sharedStream);
    await sql(`BEGIN;
        UPDATE core.app_records SET data='{"status":"rolled-back"}' WHERE tenant_id='tenant-a' AND id=${q(id)};
      ROLLBACK;
      UPDATE core.app_records SET data='{"status":"live"}' WHERE tenant_id='tenant-a' AND id=${q(id)};`);
    const ownerFirst = await ownerStream.event();
    assert.deepEqual(withoutSize(ownerFirst), record(id));
    assert.deepEqual(withoutSize(await sharedStream.event()), record(id));

    await sql(`BEGIN;
      UPDATE core.app_records SET data='{"status":"private"}' WHERE tenant_id='tenant-a' AND id=${q(id)};
      UPDATE app_private.resource_shares SET revoked=true WHERE tenant_id='tenant-a' AND resource_id=${q(id)};
      UPDATE core.app_records SET data='{"status":"barrier"}' WHERE tenant_id='tenant-a' AND id=${q(barrier)};
      UPDATE execution_private.subject_consents SET revoked_at=clock_timestamp() WHERE tenant_id='tenant-a' AND consent_id=${q(consent)};
      COMMIT;`);
    assert.deepEqual(withoutSize(await ownerStream.event()), record(id));
    assert.deepEqual(withoutSize(await ownerStream.event()), record(barrier));
    assert.deepEqual(withoutSize(await sharedStream.event()), record(barrier));
    for (const stream of [ownerStream, sharedStream]) {
      assert.deepEqual(withoutSize(await stream.event()), { event: "consent.revoked", data: { consentId: consent } });
    }

    ownerStream.close();
    const reconnected = await connect(writer, "1");
    connections.push(reconnected);
    await sql(`UPDATE core.app_records SET data='{"status":"new-after-reconnect"}' WHERE tenant_id='tenant-a' AND id=${q(barrier)};`);
    assert.deepEqual(withoutSize(await reconnected.event()), record(barrier));
    await Promise.all([id, barrier].map(recordId =>
      sql(`UPDATE core.app_records SET data='{"status":"concurrent"}' WHERE tenant_id='tenant-a' AND id=${q(recordId)};`)));
    const concurrent = [await reconnected.event(), await reconnected.event()].map(item => item.data.recordRef.id);
    assert.deepEqual(new Set(concurrent), new Set([id, barrier]));
    const responseHeaders = Object.fromEntries(["content-type", "cache-control", "x-content-type-options"]
      .map(name => [name, ownerStream.response.headers.get(name)]));
    await verifyContracts("events", [{ path, method: "GET", status: 200, authorized: true, query: {},
      pathParams: {}, requestHeaders: {}, requestBytes: 0, responseHeaders, responseBytes: ownerFirst.bytes }]);
  } finally {
    for (const stream of connections) stream.close();
    await sql(`DELETE FROM execution_private.subject_consents WHERE tenant_id='tenant-a' AND consent_id=${q(consent)};`);
    await cleanup([writer, peer]);
  }
});

async function flowable(path, operation = "GET", deployment) {
  const { stdout } = await promisify(execFile)("docker", ["compose", "exec", "-T", "core", "node",
    "--input-type=module", "-e", `
      import { workflowRequest } from "./src/modules/workflow/client.mjs";
      const [path, method, xml] = process.argv.slice(1);
      const config = { workflowUrl: process.env.WORKFLOW_URL, workflowPassword: process.env.WORKFLOW_ADMIN_PASSWORD };
      let body;
      if (xml) {
        body = new FormData();
        body.set("tenantId", "tenant-a");
        body.set("file", new Blob([xml], { type: "application/xml" }), "events.bpmn20.xml");
      }
      console.log(JSON.stringify(await workflowRequest(config, path, { method, body })));
    `, path, operation, ...(deployment ? [deployment] : [])], { timeout: 15000 });
  return JSON.parse(stdout);
}

test("gateway sends a new Flowable task to its eligible group across Core replicas", { timeout: 90000 }, async () => {
  const suffix = randomUUID().slice(0, 8);
  const unit = `events-${suffix}`, definitionKey = `events_${suffix}`, requestKey = randomUUID();
  const { sql, q, admin, createBackend, cleanup } = recordTestSupport(unit);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
      xmlns:flowable="http://flowable.org/bpmn" targetNamespace="https://example.invalid">
      <process id="${definitionKey}" isExecutable="true" name="Event approval">
        <startEvent id="start"/><userTask id="review" name="Review" flowable:candidateGroups="readers"/>
        <endEvent id="end"/><sequenceFlow id="a" sourceRef="start" targetRef="review"/>
        <sequenceFlow id="b" sourceRef="review" targetRef="end"/>
      </process>
    </definitions>`;
  const barrier = randomUUID();
  let owner, peer, ownerStream, peerStream, deployment, definitionId, unitGroup;
  const createGroup = async (parent, name) => {
    const response = await admin(`groups/${parent}/children`, "POST", { name });
    assert.equal(response.status, 201, await response.text());
    return response.headers.get("location").split("/").at(-1);
  };
  try {
    owner = await createBackend("member");
    peer = await createBackend("peer");
    const [root] = await (await admin("groups?search=tenant-a&exact=true")).json();
    unitGroup = await createGroup(root.id, unit);
    const members = await createGroup(unitGroup, "readers");
    assert.equal((await admin(`users/${owner.subject}/groups/${members}`, "PUT")).status, 204);
    const [client] = await (await admin(`clients?clientId=${owner.clientId}`)).json();
    const { value: secret } = await (await admin(`clients/${client.id}/client-secret`)).json();
    const issued = await fetch(`${issuer}/protocol/openid-connect/token`, { method: "POST",
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: owner.clientId, client_secret: secret }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(issued.status, 200);
    owner.token = (await issued.json()).access_token;
    deployment = (await flowable("repository/deployments", "POST", xml)).id;
    const definitions = await flowable(`repository/process-definitions?${new URLSearchParams({ deploymentId: deployment, tenantId: "tenant-a" })}`);
    definitionId = definitions.data[0].id;
    await sql(`INSERT INTO app_private.directory_unit_types(tenant_id,unit_type,name,generation,synced_generation)
      VALUES('tenant-a',${q(unit)},'Fixture',1,1);
      INSERT INTO app_private.directory_units(tenant_id,unit,unit_type,name,generation,synced_generation)
      VALUES('tenant-a',${q(unit)},${q(unit)},'Fixture',1,1);
      INSERT INTO app_private.directory_groups(tenant_id,unit,unit_group,name,generation,synced_generation)
      VALUES('tenant-a',${q(unit)},'readers','Readers',1,1);
      INSERT INTO app_private.workflow_definition_policies(tenant_id,definition_id,default_unit,allowed_units)
      VALUES('tenant-a',${q(definitionId)},${q(unit)},ARRAY[${q(unit)}]);`);
    ownerStream = await connect(owner);
    peerStream = await connect(peer);
    const dueAt = new Date(Date.now() + 16000).toISOString();
    const started = await fetch(`${base}/v1/workflows/executions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json", "Idempotency-Key": requestKey },
      body: JSON.stringify({ definitionId, dueAt }), signal: AbortSignal.timeout(15000),
    });
    assert.equal(started.status, 201, await started.clone().text());
    const execution = await started.json();
    const types = ["workflow.task.created", "workflow.task.due_soon", "workflow.task.overdue"];
    // Replicas can publish creation and reminders in either order.
    const received = new Map();
    while (received.size < types.length) {
      const { event, data } = await ownerStream.event();
      assert.ok(types.includes(event), `unexpected task event: ${event}`);
      assert.ok(!received.has(event), `duplicate task event: ${event}`);
      received.set(event, data);
    }
    const task = received.get("workflow.task.created");
    assert.equal(task.executionId, execution.id);
    assert.deepEqual(Object.keys(task).sort(), ["executionId", "taskId"]);
    for (const event of ["workflow.task.due_soon", "workflow.task.overdue"]) {
      const reminder = received.get(event);
      assert.deepEqual(reminder, { ...task, dueAt: reminder.dueAt });
      assert.equal(Date.parse(reminder.dueAt), Date.parse(dueAt));
    }
    const milestones = await sql(`SELECT array_agg(milestone ORDER BY milestone)
      FROM app_private.workflow_reminders WHERE tenant_id='tenant-a' AND task_id=${q(task.taskId)};`);
    assert.equal(milestones.trim(), "{due_soon,overdue}");

    await sql(`INSERT INTO core.app_records(tenant_id,id,owner_app_id,collection,data)
      VALUES('tenant-a',${q(barrier)},${q(peer.appId)},'entries','{"status":"peer-only"}');`);
    const next = await peerStream.event();
    assert.equal(next.event, "record.status.changed");
    assert.deepEqual(next.data, { recordRef: { id: barrier, collection: "entries" } });
  } finally {
    ownerStream?.close();
    peerStream?.close();
    try {
      if (deployment) await flowable(`repository/deployments/${encodeURIComponent(deployment)}?cascade=true`, "DELETE");
      await sql(`DELETE FROM app_private.idempotency_results WHERE tenant_id='tenant-a' AND key=${q(requestKey)};
        DELETE FROM app_private.workflow_executions WHERE tenant_id='tenant-a' AND request_key=${q(requestKey)};
        DELETE FROM app_private.workflow_definition_policies WHERE tenant_id='tenant-a' AND definition_id=${q(definitionId)};
        DELETE FROM app_private.directory_groups WHERE tenant_id='tenant-a' AND unit=${q(unit)};
        DELETE FROM app_private.directory_units WHERE tenant_id='tenant-a' AND unit=${q(unit)};
        DELETE FROM app_private.directory_unit_types WHERE tenant_id='tenant-a' AND unit_type=${q(unit)};`);
    } finally {
      if (unitGroup) await admin(`groups/${unitGroup}`, "DELETE");
      await cleanup([owner, peer]);
    }
  }
});
