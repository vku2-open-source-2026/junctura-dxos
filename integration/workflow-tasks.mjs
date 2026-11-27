// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { createAuthorityFixture } from "./fixtures/authority.mjs";
import { verifyContracts } from "./contract.mjs";
import { base, issuer, jsonResult, recordTestSupport } from "./record-test-support.mjs";

const suffix = randomBytes(5).toString("hex");
const prefix = `workflow-${suffix}`;
const key = `workflow_${suffix}`;
const tenant = "tenant-a";
const unit = `${prefix}-unit`;
const wrongUnit = `${prefix}-other`;
const group = "reviewers";
const preferredGroup = "first-reviewers";
const subjectId = `${prefix}:writer`;
const collection = `entries_${suffix}`;
const appId = randomUUID();
const clientIds = [];
const users = [];
const { api, q, cleanup, createBackend } = recordTestSupport(prefix);
const run = (...args) => promisify(execFile)("docker", args, { timeout: 30000 });
const sql = source => run("compose", "exec", "-T", "database", "psql", "-U", "junctura_admin", "-d", "junctura_data",
  "-XAtq", "-v", "ON_ERROR_STOP=1", "-c", source);
const fixture = createAuthorityFixture({ base, prefix, q, sql, api, clientIds, users });
const { admin, login, human, verifiedSubject, createUser } = fixture;
const executionPath = id => `/v1/workflows/executions/${encodeURIComponent(id)}`;
const taskPath = id => `/v1/workflows/tasks/${encodeURIComponent(id)}`;
const post = (body, idempotencyKey) => ({ method: "POST", body, headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {} });
const remove = { method: "DELETE" };
const inbox = `/v1/workflows/tasks?definitionKey=${key}`;
const trigger = `delay_completion_${suffix}`;
const requestKeys = [];
const rejectedKeys = [];
const checkpointRuns = [];
const publishedDeployments = [];
let deploymentId, definitionId, writer, peer, outsider, auditor, operator, backend;

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
      body.append("file", new Blob([xml], { type: "application/xml" }), "parallel.bpmn20.xml");
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

// A real tenant administrator with the operator-enrolled console-admin role and
// the MFA-enforced OIDC direct grant from integration/admin-mfa.mjs. The token
// is minted on use so a long suite never publishes with a stale credential.
async function operatorAccount() {
  const secret = randomBytes(20).toString("base64url");
  const user = await createUser("operator", { tenant, credentials: [{ type: "otp",
    userLabel: "Fixture authenticator", secretData: JSON.stringify({ value: secret }),
    credentialData: JSON.stringify({ subType: "totp", digits: 6, period: 30, algorithm: "HmacSHA1", counter: 0 }) }] });
  const [root] = await (await admin(`groups?search=${tenant}&exact=true`)).json();
  assert.equal((await admin(`users/${user.id}/groups/${root.id}`, undefined, "PUT")).status, 204);
  const roles = await Promise.all(["core-reader", "core-writer"].map(async name => (await admin(`roles/${name}`)).json()));
  assert.equal((await admin(`users/${user.id}/role-mappings/realm`, roles, "POST")).status, 204);
  const [consoleClient] = await (await admin("clients?clientId=junctura-console")).json();
  const role = await (await admin(`clients/${consoleClient.id}/roles/console-admin`)).json();
  assert.equal((await admin(`users/${user.id}/role-mappings/clients/${consoleClient.id}`, [role], "POST")).status, 204);
  return { ...user, secret };
}

function operatorGrant(account) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", account.secret).update(counter).digest();
  const offset = digest.at(-1) & 0xf;
  const otp = ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
  return fetch(`${issuer}/protocol/openid-connect/token`, { method: "POST", signal: AbortSignal.timeout(10_000),
    body: new URLSearchParams({ grant_type: "password", client_id: "junctura-console", username: account.username,
      password: account.password, otp }) });
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
  peer = await human("peer", tenant, []);
  outsider = await human("outsider", tenant, []);
  auditor = await human("auditor", tenant, ["audit.read"]);
  const [root] = await (await admin(`groups?search=${tenant}&exact=true`)).json();
  const unitGroup = await adminCreate(`groups/${root.id}/children`, { name: unit });
  const otherUnitGroup = await adminCreate(`groups/${root.id}/children`, { name: wrongUnit });
  const candidate = await adminCreate(`groups/${unitGroup}/children`, { name: group });
  const preferred = await adminCreate(`groups/${unitGroup}/children`, { name: preferredGroup });
  const wrongCandidate = await adminCreate(`groups/${otherUnitGroup}/children`, { name: group });
  for (const [who, groupId] of [[writer, candidate], [writer, preferred], [peer, candidate], [outsider, wrongCandidate]]) {
    assert.equal((await admin(`users/${who.id}/groups/${groupId}`, undefined, "PUT")).status, 204);
  }
  writer = await verifiedSubject(writer, subjectId);
  for (const who of [peer, outsider]) who.token = await login(who.username, who.password, who.clientId);
  assert.equal((await jsonResult(await api("/v1/identity", writer), 200)).subjectId, subjectId);
  assert.deepEqual((await jsonResult(await api("/v1/identity", outsider), 200)).groups, [`/${wrongUnit}/${group}`]);
  backend = await createBackend("backend");
  operator = await operatorAccount();
  const provider = `https://${prefix}.example.invalid`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:flowable="http://flowable.org/bpmn" targetNamespace="https://example.invalid">
      <process id="${key}" isExecutable="true" name="Parallel review">
        <startEvent id="start"/>
        <sequenceFlow id="a" sourceRef="start" targetRef="split"/>
        <parallelGateway id="split"/>
        <sequenceFlow id="b" sourceRef="split" targetRef="first"/>
        <sequenceFlow id="c" sourceRef="split" targetRef="second"/>
        <userTask id="first" name="First review" flowable:candidateGroups="${preferredGroup},${group}"/>
        <userTask id="second" name="Second review" flowable:candidateGroups="${group}"/>
        <sequenceFlow id="d" sourceRef="first" targetRef="join"/>
        <sequenceFlow id="e" sourceRef="second" targetRef="join"/>
        <parallelGateway id="join"/>
        <sequenceFlow id="f" sourceRef="join" targetRef="end"/>
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
      VALUES (${q(tenant)},${q(prefix)},'Workflow test',1,1);
    INSERT INTO app_private.directory_units (tenant_id,unit,unit_type,name,generation,synced_generation)
      VALUES (${q(tenant)},${q(unit)},${q(prefix)},'Fixture unit',1,1),
             (${q(tenant)},${q(wrongUnit)},${q(prefix)},'Other fixture unit',1,1);
    INSERT INTO app_private.directory_groups (tenant_id,unit,unit_group,name,generation,synced_generation)
      VALUES (${q(tenant)},${q(unit)},${q(preferredGroup)},'First reviewers',1,1),
             (${q(tenant)},${q(unit)},${q(group)},'Reviewers',1,1),
             (${q(tenant)},${q(wrongUnit)},${q(group)},'Other reviewers',1,1);
    INSERT INTO app_private.workflow_definition_policies (tenant_id,definition_id,default_unit,allowed_units)
      VALUES (${q(tenant)},${q(definitionId)},${q(unit)},ARRAY[${q(unit)}]);
    INSERT INTO app_private.applications (tenant_id,app_id,issuer,oauth_client_id,owner_subject,provider_origin,display_name,state,digest)
      VALUES (${q(tenant)},${q(appId)},${q(issuer)},${q(writer.clientId)},${q(writer.id)},${q(provider)},'Workflow fixture','active','sha256:${"0".repeat(64)}');
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
  await jsonResult(await api(`/v2/data-schemas/${collection}`, writer, { method: "PUT", body: {
    schema: { type: "object", required: ["code"], properties: { code: { type: "string" } } },
    indexed: ["code"], uniqueKey: "code", sensitive: [], searchable: [],
  } }), 200);
}, { timeout: 120000 });

after(async () => {
  try {
    for (const id of publishedDeployments) {
      await engine(`repository/deployments/${encodeURIComponent(id)}?cascade=true`, "DELETE");
    }
    for (const id of checkpointRuns) {
      const path = `history/historic-process-instances/${encodeURIComponent(id)}`;
      const run = await engine(path);
      if (!run.endTime) await engine(`runtime/process-instances/${encodeURIComponent(id)}`, "DELETE");
      await engine(path, "DELETE");
    }
    if (deploymentId) await engine(`repository/deployments/${encodeURIComponent(deploymentId)}?cascade=true`, "DELETE");
    const keys = requestKeys.map(q).join(",") || "NULL";
    await sql(`
      DROP TRIGGER IF EXISTS ${trigger} ON app_private.workflow_completion_outbox;
      DROP FUNCTION IF EXISTS app_private.${trigger}();
      DELETE FROM app_private.workflow_completion_outbox WHERE tenant_id=${q(tenant)} AND definition_id=${q(definitionId)};
      DELETE FROM app_private.workflow_task_claims WHERE tenant_id=${q(tenant)} AND execution_id IN
        (SELECT execution_id FROM app_private.workflow_executions WHERE tenant_id=${q(tenant)} AND definition_id=${q(definitionId)});
      DELETE FROM app_private.workflow_executions WHERE tenant_id=${q(tenant)}
        AND (definition_id=${q(definitionId)} OR request_key IN (${keys}));
      DELETE FROM app_private.workflow_definition_policies WHERE tenant_id=${q(tenant)} AND definition_id=${q(definitionId)};
      DELETE FROM app_private.directory_groups WHERE tenant_id=${q(tenant)} AND unit IN (${q(unit)},${q(wrongUnit)});
      DELETE FROM app_private.directory_units WHERE tenant_id=${q(tenant)} AND unit IN (${q(unit)},${q(wrongUnit)});
      DELETE FROM app_private.directory_unit_types WHERE tenant_id=${q(tenant)} AND unit_type=${q(prefix)};
      DELETE FROM app_private.idempotency_results WHERE tenant_id=${q(tenant)} AND key IN (${keys});
      DELETE FROM core.workflow_requests WHERE tenant_id=${q(tenant)} AND key IN (${keys});
    `);
    if (writer) await cleanup([{ appId, subject: writer.id, clientId: writer.clientId },
      ...(backend ? [backend] : [])]);
    await fixture.cleanupSubjectBindings();
  } finally {
    await fixture.operatorToken();
    const roots = await (await admin(`groups?search=${tenant}&exact=true`)).json();
    const root = roots.find(group => group.path === `/${tenant}`);
    if (root) for (const entry of await (await admin(`groups/${root.id}/children`)).json()) {
      if ([unit, wrongUnit].includes(entry.name)) await admin(`groups/${entry.id}`, undefined, "DELETE");
    }
    for (const id of users) await admin(`users/${id}`, undefined, "DELETE");
    for (const id of clientIds) await admin(`clients/${id}`, undefined, "DELETE");
  }
  await verifyContracts("workflow-tasks");
}, { timeout: 120000 });

const newKey = () => { const id = randomUUID(); requestKeys.push(id); return id; };
const start = (who, body, id = newKey()) =>
  api("/v1/workflows/executions", who, post({ definitionId, ...body }, id));
const complete = (who, path, body, id = newKey()) => api(`${path}/complete`, who, post(body, id));
const lookup = async (path, who = writer) => jsonResult(await api(path, who), 200);
const history = path => lookup(`${path}/history`);
const resume = (taskId) => sql(`UPDATE app_private.workflow_completion_outbox SET available_at=clock_timestamp()
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

test("HTTP deadlines, parallel inbox, claims, atomic records and confirmed task history", { timeout: 90000 }, async () => {
  assert.equal((await jsonResult(await start(outsider), 403)).error, "workflow_unit_required");
  await jsonResult(await start(writer, { taskDueAt: { absent: "2030-01-01T00:00:00Z" } }), 400);
  await jsonResult(await start(writer, { dueAt: "2030-02-30T00:00:00Z" }), 400);
  const dueAt = "2030-01-12T12:00:00Z";
  const taskDueAt = "2020-01-10T09:00:00Z";
  const startBody = { dueAt, taskUnits: { second: unit }, taskDueAt: { first: taskDueAt } };
  const startKey = newKey();
  const starts = await Promise.all([start(writer, startBody, startKey), start(writer, startBody, startKey)]);
  const execution = await jsonResult(starts.find(response => response.status === 201), 201);
  assert.ok(starts.every(response => [201, 409].includes(response.status)));
  assert.deepEqual(await jsonResult(await start(writer, startBody, startKey), 201), execution);
  const instances = await engine(`history/historic-process-instances?${new URLSearchParams({ tenantId: tenant, processDefinitionId: definitionId })}`);
  assert.deepEqual(instances.data.map(instance => instance.id), [execution.id]);
  assert.equal((await jsonResult(await start(writer, { ...startBody, dueAt: "2030-01-13T12:00:00Z" }, startKey), 422)).error, "idempotency_key_reused");
  const path = executionPath(execution.id);
  assert.equal(Date.parse((await lookup(path)).dueAt), Date.parse(dueAt));
  const page = await lookup(`${inbox}&limit=1`);
  const [first] = page.items;
  const { items: [second] } = await lookup(`${inbox}&limit=1&cursor=${page.nextCursor}`);
  assert.deepEqual([first.stepKey, second.stepKey], ["first", "second"]);
  assert.equal(Date.parse(first.dueAt), Date.parse(taskDueAt));
  assert.equal(Date.parse(second.dueAt), Date.parse(dueAt));
  assert.deepEqual((await lookup(`${inbox}&overdue=true&unit=${unit}&candidateGroup=${preferredGroup}`)).items, [first]);
  assert.deepEqual((await lookup(inbox, outsider)).items, []);
  assert.equal((await jsonResult(await api(`${path}/history`, outsider), 403)).error, "task_group_required");
  assert.deepEqual((await lookup(`${path}/history`, auditor)).items, []);
  assert.equal((await jsonResult(await complete(outsider, path, { taskId: first.taskId }), 403)).error, "task_group_required");
  await jsonResult(await api(`${path}/complete`, writer, post({})), 400);
  await jsonResult(await complete(writer, path, { taskId: first.taskId, variables: { label: "é".repeat(2050) } }), 413);
  await jsonResult(await complete(writer, path, { taskId: first.taskId, variables: { label: [] } }), 400);
  const claim = (who, body) => api(`${taskPath(first.taskId)}/claim`, who, post(body));
  const release = (who) => api(`${taskPath(first.taskId)}/release`, who, post());
  await jsonResult(await claim(writer, { ttlSeconds: 28801 }), 400);
  const [claimA, claimB] = await Promise.all([claim(writer), claim(peer)]);
  assert.deepEqual([claimA.status, claimB.status].sort(), [200, 409]);
  const holder = claimA.status === 200 ? writer : peer;
  const competitor = holder === writer ? peer : writer;
  const accepted = await (claimA.status === 200 ? claimA : claimB).json();
  assert.ok(Math.abs(Date.parse(accepted.claimedUntil) - Date.now() - 1800000) < 10000);
  assert.deepEqual(await jsonResult(await claim(holder, { ttlSeconds: 28800 }), 200), accepted);
  assert.equal((await jsonResult(await complete(competitor, path, { taskId: first.taskId }), 409)).error, "task_claimed");
  const filtered = (await lookup(inbox)).items.find(task => task.taskId === first.taskId);
  assert.equal(filtered.claimedBy, accepted.claimedBy);
  assert.equal((await release(holder)).status, 204);
  assert.equal((await release(holder)).status, 204);
  await jsonResult(await claim(peer, { ttlSeconds: 28800 }), 200);
  await sql(`UPDATE app_private.workflow_task_claims SET expires_at='-infinity' WHERE tenant_id=${q(tenant)} AND task_id=${q(first.taskId)};`);
  await jsonResult(await claim(writer), 200);

  const record = { collection, data: { code: "accepted" } };
  const invalid = { taskId: first.taskId, records: [record, { collection, data: {} }] };
  const invalidKey = newKey();
  const recordError = await jsonResult(await complete(writer, path, invalid, invalidKey), 422);
  assert.equal(recordError.error, "schema_violation");
  assert.equal(recordError.issues[0].path, "/records/1/data/code");
  const countRecords = async () => (await sql(`SELECT count(*) FROM core.app_records WHERE owner_app_id=${q(appId)};`)).stdout.trim();
  assert.equal(await countRecords(), "0");
  const body = { taskId: first.taskId, variables: { decision: "approved", reason: "Criteria met", approved: true }, records: [record] };
  const completeKey = newKey();
  const receipts = await Promise.all([complete(writer, path, body, completeKey), complete(writer, path, body, completeKey)]);
  const pending = await jsonResult(receipts[0], 202);
  assert.deepEqual(await jsonResult(receipts[1], 202), pending);
  assert.equal(await countRecords(), "1");
  assert.deepEqual((await history(path)).items, []);
  assert.equal((await jsonResult(await api(path, writer, remove), 409)).error, "task_conflict");
  assert.deepEqual((await lookup(inbox)).items.map(task => task.taskId), [second.taskId]);
  assert.equal((await jsonResult(await complete(writer, path, { ...body, variables: { decision: "denied" } }, completeKey), 422)).error, "idempotency_key_reused");
  assert.equal((await jsonResult(await complete(writer, path, { taskId: second.taskId }, completeKey), 422)).error, "idempotency_key_reused");

  await jsonResult(await complete(peer, path, { taskId: second.taskId, variables: { decision: "reviewed" } }), 202);
  // Apply one task exactly as the worker would, then make the worker recover the
  // already-committed engine transition without observing its HTTP response.
  const { stdout } = await sql(`SELECT marker FROM app_private.workflow_completion_outbox
    WHERE tenant_id=${q(tenant)} AND task_id=${q(second.taskId)};`);
  await engine(`runtime/tasks/${encodeURIComponent(second.taskId)}`, "POST", { action: "complete",
    variables: [{ name: "__junctura_completion", type: "string", scope: "local", value: stdout.trim() }] });
  await Promise.all([resume(first.taskId), resume(second.taskId)]);
  const confirmed = await waitFor(async () => { const entries = (await history(path)).items; return entries.length === 2 && entries; });
  const entry = confirmed.find(item => item.taskId === first.taskId);
  assert.deepEqual({ ...entry, completedAt: undefined }, {
    taskId: first.taskId, stepKey: "first", actorSubject: subjectId, unit, group: preferredGroup,
    decision: "approved", reason: "Criteria met", completedAt: undefined,
  });
  assert.ok(Number.isFinite(Date.parse(entry.completedAt)));
  const firstHistory = await lookup(`${path}/history?limit=1`);
  const rest = await lookup(`${path}/history?limit=1&cursor=${firstHistory.nextCursor}`);
  assert.deepEqual([...firstHistory.items, ...rest.items], confirmed);
  assert.equal(rest.nextCursor, null);
  assert.equal((await lookup(path)).status, "completed");
  assert.deepEqual(await jsonResult(await complete(writer, path, body, completeKey), 202), pending);
  assert.equal((await jsonResult(await complete(writer, path, body), 409)).error, "task_already_completed");
  assert.equal(await countRecords(), "1");
});

test("confirmed cancellation and an engine-deleted task never create completion history", { timeout: 90000 }, async () => {
  const normal = await jsonResult(await start(writer), 201);
  const normalPath = executionPath(normal.id);
  assert.equal((await lookup(normalPath)).dueAt, null);
  const dated = await jsonResult(await start(writer, { dueAt: "2030-01-10T09:00:00Z" }), 201);
  const inboxTasks = (await lookup(inbox)).items;
  assert.deepEqual(inboxTasks.map(task => task.executionId), [dated.id, dated.id, normal.id, normal.id]);
  assert.ok(inboxTasks.filter(task => task.executionId === normal.id).every(task => task.dueAt === null && !task.overdue));
  assert.equal((await api(executionPath(dated.id), writer, remove)).status, 204);
  assert.equal((await api(normalPath, writer, remove)).status, 204);
  assert.equal((await api(normalPath, writer, remove)).status, 204);
  const cancelled = await jsonResult(await start(writer), 201);
  const path = executionPath(cancelled.id);
  const [task] = (await lookup(inbox)).items;
  assert.equal(task.executionId, cancelled.id);
  const receiptKey = newKey();
  const body = { taskId: task.taskId };
  const receipt = await jsonResult(await complete(writer, path, body, receiptKey), 202);
  await engine(`runtime/process-instances/${encodeURIComponent(cancelled.id)}?deleteReason=fixture-cancelled`, "DELETE");
  await resume(task.taskId);
  await waitFor(async () => {
    const { stdout } = await sql(`SELECT state FROM app_private.workflow_completion_outbox
      WHERE tenant_id=${q(tenant)} AND task_id=${q(task.taskId)};`);
    return stdout.trim() === "cancelled";
  });
  assert.equal((await lookup(path)).status, "cancelled");
  assert.deepEqual((await history(path)).items, []);
  assert.deepEqual(await jsonResult(await complete(writer, path, body, receiptKey), 202), receipt);
});

test("legacy and deadline-aware checkpoints return empty history and the same key conflict", { timeout: 90000 }, async () => {
  const { items } = await lookup("/v1/workflows/definitions");
  const checkpoint = items.find(item => item.key === "junctura_checkpoint");
  assert.ok(checkpoint);
  const legacyBody = { definitionId: checkpoint.id, input: { fixture: prefix } };
  const datedBody = { ...legacyBody, dueAt: "2030-01-10T09:00:00Z" };
  const startCheckpoint = (body, key) => api("/v1/workflows/executions", writer, post(body, key));
  const expectConflict = async (body, key) =>
    assert.equal((await jsonResult(await startCheckpoint(body, key), 409)).error, "idempotency_conflict");

  const legacyKey = newKey();
  const legacy = await jsonResult(await startCheckpoint(legacyBody, legacyKey), 201);
  checkpointRuns.push(legacy.id);
  const legacyPath = executionPath(legacy.id);
  assert.deepEqual((await history(legacyPath)).items, []);
  assert.deepEqual(await jsonResult(await startCheckpoint(legacyBody, legacyKey), 200), legacy);
  await expectConflict(datedBody, legacyKey);
  assert.equal((await jsonResult(await api(`${legacyPath}/complete`, writer, post({})), 200)).status, "completed");
  assert.deepEqual((await history(legacyPath)).items, []);

  const datedKey = newKey();
  const dated = await jsonResult(await startCheckpoint(datedBody, datedKey), 201);
  checkpointRuns.push(dated.id);
  const datedPath = executionPath(dated.id);
  assert.deepEqual((await history(datedPath)).items, []);
  assert.deepEqual(await jsonResult(await startCheckpoint(datedBody, datedKey), 201), dated);
  await expectConflict({ ...datedBody, dueAt: "2030-01-11T09:00:00Z" }, datedKey);
  await expectConflict(legacyBody, datedKey);
  assert.equal((await jsonResult(await api(`${datedPath}/complete`, writer, post({})), 200)).status, "completed");
});

test("two reconcilers compete for one real lease and send exactly one Flowable completion", { timeout: 90000 }, async () => {
  const execution = await jsonResult(await start(writer), 201);
  const path = executionPath(execution.id);
  const [task] = (await lookup(inbox)).items;
  assert.equal(task.executionId, execution.id);
  await jsonResult(await complete(writer, path, { taskId: task.taskId }), 202);
  assert.deepEqual((await history(path)).items, []);

  // Restrict this row to the two fixture workers so the already running Core cannot take the lease.
  const policy = `worker_race_${suffix}`;
  await sql(`CREATE POLICY ${policy} ON app_private.workflow_completion_outbox
    AS RESTRICTIVE FOR SELECT TO junctura_app_owner
    USING (tenant_id <> ${q(tenant)} OR task_id <> ${q(task.taskId)}
      OR nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role' IS DISTINCT FROM 'junctura_workflow_worker'
      OR nullif(current_setting('request.headers', true), '')::jsonb->>'x-workflow-race' = ${q(suffix)});`);
  try {
    await resume(task.taskId);
    await run("compose", "exec", "-T", "core", "node", "--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { startWorkflowReconciler } from "./src/modules/workflow/tasks.mjs";
      const [tag, taskId] = process.argv.slice(1);
      const config = { workflowUrl: process.env.WORKFLOW_URL, workflowPassword: process.env.WORKFLOW_ADMIN_PASSWORD,
        dataUrl: process.env.DATA_URL, dataSecret: process.env.DATA_JWT_SECRET };
      const upstream = globalThis.fetch;
      const responses = [];
      const writes = [];
      let contenders = 0;
      const ready = Promise.withResolvers();
      const leased = Promise.withResolvers();
      const settled = Promise.withResolvers();
      globalThis.fetch = async (url, options) => {
        if (url.endsWith("/rpc/workflow_worker_command")) {
          const { operation, payload } = JSON.parse(options.body);
          if (operation === "lease") {
            if (++contenders === 2) ready.resolve();
            await ready.promise;
          }
          const response = await upstream(url, { ...options, headers: { ...options.headers, "X-Workflow-Race": tag } });
          const result = await response.clone().json();
          if (operation === "lease") {
            responses.push(result);
            // Let both real lease calls return before the winner can finish the job.
            if (responses.length === 2) {
              for (const stop of stops) stop();
              leased.resolve();
            }
            await leased.promise;
          } else if (operation === "settle") {
            settled.resolve({ payload, result });
          }
          return response;
        }
        if (options.method === "POST" && JSON.parse(options.body).action === "complete") writes.push(url);
        return upstream(url, options);
      };
      const stops = [startWorkflowReconciler(config, 10), startWorkflowReconciler(config, 10)];
      const timeout = setTimeout(() => settled.reject(new Error("two-worker reconciliation timed out")), 15000);
      try {
        const { payload, result } = await settled.promise;
        assert.equal(responses.length, 2);
        assert.ok(responses.every(response => response.status === 200));
        const jobs = responses.map(response => response.value);
        assert.equal(jobs.filter(job => job === null).length, 1);
        const [job] = jobs.filter(Boolean);
        assert.equal(job.task_id, taskId);
        assert.equal(payload.lease, job.lease);
        assert.equal(payload.state, "applied");
        assert.equal(result.status, 204);
        assert.deepEqual(writes, [config.workflowUrl + "/runtime/tasks/" + encodeURIComponent(taskId)]);
      } finally {
        clearTimeout(timeout);
        for (const stop of stops) stop();
      }
    `, suffix, task.taskId);
    const { stdout } = await sql(`SELECT state, attempts FROM app_private.workflow_completion_outbox
      WHERE tenant_id=${q(tenant)} AND task_id=${q(task.taskId)};`);
    assert.equal(stdout.trim(), "applied|1");
    assert.deepEqual((await history(path)).items.map(entry => entry.taskId), [task.taskId]);
  } finally {
    await sql(`DROP POLICY ${policy} ON app_private.workflow_completion_outbox;`);
  }
  assert.equal((await api(path, writer, remove)).status, 204);
});

test("concurrent cancel and complete requests admit exactly one transition", { timeout: 90000 }, async () => {
  const execution = await jsonResult(await start(writer), 201);
  const path = executionPath(execution.id);
  const [task] = (await lookup(inbox)).items;
  assert.equal(task.executionId, execution.id);
  const [completion, cancellation] = await Promise.all([
    complete(writer, path, { taskId: task.taskId }), api(path, writer, remove),
  ]);
  const { stdout } = await sql(`SELECT state FROM app_private.workflow_completion_outbox
    WHERE tenant_id=${q(tenant)} AND task_id=${q(task.taskId)};`);
  if (completion.status === 202) {
    assert.equal((await jsonResult(cancellation, 409)).error, "task_conflict");
    assert.equal(stdout.trim(), "pending");
    assert.equal((await lookup(path)).status, "running");
  } else {
    assert.equal(cancellation.status, 204);
    assert.equal((await jsonResult(completion, 409)).error, "task_conflict");
    assert.equal(stdout.trim(), "");
    assert.equal((await lookup(path)).status, "cancelled");
  }
  assert.deepEqual((await history(path)).items, []);
});

test("publishing a business definition is tenant-scoped, policy-checked and replay-defined", { timeout: 120000 }, async () => {
  const packKey = `pack_${suffix}`;
  const publishXml = name => `<?xml version="1.0" encoding="UTF-8"?>
    <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:flowable="http://flowable.org/bpmn" targetNamespace="https://example.invalid">
      <process id="${packKey}" isExecutable="true" name="${name}">
        <startEvent id="start"/>
        <sequenceFlow id="a" sourceRef="start" targetRef="review"/>
        <userTask id="review" name="Review" flowable:candidateGroups="reviewers"/>
        <sequenceFlow id="b" sourceRef="review" targetRef="end"/>
        <endEvent id="end"/>
      </process>
    </definitions>`;
  const publish = (who, body, id = newKey()) => api("/v1/workflows/definitions", who, post(body, id));
  const latest = async () => (await engine(`repository/process-definitions?${
    new URLSearchParams({ key: packKey, tenantId: tenant, latest: "true" })}`)).data[0];
  const allVersions = async () => (await engine(`repository/process-definitions?${
    new URLSearchParams({ key: packKey, tenantId: tenant })}`)).data.length;
  // Only the verified direct tenant administrator may publish; ordinary writers,
  // enrolled backends and delegated actors are rejected before any ledger row or
  // engine request. Every rejection must leave zero durable writes behind.
  const denied = async (who, code) => {
    const key = newKey();
    rejectedKeys.push(key);
    assert.equal((await jsonResult(await publish(who, { xml: publishXml("Pack approval") }, key), 403)).error, code);
  };
  const publisher = { token: (await (await operatorGrant(operator)).json()).access_token };
  assert.equal((await jsonResult(await api("/v1/identity", publisher), 200)).consoleRole, "admin");
  await denied(writer, "operator_required");
  await denied(auditor, "operator_required");
  await denied(backend, "operator_required");
  assert.equal((await sql(`SELECT count(*) FROM core.workflow_requests
    WHERE tenant_id=${q(tenant)} AND key IN (${rejectedKeys.map(q).join(",")});`)).stdout.trim(), "0");
  assert.equal((await latest())?.tenantId, undefined);

  assert.equal((await jsonResult(await publish(publisher, { xml: publishXml("Pack approval"), tenantId: "tenant-b" }), 400)).error,
    "invalid_workflow_request");
  const rejected = await jsonResult(await publish(publisher, { xml: publishXml("Pack approval")
    .replace("</definitions>", "<!DOCTYPE definitions [ <!ENTITY x \"y\"> ]></definitions>") }), 400);
  assert.equal(rejected.error, "definition_invalid");
  assert.ok(rejected.problems.some(problem => problem.rule === "doctype_forbidden"));

  // A reserved ledger row without a deployed result is a defined pending conflict
  // for every caller; only the reserving request may deploy.
  const pendingKey = newKey();
  await sql(`INSERT INTO core.workflow_requests (tenant_id, key, definition_id, input_hash)
    VALUES (${q(tenant)},${q(pendingKey)},${q(packKey)},${
      q(createHash("sha256").update(publishXml("Pack approval")).digest("hex"))});`);
  assert.equal((await jsonResult(await publish(publisher, { xml: publishXml("Pack approval") }, pendingKey), 409)).error,
    "deployment_pending_reconciliation");
  assert.equal((await latest())?.tenantId, undefined);
  await sql(`DELETE FROM core.workflow_requests WHERE tenant_id=${q(tenant)} AND key=${q(pendingKey)};`);

  const firstKey = newKey();
  const first = await jsonResult(await publish(publisher, { xml: publishXml("Pack approval") }, firstKey), 201);
  assert.deepEqual(Object.keys(first).sort(), ["id", "key", "version"]);
  assert.equal(first.key, packKey);
  const deployed = await latest();
  assert.equal(deployed.id, first.id);
  assert.equal(deployed.tenantId, tenant);
  publishedDeployments.push(deployed.deploymentId);
  assert.ok((await lookup("/v1/workflows/definitions")).items.some(item => item.key === packKey));

  assert.deepEqual(await jsonResult(await publish(publisher, { xml: publishXml("Pack approval") }, firstKey), 200), first);
  assert.equal(await latest().then(item => item.id), first.id);
  assert.equal((await jsonResult(await publish(publisher, { xml: publishXml("Pack approval changed") }, firstKey), 409)).error,
    "idempotency_conflict");

  // Changed content under a new key deploys the next version; two simultaneous
  // requests with one stable key deploy exactly once and settle on durable state.
  const changed = await jsonResult(await publish(publisher, { xml: publishXml("Pack approval changed") }), 201);
  assert.equal(changed.version, first.version + 1);
  publishedDeployments.push((await latest()).deploymentId);
  assert.deepEqual(await jsonResult(await publish(publisher, { xml: publishXml("Pack approval") }, firstKey), 200), first);

  const stableKey = newKey();
  const [left, right] = await Promise.all([
    publish(publisher, { xml: publishXml("Pack approval") }, stableKey),
    publish(publisher, { xml: publishXml("Pack approval") }, stableKey),
  ]);
  const winner = [left, right].find(response => response.status === 201);
  const loser = [left, right].find(response => response !== winner);
  assert.ok(winner, "exactly one reserving request deploys");
  assert.ok(loser.status === 200 || (loser.status === 409 &&
    (await loser.json()).error === "deployment_pending_reconciliation"));
  const settled = await jsonResult(winner, 201);
  assert.equal(settled.version, changed.version + 1);
  publishedDeployments.push((await latest()).deploymentId);
  assert.equal(await allVersions(), 3);
  assert.deepEqual(await jsonResult(await publish(publisher, { xml: publishXml("Pack approval") }, stableKey), 200), settled);
});
