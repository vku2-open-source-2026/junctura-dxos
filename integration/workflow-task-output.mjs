// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { createAuthorityFixture } from "./fixtures/authority.mjs";
import { verifyContracts } from "./contract.mjs";
import { base, issuer, jsonResult, recordTestSupport } from "./record-test-support.mjs";

const suffix = randomBytes(5).toString("hex");
const prefix = `wfoutput-${suffix}`;
const key = `wfoutput_${suffix}`;
const tenant = "tenant-a";
const unit = `${prefix}-unit`;
const wrongUnit = `${prefix}-other`;
const group = "reviewers";
const subjectId = `${prefix}:writer`;
const appId = randomUUID();
const clientIds = [];
const users = [];
const { api, q, cleanup } = recordTestSupport(prefix);
const run = (...args) => promisify(execFile)("docker", args, { timeout: 30000 });
const sql = source => run("compose", "exec", "-T", "database", "psql", "-U", "junctura_admin", "-d", "junctura_data",
  "-XAtq", "-v", "ON_ERROR_STOP=1", "-c", source);
const fixture = createAuthorityFixture({ base, prefix, q, sql, api, clientIds, users });
const { admin, login, human, verifiedSubject } = fixture;
const executionPath = id => `/v1/workflows/executions/${encodeURIComponent(id)}`;
const inbox = `/v1/workflows/tasks?definitionKey=${key}`;
const trigger = `hold_output_${suffix}`;
const requestKeys = [];
let deploymentId, definitionId, writer, outsider;

async function engine(path, method = "GET", body) {
  const { stdout } = await run("compose", "exec", "-T", "core", "node", "--input-type=module", "-e", `
    import { workflowRequest } from "./src/modules/workflow/client.mjs";
    const [path, method, payload] = process.argv.slice(1);
    const config = { workflowUrl: process.env.WORKFLOW_URL, workflowPassword: process.env.WORKFLOW_ADMIN_PASSWORD };
    let body = payload && JSON.stringify(JSON.parse(payload));
    if (path === "repository/deployments") {
      const { tenant, xml } = JSON.parse(payload);
      body = new FormData();
      body.append("tenantId", tenant);
      body.append("file", new Blob([xml], { type: "application/xml" }), "output.bpmn20.xml");
    }
    console.log(JSON.stringify(await workflowRequest(config, path, { method, body })));
  `, path, method, ...(body === undefined ? [] : [JSON.stringify(body)]));
  return JSON.parse(stdout);
}

async function adminCreate(path, body) {
  const response = await admin(path, body, "POST");
  assert.equal(response.status, 201, await response.clone().text());
  return response.headers.get("location").split("/").at(-1);
}

before(async () => {
  await fixture.operatorToken();
  const [template] = await (await admin("clients?clientId=tenant-a")).json();
  const source = await (await admin(`clients/${template.id}`)).json();
  const { protocolMappers } = source;
  clientIds.push(await adminCreate("clients", {
    clientId: `${prefix}-management-${tenant}`, enabled: true, protocol: "openid-connect",
    publicClient: true, standardFlowEnabled: true, directAccessGrantsEnabled: false,
    redirectUris: ["http://127.0.0.1:9876/callback"], attributes: { "pkce.code.challenge.method": "S256" },
    protocolMappers: protocolMappers.map(({ id, ...mapper }) => mapper),
  }));
  writer = await human("writer", tenant, []);
  outsider = await human("outsider", tenant, []);
  const [root] = await (await admin(`groups?search=${tenant}&exact=true`)).json();
  const unitGroup = await adminCreate(`groups/${root.id}/children`, { name: unit });
  const otherUnitGroup = await adminCreate(`groups/${root.id}/children`, { name: wrongUnit });
  const candidate = await adminCreate(`groups/${unitGroup}/children`, { name: group });
  const wrongCandidate = await adminCreate(`groups/${otherUnitGroup}/children`, { name: group });
  for (const [who, groupId] of [[writer, candidate], [outsider, wrongCandidate]]) {
    assert.equal((await admin(`users/${who.id}/groups/${groupId}`, undefined, "PUT")).status, 204);
  }
  writer = await verifiedSubject(writer, subjectId);
  outsider.token = await login(outsider.username, outsider.password, outsider.clientId);
  assert.equal((await jsonResult(await api("/v1/identity", writer), 200)).subjectId, subjectId);
  assert.deepEqual((await jsonResult(await api("/v1/identity", outsider), 200)).groups, [`/${wrongUnit}/${group}`]);
  const provider = `https://${prefix}.example.invalid`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:flowable="http://flowable.org/bpmn" targetNamespace="https://example.invalid">
      <process id="${key}" isExecutable="true" name="Output review">
        <startEvent id="start"/>
        <sequenceFlow id="a" sourceRef="start" targetRef="review"/>
        <userTask id="review" name="Review" flowable:candidateGroups="${group}"/>
        <sequenceFlow id="b" sourceRef="review" targetRef="end"/>
        <endEvent id="end"/>
      </process>
    </definitions>`;
  deploymentId = (await engine("repository/deployments", "POST", { tenant, xml })).id;
  const deployed = await engine(`repository/process-definitions?${new URLSearchParams({ deploymentId, tenantId: tenant, key })}`);
  assert.equal(deployed.data.length, 1);
  assert.equal(deployed.data[0].key, key);
  definitionId = deployed.data[0].id;
  await sql(`
    INSERT INTO app_private.directory_unit_types (tenant_id,unit_type,name,generation,synced_generation)
      VALUES (${q(tenant)},${q(prefix)},'Workflow output test',1,1);
    INSERT INTO app_private.directory_units (tenant_id,unit,unit_type,name,generation,synced_generation)
      VALUES (${q(tenant)},${q(unit)},${q(prefix)},'Output fixture unit',1,1),
             (${q(tenant)},${q(wrongUnit)},${q(prefix)},'Other fixture unit',1,1);
    INSERT INTO app_private.directory_groups (tenant_id,unit,unit_group,name,generation,synced_generation)
      VALUES (${q(tenant)},${q(unit)},${q(group)},'Reviewers',1,1),
             (${q(tenant)},${q(wrongUnit)},${q(group)},'Other reviewers',1,1);
    INSERT INTO app_private.workflow_definition_policies (tenant_id,definition_id,default_unit,allowed_units)
      VALUES (${q(tenant)},${q(definitionId)},${q(unit)},ARRAY[${q(unit)}]);
    INSERT INTO app_private.applications (tenant_id,app_id,issuer,oauth_client_id,owner_subject,provider_origin,display_name,state,digest)
      VALUES (${q(tenant)},${q(appId)},${q(issuer)},${q(writer.clientId)},${q(writer.id)},${q(provider)},'Workflow output fixture','active','sha256:${"0".repeat(64)}');
    INSERT INTO app_private.enrollments (tenant_id,issuer,oauth_client_id,owner_subject,provider_origin,resource_subject)
      VALUES (${q(tenant)},${q(issuer)},${q(writer.clientId)},${q(writer.id)},${q(provider)},${q(writer.id)});
    CREATE FUNCTION app_private.${trigger}() RETURNS trigger LANGUAGE plpgsql AS $fixture$
    BEGIN
      IF new.definition_id = ${q(definitionId)} AND new.tenant_id = ${q(tenant)} THEN new.available_at := 'infinity'; END IF;
      RETURN new;
    END $fixture$;
    CREATE TRIGGER ${trigger} BEFORE INSERT ON app_private.workflow_completion_outbox
      FOR EACH ROW EXECUTE FUNCTION app_private.${trigger}();
  `);
}, { timeout: 120000 });

after(async () => {
  try {
    if (deploymentId) await engine(`repository/deployments/${encodeURIComponent(deploymentId)}?cascade=true`, "DELETE");
    const keys = requestKeys.map(q).join(",") || "NULL";
    await sql(`
      DROP TRIGGER IF EXISTS ${trigger} ON app_private.workflow_completion_outbox;
      DROP FUNCTION IF EXISTS app_private.${trigger}();
      DELETE FROM app_private.workflow_completion_outbox WHERE tenant_id=${q(tenant)} AND definition_id=${q(definitionId)};
      DELETE FROM app_private.workflow_task_claims WHERE tenant_id=${q(tenant)} AND execution_id IN
        (SELECT execution_id FROM app_private.workflow_executions WHERE tenant_id=${q(tenant)} AND definition_id=${q(definitionId)});
      DELETE FROM app_private.workflow_executions WHERE tenant_id=${q(tenant)} AND definition_id=${q(definitionId)};
      DELETE FROM app_private.workflow_definition_policies WHERE tenant_id=${q(tenant)} AND definition_id=${q(definitionId)};
      DELETE FROM app_private.directory_groups WHERE tenant_id=${q(tenant)} AND unit IN (${q(unit)},${q(wrongUnit)});
      DELETE FROM app_private.directory_units WHERE tenant_id=${q(tenant)} AND unit IN (${q(unit)},${q(wrongUnit)});
      DELETE FROM app_private.directory_unit_types WHERE tenant_id=${q(tenant)} AND unit_type=${q(prefix)};
      DELETE FROM app_private.idempotency_results WHERE tenant_id=${q(tenant)} AND key IN (${keys});
      DELETE FROM core.workflow_requests WHERE tenant_id=${q(tenant)} AND key IN (${keys});
    `);
    if (writer) await cleanup([{ appId, subject: writer.id, clientId: writer.clientId }]);
    await fixture.cleanupSubjectBindings();
  } finally {
    await fixture.operatorToken();
    const roots = await (await admin(`groups?search=${tenant}&exact=true`)).json();
    const root = roots.find(entry => entry.path === `/${tenant}`);
    if (root) for (const entry of await (await admin(`groups/${root.id}/children`)).json()) {
      if ([unit, wrongUnit].includes(entry.name)) await admin(`groups/${entry.id}`, undefined, "DELETE");
    }
    for (const id of users) await admin(`users/${id}`, undefined, "DELETE");
    for (const id of clientIds) await admin(`clients/${id}`, undefined, "DELETE");
  }
  await verifyContracts("workflow-task-output");
}, { timeout: 120000 });

const newKey = () => { const id = randomUUID(); requestKeys.push(id); return id; };
const post = (body, idempotencyKey) => ({ method: "POST", body, headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {} });
const start = (who, body = {}, id = newKey()) => api("/v1/workflows/executions", who, post({ definitionId, ...body }, id));
const complete = (who, path, body, id = newKey()) => api(`${path}/complete`, who, post(body, id));
const lookup = async (path, who = writer) => jsonResult(await api(path, who), 200);
const history = path => lookup(`${path}/history`);
const taskOf = async execution => {
  const task = (await lookup(inbox)).items.find(item => item.executionId === execution.id);
  assert.ok(task, `the inbox is missing the task of ${execution.id}`);
  return task;
};
const outboxRow = async taskId => {
  const { stdout } = await sql(`SELECT variables, state, decision, reason FROM app_private.workflow_completion_outbox
    WHERE tenant_id=${q(tenant)} AND task_id=${q(taskId)};`);
  const [variables, state, decision, reason] = stdout.trim().split("|");
  return { variables: JSON.parse(variables), state, decision, reason };
};
const resume = taskId => sql(`UPDATE app_private.workflow_completion_outbox SET available_at=clock_timestamp()
  WHERE tenant_id=${q(tenant)} AND task_id=${q(taskId)};`);
async function waitFor(poll) {
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    const result = await poll();
    if (result) return result;
    await delay(300);
  }
  assert.fail("Workflow did not reach the expected state");
}

test("output validation rejects bad payloads before the engine sees a command", { timeout: 90000 }, async () => {
  const first = await jsonResult(await start(writer), 201);
  const path = executionPath(first.id);
  const task = await taskOf(first);
  for (const output of [null, [], "done", 2]) {
    await jsonResult(await complete(writer, path, { taskId: task.taskId, output }), 400);
  }
  for (const body of [
    { taskId: task.taskId, variables: { note: "a" }, output: { note: "b" } },
    { taskId: task.taskId, output: { "bad-name": 1 } },
    { taskId: task.taskId, output: { input: "x" } },
    { taskId: task.taskId, output: { __junctura_completion: "x" } },
    { taskId: task.taskId, output: { decision: { approved: true } } },
    { taskId: task.taskId, output: { decision: "" } },
    { taskId: task.taskId, output: { reason: "y".repeat(501) } },
  ]) {
    await jsonResult(await complete(writer, path, body), 400);
  }
  await jsonResult(await complete(writer, path, { taskId: task.taskId, output: { blob: "x".repeat(65536) } }), 413);
  await jsonResult(await complete(writer, path, { output: { note: "done" } }), 400);
  const second = await jsonResult(await start(writer), 201);
  const stray = await taskOf(second);
  assert.equal((await jsonResult(await complete(writer, path, { taskId: stray.taskId }), 404)).error, "not_found");
  assert.equal((await jsonResult(await complete(outsider, path,
    { taskId: task.taskId, output: { note: "done" } }), 403)).error, "task_group_required");
  assert.deepEqual((await lookup(inbox)).items.map(item => item.taskId).sort(), [task.taskId, stray.taskId].sort());
  const { stdout } = await sql(`SELECT count(*) FROM app_private.workflow_completion_outbox
    WHERE tenant_id=${q(tenant)} AND definition_id=${q(definitionId)};`);
  assert.equal(stdout.trim(), "0");
});

test("completion output commits to the outbox and becomes engine variables and history", { timeout: 90000 }, async () => {
  const execution = await jsonResult(await start(writer), 201);
  const path = executionPath(execution.id);
  const task = await taskOf(execution);
  const body = { taskId: task.taskId, variables: { approved: true },
    output: { decision: "approved", reason: "Output criteria met", summary: { items: 2 }, note: "done" } };
  const completionKey = newKey();
  const receipts = await Promise.all([complete(writer, path, body, completionKey), complete(writer, path, body, completionKey)]);
  const pending = await jsonResult(receipts[0], 202);
  assert.deepEqual(await jsonResult(receipts[1], 202), pending);
  const row = await outboxRow(task.taskId);
  assert.deepEqual(row, {
    variables: { approved: true, decision: "approved", reason: "Output criteria met", note: "done", summary: '{"items":2}' },
    state: "pending", decision: "approved", reason: "Output criteria met",
  });
  await resume(task.taskId);
  const confirmed = await waitFor(async () => { const items = (await history(path)).items; return items.length === 1 && items; });
  const [entry] = confirmed;
  assert.deepEqual({ ...entry, completedAt: undefined }, {
    taskId: task.taskId, stepKey: "review", actorSubject: subjectId, unit, group,
    decision: "approved", reason: "Output criteria met", completedAt: undefined,
  });
  assert.ok(Number.isFinite(Date.parse(entry.completedAt)));
  const instance = await engine(`history/historic-process-instances?${new URLSearchParams({ tenantId: tenant,
    processInstanceId: execution.id, includeProcessVariables: "true", size: "2" })}`);
  assert.deepEqual(instance.data.map(item => item.id), [execution.id]);
  const engineVariables = Object.fromEntries(instance.data[0].variables.map(variable => [variable.name, variable.value]));
  for (const [name, value] of Object.entries({ approved: true, decision: "approved",
    reason: "Output criteria met", note: "done", summary: '{"items":2}' })) {
    assert.deepEqual(engineVariables[name], value, name);
  }
  assert.equal((await lookup(path)).status, "completed");
  assert.equal((await lookup(inbox)).items.some(item => item.taskId === task.taskId), false);
  assert.deepEqual(await jsonResult(await complete(writer, path, body, completionKey), 202), pending);
  assert.equal((await jsonResult(await complete(writer, path, body), 409)).error, "task_already_completed");
});
