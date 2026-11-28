// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { main as provisionDirectory } from "../scripts/provision-directory.mjs";
import { verifyContracts } from "./contract.mjs";
import { createAuthorityFixture } from "./fixtures/authority.mjs";
import { base, issuer, jsonResult, recordTestSupport } from "./record-test-support.mjs";

const prefix = `workflow-delegated-${randomBytes(6).toString("hex")}`;
const key = `delegated_${randomBytes(5).toString("hex")}`;
const tenant = "tenant-a";
const foreignTenant = "tenant-b";
const unitA = `${prefix}-a`, unitB = `${prefix}-b`, unitC = `${prefix}-c`;
const senderGroup = "senders", sendReviewers = "send-reviewers";
const receiverGroup = "receivers", otherGroup = "others";
const clientIds = [], users = [];
const { api: request, sql, q, cleanup } = recordTestSupport(prefix);
const fixture = createAuthorityFixture({ base, prefix, sql, q, clientIds, users,
  api: (path, who, body, headers, method = body === undefined ? "GET" : "POST") => request(path, who, { method, body, headers }) });
const run = (...args) => promisify(execFile)("docker", args, { timeout: 30000 });
const executionPath = id => `/v1/workflows/executions/${encodeURIComponent(id)}`;
const requestKeys = [];
const backends = [];
let deploymentId, definitionId, sender, receiver, third, reader, taskActor, foreign, administrator;
let app1, app2;

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
      body.append("file", new Blob([xml], { type: "application/xml" }), "delegated.bpmn20.xml");
    }
    console.log(JSON.stringify(await workflowRequest(config, path, { method, body })));
  `, path, method, ...(body === undefined ? [] : [JSON.stringify(body)]));
  return JSON.parse(stdout);
}

async function adminCreate(path, body) {
  const response = await fixture.admin(path, body, "POST");
  assert.equal(response.status, 201, await response.clone().text());
  return response.headers.get("location").split("/").at(-1);
}

async function managementClient(name, tenantId) {
  const [template] = await jsonResult(await fixture.admin("clients?clientId=tenant-a"), 200);
  const source = await jsonResult(await fixture.admin(`clients/${template.id}`), 200);
  const mappers = source.protocolMappers.map(({ id, ...mapper }) => mapper);
  mappers.find(mapper => mapper.name === "tenant").config["claim.value"] = tenantId;
  return adminCreate("clients", { clientId: `${prefix}-${name}`, enabled: true, protocol: "openid-connect",
    publicClient: true, standardFlowEnabled: true, directAccessGrantsEnabled: false,
    redirectUris: ["http://127.0.0.1:9876/callback"], attributes: { "pkce.code.challenge.method": "S256" },
    protocolMappers: mappers });
}

function appPathFor(backend) { return `/v1/applications/${backend.app.appId}`; }

before(async () => {
  await provisionDirectory([], { log: () => {} });
  await fixture.operatorToken();
  clientIds.push(await managementClient(`management-${tenant}`, tenant));
  clientIds.push(await managementClient(`management-${foreignTenant}`, foreignTenant));
  const owner = await fixture.human("owner", tenant, ["applications.register"]);
  administrator = await fixture.human("admin", tenant, ["applications.approve", "trust.approve", "audit.read", "directory.write"]);
  sender = await fixture.human("sender", tenant, []);
  receiver = await fixture.human("receiver", tenant, []);
  third = await fixture.human("third", tenant, []);
  reader = await fixture.human("reader", tenant, []);
  taskActor = await fixture.human("task-actor", tenant, []);
  foreign = await fixture.human("foreign", foreignTenant, []);

  // Use the documented Directory write path so units, groups and members are
  // confirmed and synchronized exactly as a real operator deployment would be.
  const put = (path, body) => request(`/v1/directory/${path}`, administrator, { method: "PUT", body })
    .then(response => jsonResult(response, 201));
  await put(`unit-types/${prefix}`, { name: "Workflow delegation test" });
  await put(`units/${unitA}`, { name: "Sender unit", unitType: prefix });
  await put(`units/${unitB}`, { name: "Receiver unit", unitType: prefix });
  await put(`units/${unitC}`, { name: "Third unit", unitType: prefix });
  await put(`units/${unitA}/groups/${senderGroup}`, { name: "Senders" });
  await put(`units/${unitA}/groups/${sendReviewers}`, { name: "Send reviewers" });
  await put(`units/${unitB}/groups/${receiverGroup}`, { name: "Receivers" });
  await put(`units/${unitC}/groups/${otherGroup}`, { name: "Others" });
  await put(`units/${unitA}/members/${sender.id}`, { groups: [senderGroup] });
  await put(`units/${unitB}/members/${receiver.id}`, { groups: [receiverGroup] });
  await put(`units/${unitC}/members/${third.id}`, { groups: [otherGroup] });
  await put(`units/${unitA}/members/${reader.id}`, { groups: [senderGroup] });
  await put(`units/${unitA}/members/${taskActor.id}`, { groups: [sendReviewers] });

  const login = who => fixture.login(who.username, who.password, who.clientId);
  for (const who of [sender, receiver, third, reader, taskActor, foreign]) who.token = await login(who);

  const redirectUri = "http://127.0.0.1:9876/callback";
  app1 = await fixture.backend("app1", owner, administrator, tenant, true, undefined, redirectUri);
  backends.push(app1);
  const appPath = appPathFor(app1);
  await jsonResult(await request(appPath, administrator, { method: "PATCH", headers: { "If-Match": app1.etag },
    body: { ownerUnit: unitA, deploymentUnits: [unitA, unitB, unitC] } }), 200);
  const assign = async (backend, unit, user, role) => request(`${appPathFor(backend)}/assignments`, administrator,
    { method: "POST", body: { unit, targetType: "subject", target: user.id, role } }).then(response => jsonResult(response, 200));
  await assign(app1, unitA, sender, "editor");
  await assign(app1, unitB, receiver, "editor");
  await assign(app1, unitC, third, "editor");
  await assign(app1, unitA, reader, "viewer");
  app2 = await fixture.backend("app2", owner, administrator, tenant, true, undefined, redirectUri);
  backends.push(app2);
  const app2Path = appPathFor(app2);
  await jsonResult(await request(app2Path, administrator, { method: "PATCH", headers: { "If-Match": app2.etag },
    body: { ownerUnit: unitA, deploymentUnits: [unitA] } }), 200);
  await assign(app2, unitA, sender, "editor");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:flowable="http://flowable.org/bpmn"
      targetNamespace="https://example.invalid">
      <process id="${key}" isExecutable="true" name="Cross-unit delegated review">
        <startEvent id="start"/>
        <sequenceFlow id="a" sourceRef="start" targetRef="send"/>
        <userTask id="send" name="Send review" flowable:candidateGroups="${sendReviewers}"/>
        <sequenceFlow id="b" sourceRef="send" targetRef="receive"/>
        <userTask id="receive" name="Receive review" flowable:candidateGroups="${receiverGroup}"/>
        <sequenceFlow id="c" sourceRef="receive" targetRef="end"/>
        <endEvent id="end"/>
      </process>
    </definitions>`;
  deploymentId = (await engine("repository/deployments", "POST", { tenant, xml })).id;
  const deployed = await engine(`repository/process-definitions?${new URLSearchParams({ deploymentId, tenantId: tenant, key })}`);
  assert.equal(deployed.data.length, 1);
  definitionId = deployed.data[0].id;
}, { timeout: 120_000 });

after(async () => {
  try {
    if (deploymentId) {
      await engine(`repository/deployments/${encodeURIComponent(deploymentId)}?cascade=true`, "DELETE").catch(() => {});
    }
    const keys = requestKeys.map(q).join(",") || "NULL";
    const appIds = backends.map(backend => q(backend.app.appId)).join(",") || "NULL";
    const subjects = users.map(q).join(",") || "NULL";
    await sql(`BEGIN;
      DELETE FROM app_private.workflow_completion_outbox WHERE tenant_id=${q(tenant)} AND definition_id=${q(definitionId)};
      DELETE FROM app_private.workflow_task_claims WHERE tenant_id=${q(tenant)} AND execution_id IN
        (SELECT execution_id FROM app_private.workflow_executions WHERE tenant_id=${q(tenant)} AND definition_id=${q(definitionId)});
      DELETE FROM app_private.workflow_executions WHERE tenant_id=${q(tenant)}
        AND (definition_id=${q(definitionId)} OR request_key IN (${keys}));
      DELETE FROM app_private.workflow_delegated_policies WHERE tenant_id=${q(tenant)} AND definition_id=${q(definitionId)};
      DELETE FROM app_private.idempotency_results WHERE tenant_id=${q(tenant)} AND key IN (${keys});
      DELETE FROM app_private.app_assignments WHERE tenant_id=${q(tenant)} AND app_id IN (${appIds});
      DELETE FROM app_private.directory_memberships WHERE tenant_id=${q(tenant)} AND unit IN (${q(unitA)},${q(unitB)},${q(unitC)});
      DELETE FROM app_private.directory_members WHERE tenant_id=${q(tenant)} AND unit IN (${q(unitA)},${q(unitB)},${q(unitC)});
      DELETE FROM app_private.directory_groups WHERE tenant_id=${q(tenant)} AND unit IN (${q(unitA)},${q(unitB)},${q(unitC)});
      DELETE FROM app_private.directory_units WHERE tenant_id=${q(tenant)} AND unit IN (${q(unitA)},${q(unitB)},${q(unitC)});
      DELETE FROM app_private.directory_unit_types WHERE tenant_id=${q(tenant)} AND unit_type=${q(prefix)};
      DELETE FROM app_private.principals WHERE tenant_id IN (${q(tenant)},${q(foreignTenant)}) AND subject IN (${subjects});
      COMMIT;`);
    if (backends.length) {
      await cleanup(backends.map(({ app, subject, clientId }) => ({ appId: app.appId, subject, clientId })));
    }
  } finally {
    await fixture.operatorToken();
    const roots = await jsonResult(await fixture.admin(`groups?search=${tenant}&exact=true`), 200);
    const root = roots.find(group => group.path === `/${tenant}`);
    if (root) for (const entry of await jsonResult(await fixture.admin(`groups/${root.id}/children`), 200)) {
      if ([unitA, unitB, unitC].includes(entry.name)) await fixture.admin(`groups/${entry.id}`, undefined, "DELETE");
    }
    for (const id of users) await fixture.admin(`users/${id}`, undefined, "DELETE");
    for (const id of clientIds) await fixture.admin(`clients/${id}`, undefined, "DELETE");
  }
  await verifyContracts("workflow-delegated");
}, { timeout: 120_000 });

const newKey = () => { const id = randomUUID(); requestKeys.push(id); return id; };
const post = (body, idempotencyKey) => ({ method: "POST", body,
  headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {} });
const exchange = async (backend, user, unit) => {
  const actor = await backend.issueToken();
  const source = await fixture.login(user.username, user.password, backend.clientId, backend.clientSecret);
  const response = await request("/v1/token-exchange", actor, { method: "POST", body: { subjectToken: source } });
  const token = await jsonResult(response, 200);
  const identity = await jsonResult(await request("/v1/identity", token.access_token), 200);
  assert.deepEqual(identity.units, [unit]);
  return token.access_token;
};
const start = (who, body, id = newKey()) => request("/v1/workflows/executions", who, post({ definitionId, ...body }, id));
const lookup = (path, who) => request(path, who);
const setSenderGroups = async groups => {
  administrator.token = await fixture.login(administrator.username, administrator.password, administrator.clientId);
  const response = await request(`/v1/directory/units/${unitA}/members/${sender.id}`, administrator,
    { method: "PUT", body: { groups } });
  assert.ok([200, 201].includes(response.status), await response.clone().text());
};

async function waitFor(poll) {
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    const result = await poll();
    if (result) return result;
    await delay(300);
  }
  assert.fail("Workflow did not reach the expected state");
}

test("delegated cross-unit workflow start, replay, participant reads and denial boundaries", { timeout: 120_000 }, async () => {
  let senderToken = await exchange(app1, sender, unitA);
  let receiverToken = await exchange(app1, receiver, unitB);
  let thirdToken = await exchange(app1, third, unitC);
  const readerToken = await exchange(app1, reader, unitA);
  let otherAppToken = await exchange(app2, sender, unitA);
  // A user without an assignment in this app cannot obtain a delegated token.
  const unassigned = await request("/v1/token-exchange", await app2.issueToken(),
    { method: "POST", body: { subjectToken: receiver.token } });
  assert.equal(unassigned.status, 403);
  assert.equal((await unassigned.json()).error, "not_assigned_to_app");

  // Missing operator policy is denied before any reservation.
  assert.equal((await jsonResult(await start(senderToken, { taskUnits: { receive: unitB } }), 403)).error,
    "workflow_unit_required");
  await sql(`INSERT INTO app_private.workflow_delegated_policies
    (tenant_id,app_id,oauth_client_id,definition_id,sender_unit,sender_group,default_unit,allowed_units)
    VALUES (${q(tenant)},${q(app1.app.appId)},${q(app1.clientId)},${q(definitionId)},${q(unitA)},
      ${q(senderGroup)},${q(unitA)},ARRAY[${q(unitA)},${q(unitB)}]);`);

  // A read-only app assignment cannot start even when the sender group matches.
  assert.equal((await jsonResult(await start(readerToken, { taskUnits: { receive: unitB } }), 403)).error,
    "capability_not_granted");

  // Concurrent same-key requests either reserve once or observe the pending
  // reservation; neither may start a second engine instance.
  const concurrentKey = newKey();
  const concurrentBody = { input: { reference: "CASE-CONCURRENT" }, taskUnits: { receive: unitB } };
  const concurrent = await Promise.all([
    start(senderToken, concurrentBody, concurrentKey),
    start(senderToken, concurrentBody, concurrentKey),
  ]);
  assert.ok(concurrent.every(response => [201, 409].includes(response.status)),
    concurrent.map(response => response.status).join(","));
  const acceptedBodies = await Promise.all(concurrent.filter(response => response.status === 201)
    .map(response => jsonResult(response, 201)));
  assert.ok(acceptedBodies.length >= 1);
  const concurrentExecution = acceptedBodies[0];
  assert.ok(acceptedBodies.every(body => body.id === concurrentExecution.id));
  let recovered = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const replay = await start(senderToken, concurrentBody, concurrentKey);
    if (replay.status === 201) {
      assert.deepEqual(await jsonResult(replay, 201), concurrentExecution);
      recovered = true;
      break;
    }
    assert.equal(replay.status, 409);
    await delay(300);
  }
  assert.equal(recovered, true, "the pending concurrent reservation must recover to the original 201");
  const instances = await engine(`history/historic-process-instances?${new URLSearchParams({
    tenantId: tenant, processDefinitionId: definitionId, includeProcessVariables: "true", size: "100",
  })}`);
  const concurrentInstances = instances.data.filter(item =>
    item.variables?.some(variable => variable.name === "input" &&
      JSON.parse(variable.value).reference === "CASE-CONCURRENT"));
  assert.equal(concurrentInstances.length, 1);
  assert.equal(concurrentInstances[0].id, concurrentExecution.id);

  const startKey = newKey();
  const body = { input: { reference: "CASE-114" }, taskUnits: { receive: unitB } };
  const created = await jsonResult(await start(senderToken, body, startKey), 201);
  assert.deepEqual(await jsonResult(await start(senderToken, body, startKey), 201), created);
  assert.equal((await jsonResult(await start(senderToken, { ...body, input: { reference: "CASE-115" } }, startKey), 422)).error,
    "idempotency_key_reused");

  // Delegated tokens are deliberately short-lived; refresh before each read
  // section so the participant checks run with current credentials.
  senderToken = await exchange(app1, sender, unitA);
  receiverToken = await exchange(app1, receiver, unitB);
  thirdToken = await exchange(app1, third, unitC);
  otherAppToken = await exchange(app2, sender, unitA);
  const path = executionPath(created.id);
  const senderDetail = await jsonResult(await lookup(path, senderToken), 200);
  assert.equal(senderDetail.id, created.id);
  assert.deepEqual((await jsonResult(await lookup(`${path}/history`, senderToken), 200)).items, []);
  const receiverDetail = await jsonResult(await lookup(path, receiverToken), 200);
  assert.equal(receiverDetail.id, created.id);
  assert.deepEqual((await jsonResult(await lookup(`${path}/history`, receiverToken), 200)).items, []);
  // A receiver in another unit has no sender access and cannot reuse the key.
  assert.equal((await jsonResult(await start(receiverToken, body, startKey), 403)).error,
    "workflow_unit_required");

  // Same tenant but a nonparticipant unit, another app sharing the tenant, a
  // foreign tenant and a legacy row without delegated ownership all fail closed.
  assert.equal((await lookup(path, thirdToken)).status, 404);
  assert.equal((await lookup(`${path}/history`, thirdToken)).status, 404);
  assert.equal((await lookup(path, otherAppToken)).status, 404);
  assert.equal((await lookup(executionPath(randomUUID()), senderToken)).status, 404);
  assert.equal((await lookup(path, foreign.token)).status, 404);
  const legacyKey = newKey();
  const legacyExecution = `legacy-${randomBytes(6).toString("hex")}`;
  await sql(`INSERT INTO app_private.workflow_executions
    (tenant_id,caller_scope,request_key,digest,definition_id,definition_key,steps,execution_id,start_result)
    VALUES (${q(tenant)},sha256(convert_to('legacy-delegated-test','UTF8')),${q(legacyKey)},
      sha256(convert_to('legacy-delegated-test','UTF8')),${q(definitionId)},${q(key)},'{}'::jsonb,
      ${q(legacyExecution)},'{"status":201,"value":{}}'::jsonb);`);
  assert.equal((await lookup(executionPath(legacyExecution), senderToken)).status, 404);
  assert.equal((await lookup(`${executionPath(legacyExecution)}/history`, senderToken)).status, 404);

  const checkpoint = (await engine(`repository/process-definitions?${new URLSearchParams({
    tenantId: tenant, key: "junctura_checkpoint", latest: "true",
  })}`)).data[0];
  assert.equal((await jsonResult(await request("/v1/workflows/executions", senderToken,
    post({ definitionId: checkpoint.id, input: {} }, newKey())), 403)).error, "workflow_unit_required");
  assert.equal((await request(path, senderToken, { method: "DELETE" })).status, 403);
  assert.equal((await jsonResult(await request(`${path}/complete`, senderToken,
    post({ taskId: "any-task" }, newKey())), 403)).error, "capability_not_granted");
  assert.equal((await request("/v1/workflows/tasks", senderToken)).status, 403);
  assert.equal((await request("/v1/workflows/definitions", senderToken,
    post({ xml: "<definitions/>" }, newKey()))).status, 403);

  // Complete an authorized candidate task through the existing direct route so
  // both sender (not a candidate) and receiver see real, non-empty history.
  taskActor.token = await fixture.login(taskActor.username, taskActor.password, taskActor.clientId);
  const runtime = await engine(`runtime/tasks?${new URLSearchParams({
    tenantId: tenant, processInstanceId: created.id, size: "10",
  })}`);
  const sendTask = runtime.data.find(task => task.taskDefinitionKey === "send");
  assert.ok(sendTask);
  const completionKey = newKey();
  assert.equal((await request(`${path}/complete`, taskActor,
    post({ taskId: sendTask.id }, completionKey))).status, 202);
  await waitFor(async () => {
    const state = await sql(`SELECT state FROM app_private.workflow_completion_outbox
      WHERE tenant_id=${q(tenant)} AND execution_id=${q(created.id)} AND task_id=${q(sendTask.id)};`);
    return state.trim() === "applied";
  });
  senderToken = await exchange(app1, sender, unitA);
  receiverToken = await exchange(app1, receiver, unitB);
  const senderHistory = await jsonResult(await lookup(`${path}/history`, senderToken), 200);
  const receiverHistory = await jsonResult(await lookup(`${path}/history`, receiverToken), 200);
  assert.equal(senderHistory.items.length, 1);
  assert.equal(senderHistory.items[0].stepKey, "send");
  assert.deepEqual(receiverHistory.items, senderHistory.items);
  // Direct operator/audit history is unchanged and still tenant-scoped.
  administrator.token = await fixture.login(administrator.username, administrator.password, administrator.clientId);
  assert.equal((await jsonResult(await lookup(path, administrator), 200)).id, created.id);
  assert.deepEqual((await jsonResult(await lookup(`${path}/history`, administrator), 200)).items,
    senderHistory.items);

  // Policy retirement denies replay. Recreating the policy but losing the
  // sender group in the still-assigned unit also denies replay and reads.
  senderToken = await exchange(app1, sender, unitA);
  await sql(`DELETE FROM app_private.workflow_delegated_policies
    WHERE tenant_id=${q(tenant)} AND app_id=${q(app1.app.appId)} AND definition_id=${q(definitionId)} AND sender_unit=${q(unitA)};`);
  assert.equal((await jsonResult(await start(senderToken, body, startKey), 403)).error,
    "workflow_unit_required");
  await sql(`INSERT INTO app_private.workflow_delegated_policies
    (tenant_id,app_id,oauth_client_id,definition_id,sender_unit,sender_group,default_unit,allowed_units)
    VALUES (${q(tenant)},${q(app1.app.appId)},${q(app1.clientId)},${q(definitionId)},${q(unitA)},
      ${q(senderGroup)},${q(unitA)},ARRAY[${q(unitA)},${q(unitB)}]);`);

  // Changing the policy sender group after start cannot switch the persisted
  // execution away from its original sender group. The current policy group
  // passes, but the original run.sender_group no longer does.
  await setSenderGroups([senderGroup, sendReviewers]);
  senderToken = await exchange(app1, sender, unitA);
  await sql(`UPDATE app_private.workflow_delegated_policies SET sender_group=${q(sendReviewers)},updated_at=clock_timestamp()
    WHERE tenant_id=${q(tenant)} AND app_id=${q(app1.app.appId)} AND definition_id=${q(definitionId)} AND sender_unit=${q(unitA)};`);
  await setSenderGroups([sendReviewers]);
  assert.equal((await jsonResult(await start(senderToken, body, startKey), 403)).error,
    "workflow_unit_required");

  // Losing the current policy sender group also denies replay, and the stale
  // token cannot read the execution through the routed candidate group.
  await setSenderGroups([]);
  assert.equal((await jsonResult(await start(senderToken, body, startKey), 403)).error,
    "workflow_unit_required");
  assert.equal((await lookup(path, senderToken)).status, 404);
  assert.equal((await lookup(`${path}/history`, senderToken)).status, 404);
  receiverToken = await exchange(app1, receiver, unitB);
  assert.equal((await jsonResult(await lookup(path, receiverToken), 200)).id, created.id);

  // Revocation is rechecked from the current assignment on every read.
  const receiverAssignment = await sql(`SELECT assignment_id FROM app_private.app_assignments
    WHERE tenant_id=${q(tenant)} AND app_id=${q(app1.app.appId)} AND unit=${q(unitB)}
      AND target_type='subject' AND target=${q(receiver.id)} AND enabled;`);
  administrator.token = await fixture.login(administrator.username, administrator.password, administrator.clientId);
  assert.equal((await request(`${appPathFor(app1)}/assignments/${receiverAssignment.trim()}`, administrator,
    { method: "DELETE" })).status, 204);
  assert.equal((await jsonResult(await lookup(path, receiverToken), 403)).error, "not_assigned_to_app");
  assert.equal((await jsonResult(await lookup(`${path}/history`, receiverToken), 403)).error, "not_assigned_to_app");
}, { timeout: 120_000 });
