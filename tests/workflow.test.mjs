// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { test } from "node:test";
import { canonicalInput, handleWorkflow } from "../src/modules/workflow/workflow.mjs";
import { logicalRequestDigest } from "../src/platform/http/http.mjs";
import { startWorkflowReconciler, workflowTaskPage } from "../src/modules/workflow/tasks.mjs";

const config = { dataUrl: "https://data.invalid", dataSecret: "fixture",
  workflowUrl: "https://engine.invalid", workflowPassword: "fixture" };
const identity = { tenantId: "tenant-a", issuer: "https://identity.invalid", subject: "actor", clientId: "client",
  roles: ["core-reader", "core-writer"], groups: ["/unit-a/reviewers"] };

test("workflow retries compare JSON input independently of object-key order", () => {
  assert.equal(JSON.stringify(canonicalInput({ b: [1, { z: 2, a: null }], a: true })),
    JSON.stringify(canonicalInput({ a: true, b: [1, { a: null, z: 2 }] })));
  assert.notEqual(JSON.stringify(canonicalInput({ a: [1, 2] })), JSON.stringify(canonicalInput({ a: [2, 1] })));
});
test("workflow inputs reject excessive nesting before reservation or engine side effects", () => {
  let input = {};
  for (let index = 0; index < 40; index++) input = { child: input };
  assert.throws(() => canonicalInput(input), (error) => error.status === 400);
});

test("worker verifies a task-local completion marker after an ambiguous engine response", async (t) => {
  const { reconcileCompletion } = await import("../src/modules/workflow/tasks.mjs");
  const job = { tenant_id: "tenant-a", task_id: "task-1", execution_id: "run-1",
    definition_id: "process:1:1", engine_execution_id: "branch-1", step_key: "review",
    variables: { decision: "approved", score: 7 }, marker: "11111111-1111-4111-8111-111111111111" };
  const task = { id: job.task_id, tenantId: job.tenant_id, processInstanceId: job.execution_id,
    processDefinitionId: job.definition_id, executionId: job.engine_execution_id, taskDefinitionKey: job.step_key };
  const marker = { name: "__junctura_completion", value: job.marker, type: "string", scope: "local" };
  const completedAt = "2030-01-24T12:00:00.000Z";
  let historic = task;
  let active = task;
  let engineWrites = 0;
  t.mock.method(globalThis, "fetch", async (input, options) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/historic-task-instances")) {
      assert.equal(url.searchParams.get("tenantId"), job.tenant_id);
      assert.equal(url.searchParams.get("processInstanceId"), job.execution_id);
      assert.equal(url.searchParams.get("taskId"), job.task_id);
      assert.equal(url.searchParams.get("includeTaskLocalVariables"), "true");
      return Response.json({ data: historic ? [historic] : [] });
    }
    assert.equal(url.pathname, "/runtime/tasks/task-1");
    if (!options.method) return active ? Response.json(active) : new Response(null, { status: 404 });
    engineWrites++;
    assert.deepEqual(JSON.parse(options.body), { action: "complete", variables: [
      { name: "decision", value: "approved", type: "string" }, { name: "score", value: 7, type: "long" }, marker,
    ] });
    historic = { ...task, endTime: completedAt, deleteReason: null, variables: [marker] };
    throw new Error("lost engine response");
  });
  const config = { workflowUrl: "https://engine.invalid", workflowPassword: "fixture" };
  assert.deepEqual(await reconcileCompletion(config, job), { state: "applied", completedAt });
  assert.deepEqual(await reconcileCompletion(config, job), { state: "applied", completedAt });
  historic = { ...historic, deleteReason: "cancelled" };
  assert.deepEqual(await reconcileCompletion(config, job), { state: "cancelled" });
  historic = { ...historic, deleteReason: null, variables: [{ ...marker, value: "another-operation" }] };
  assert.deepEqual(await reconcileCompletion(config, job), { state: "unconfirmed" });
  for (const patch of [{ tenantId: "other" }, { processInstanceId: "run-2" }, { executionId: "branch-2" }]) {
    historic = { ...historic, ...patch, variables: [marker] };
    active = { ...task, ...patch };
    assert.deepEqual(await reconcileCompletion(config, job), { state: "pending" });
  }
  historic = active = null;
  assert.deepEqual(await reconcileCompletion(config, job), { state: "pending" });
  assert.equal(engineWrites, 1);
});

test("an accepted task completion replays from PostgreSQL without calling Flowable", async (t) => {
  const { completeTask } = await import("../src/modules/workflow/tasks.mjs");
  const receipt = { taskId: "task-1", completionStatus: "pending",
    execution: { id: "run-1", definitionId: "process:1:1", status: "running", input: {}, dueAt: null } };
  const key = "11111111-1111-4111-8111-111111111111";
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls++;
    assert.equal(url, "https://data.invalid/rpc/workflow_task_command");
    const { operation, payload } = JSON.parse(options.body);
    assert.equal(operation, "complete");
    assert.equal(payload.requestKey, key);
    assert.equal(payload.executionId, receipt.execution.id);
    assert.equal(payload.taskId, receipt.taskId);
    assert.equal(payload.active, undefined);
    const claims = JSON.parse(Buffer.from(options.headers.Authorization.split(".")[1], "base64url"));
    assert.deepEqual(claims.groups, ["/unit-a/reviewers"]);
    return Response.json({ status: 202, value: receipt });
  });
  const response = { writeHead: status => assert.equal(status, 202), end: body => assert.deepEqual(JSON.parse(body), receipt) };
  await completeTask({ headers: { "idempotency-key": key } }, response, identity, config, receipt.execution.id, { taskId: receipt.taskId },
    () => assert.fail("a recorded receipt needs no engine request"));
  assert.equal(calls, 1);
});

const completionTask = { id: "task-1", tenantId: identity.tenantId, processInstanceId: "run-1",
  processDefinitionId: "process:1:1", taskDefinitionKey: "review", executionId: "branch-1" };
const completionExecution = { id: "run-1", definitionId: "process:1:1", status: "running", input: {}, dueAt: null };
const completionReceipt = { taskId: "task-1", completionStatus: "pending",
  execution: { ...completionExecution, definitionId: "process:1:1" } };

async function runCompletion(t, body, readExecution) {
  const { completeTask } = await import("../src/modules/workflow/tasks.mjs");
  const payloads = [];
  let status = 200;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (new URL(url).origin === config.dataUrl) {
      const { operation, payload } = JSON.parse(options.body);
      assert.equal(operation, "complete");
      payloads.push(payload);
      const current = status;
      status = 202;
      return Response.json({ status: current, value: completionReceipt });
    }
    assert.equal(new URL(url).pathname, "/runtime/tasks/task-1");
    return Response.json(completionTask);
  });
  const response = { writeHead: value => assert.equal(value, 202), end: value => assert.deepEqual(JSON.parse(value), completionReceipt) };
  await completeTask({ headers: { "idempotency-key": "11111111-1111-4111-8111-111111111111" } }, response,
    identity, config, "run-1", body, readExecution ?? (() => completionExecution));
  return payloads;
}

test("task completion merges output into process variables as serialized JSON", async (t) => {
  const payloads = await runCompletion(t, { taskId: "task-1", output: { report: { lines: [1, 2] }, note: "ok" } });
  assert.equal(payloads.length, 2);
  const variables = { report: "{\"lines\":[1,2]}", note: "ok" };
  assert.deepEqual(payloads[0].variables, variables);
  assert.equal(payloads[0].active, undefined);
  assert.deepEqual(payloads[1].variables, variables);
  assert.equal(payloads[1].active, true);
  assert.equal(payloads[1].definitionId, "process:1:1");
  assert.equal(payloads[1].digest, logicalRequestDigest({ body: { taskId: "task-1", output: { report: { lines: [1, 2] }, note: "ok" } } }));
});

test("task completion accepts decision and reason coming from output", async (t) => {
  const payloads = await runCompletion(t, { taskId: "task-1", output: { decision: "approved", reason: "ok", score: 7 } });
  assert.deepEqual(payloads[1].variables, { decision: "approved", reason: "ok", score: 7 });
});

test("task completion rejects output that is not a JSON object", async (t) => {
  const { completeTask } = await import("../src/modules/workflow/tasks.mjs");
  t.mock.method(globalThis, "fetch", async () => assert.fail("invalid output must not reach SQL or the engine"));
  const response = { writeHead: () => assert.fail(), end: () => assert.fail() };
  for (const output of [null, [], "x", 5, true]) {
    await assert.rejects(
      completeTask({ headers: { "idempotency-key": "11111111-1111-4111-8111-111111111111" } }, response,
        identity, config, "run-1", { taskId: "task-1", output }, () => assert.fail()),
      { status: 400, message: "invalid_request" });
  }
});

test("task completion caps output at 64 KiB", async (t) => {
  const { completeTask } = await import("../src/modules/workflow/tasks.mjs");
  t.mock.method(globalThis, "fetch", async () => Response.json({ status: 202, value: completionReceipt }));
  const response = { writeHead: value => assert.equal(value, 202), end: value => assert.deepEqual(JSON.parse(value), completionReceipt) };
  const options = { headers: { "idempotency-key": "11111111-1111-4111-8111-111111111111" } };
  await assert.rejects(
    completeTask(options, response, identity, config, "run-1", { taskId: "task-1", output: { blob: "x".repeat(65526) } }, () => assert.fail()),
    { status: 413, message: "body_too_large" });
  await completeTask(options, response, identity, config, "run-1", { taskId: "task-1", output: { blob: "x".repeat(65525) } },
    () => assert.fail("a recorded receipt needs no engine request"));
});

test("task completion rejects output keys that collide with variables or reserved names", async (t) => {
  const { completeTask } = await import("../src/modules/workflow/tasks.mjs");
  t.mock.method(globalThis, "fetch", async () => assert.fail("invalid output must not reach SQL or the engine"));
  const response = { writeHead: () => assert.fail(), end: () => assert.fail() };
  for (const body of [
    { taskId: "task-1", variables: { note: "a" }, output: { note: "b" } },
    { taskId: "task-1", output: { "bad-name": 1 } },
    { taskId: "task-1", output: { "9lives": 1 } },
    { taskId: "task-1", output: { input: "x" } },
    { taskId: "task-1", output: { __junctura_completion: "x" } },
    { taskId: "task-1", output: { decision: { approved: true } } },
    { taskId: "task-1", output: { decision: "" } },
    { taskId: "task-1", output: { reason: "y".repeat(501) } },
  ]) {
    await assert.rejects(
      completeTask({ headers: { "idempotency-key": "11111111-1111-4111-8111-111111111111" } }, response,
        identity, config, "run-1", body, () => assert.fail()),
      { status: 400, message: "invalid_request" });
  }
});

test("task completion returns 404 for a task of another execution or definition", async (t) => {
  const { completeTask } = await import("../src/modules/workflow/tasks.mjs");
  const response = { writeHead: () => assert.fail(), end: () => assert.fail() };
  const options = { headers: { "idempotency-key": "11111111-1111-4111-8111-111111111111" } };
  let engineTask = { ...completionTask, processInstanceId: "run-2" };
  t.mock.method(globalThis, "fetch", async (url) => new URL(url).origin === config.dataUrl
    ? Response.json({ status: 200, value: completionReceipt })
    : Response.json(engineTask));
  await assert.rejects(completeTask(options, response, identity, config, "run-1", { taskId: "task-1" },
    () => completionExecution), { status: 404, message: "not_found" });
  engineTask = { ...completionTask, processDefinitionId: "process:2:2" };
  await assert.rejects(completeTask(options, response, identity, config, "run-1", { taskId: "task-1" },
    () => completionExecution), { status: 404, message: "not_found" });
});

test("inbox forwards the definition filter and caps the SQL input at 20 engine pages", async (t) => {
  const offsets = [];
  t.mock.method(globalThis, "fetch", async (input, options) => {
    const url = new URL(input);
    if (url.origin === config.dataUrl) {
      const { operation, payload } = JSON.parse(options.body);
      assert.equal(operation, "list");
      assert.equal(payload.definitionKey, "business");
      assert.equal(payload.tasks.length, 2000);
      assert.equal(payload.tasks.at(-1).taskId, "task-1999");
      return Response.json({ status: 200, value: [] });
    }
    assert.equal(url.pathname, "/runtime/tasks");
    assert.equal(url.searchParams.get("processDefinitionKey"), "business");
    assert.equal(url.searchParams.get("tenantId"), identity.tenantId);
    assert.equal(url.searchParams.get("size"), "100");
    assert.equal(url.searchParams.get("sort"), "id");
    const start = Number(url.searchParams.get("start"));
    offsets.push(start);
    return Response.json({ total: 5000, data: Array.from({ length: 100 }, (_, index) => ({
      id: `task-${start + index}`, tenantId: identity.tenantId, processInstanceId: "run-1",
      processDefinitionId: "business:1:1", taskDefinitionKey: "review", executionId: "step-1",
    })) });
  });
  const url = new URL("http://core/v1/workflows/tasks?definitionKey=business");
  assert.deepEqual(await workflowTaskPage(config, identity, url), { items: [], nextCursor: null });
  assert.deepEqual(offsets, Array.from({ length: 20 }, (_, index) => index * 100));
});

test("workflow routes return their documented 405 responses with Allow", async () => {
  const { paths } = JSON.parse(readFileSync(new URL("../docs/contracts/foundation-api.openapi.json", import.meta.url)));
  const execution = "/v1/workflows/executions/{executionId}";
  const routes = [
    [execution, "GET, DELETE"], [`${execution}/complete`, "POST"], [`${execution}/history`, "GET"],
    ["/v1/workflows/tasks", "GET"], ["/v1/workflows/tasks/{taskId}/claim", "POST"],
    ["/v1/workflows/tasks/{taskId}/release", "POST"],
  ];
  for (const [path, allow] of routes) {
    for (const method of allow.toLowerCase().split(", ")) {
      assert.equal(paths[path][method].responses["405"].$ref, "#/components/responses/MethodNotAllowed");
    }
    const response = { setHeader: (name, value) => assert.deepEqual([name, value], ["Allow", allow]) };
    await assert.rejects(handleWorkflow({ method: "PUT" }, response, identity, config,
      new URL(path.replace(/\{[^}]+\}/, "known-id"), "http://core")), { status: 405, message: "method_not_allowed" });
  }
});

const executionUrl = new URL("http://core/v1/workflows/executions/run-1");
const executionFixture = { id: "run-1", tenantId: identity.tenantId, processDefinitionId: "process:1:1" };

test("execution reads degrade when deadline storage is down; only the verified checkpoint can complete without policy", async (t) => {
  let definitionKey = "business";
  let endTime;
  let dataReads = 0;
  let engineWrites = 0;
  t.mock.method(globalThis, "fetch", async (input, options) => {
    const url = new URL(input);
    if (url.origin === config.dataUrl) {
      dataReads++;
      return new Response(null, { status: 503 });
    }
    if (url.pathname.startsWith("/history/")) return Response.json({ data: [{ ...executionFixture, endTime }] });
    if (url.pathname.startsWith("/repository/")) return Response.json({ tenantId: identity.tenantId, key: definitionKey });
    if (url.pathname === "/runtime/tasks") return Response.json({ data: [{ id: "task-1" }] });
    assert.equal(options.method, "POST");
    assert.equal(url.pathname, "/runtime/tasks/task-1");
    engineWrites++;
    endTime = "2030-01-01T00:00:00Z";
    return new Response(null, { status: 204 });
  });
  let body;
  const response = { writeHead: status => assert.equal(status, 200), end: value => { body = JSON.parse(value); } };
  await handleWorkflow({ method: "GET" }, response, identity, config, executionUrl);
  assert.deepEqual(body, { id: "run-1", definitionId: "process:1:1", status: "running", input: {}, dueAt: null });
  const completeUrl = new URL(executionUrl.href + "/complete");
  const emptyCompletion = () => Object.assign(Readable.from([Buffer.from("{}")]), {
    method: "POST", headers: { "content-type": "application/json" },
  });
  await assert.rejects(handleWorkflow(emptyCompletion(), response, identity, config, completeUrl),
    { status: 503, message: "workflow_unavailable" });
  assert.equal(engineWrites, 0);
  definitionKey = "junctura_checkpoint";
  await handleWorkflow(emptyCompletion(), response, identity, config, completeUrl);
  assert.equal(body.status, "completed");
  assert.equal(dataReads, 2);
  assert.equal(engineWrites, 1);
});

test("failed cancellation releases its own lease only if Flowable still reports running", async (t) => {
  const lease = "11111111-1111-4111-8111-111111111111";
  const commands = [];
  let cancellationApplied;
  let deletionAttempted;
  t.mock.method(globalThis, "fetch", async (input, options) => {
    const url = new URL(input);
    if (url.origin === config.dataUrl) {
      const command = JSON.parse(options.body);
      commands.push(command);
      return Response.json(command.operation === "cancel" ? { status: 200, value: lease } : { status: 204 });
    }
    if (url.pathname.startsWith("/history/")) {
      const end = deletionAttempted && cancellationApplied ? { endTime: "2030-01-01T00:00:00Z", deleteReason: "cancelled" } : {};
      return Response.json({ data: [{ ...executionFixture, ...end }] });
    }
    if (url.pathname.startsWith("/repository/")) return Response.json({ tenantId: identity.tenantId, key: "business" });
    assert.equal(options.method, "DELETE");
    deletionAttempted = true;
    return new Response(null, { status: 503 });
  });
  const cancel = () => handleWorkflow({ method: "DELETE" }, {
    writeHead: status => assert.equal(status, 204), end: () => {},
  }, identity, config, executionUrl);
  await assert.rejects(cancel(), { status: 503, message: "workflow_unavailable" });
  cancellationApplied = true;
  deletionAttempted = false;
  await cancel();
  const reserve = { operation: "cancel", payload: { executionId: "run-1", status: "running" } };
  assert.deepEqual(commands, [reserve, { operation: "resume", payload: { executionId: "run-1", lease } }, reserve]);
});

test("worker processes ten jobs per tick and rate-limits lease, reconcile and settle warnings", async (t) => {
  let tick;
  t.mock.method(globalThis, "setInterval", callback => {
    tick = callback;
    return { unref() { return this; } };
  });
  const warnings = [];
  t.mock.method(console, "warn", (message, fields) => warnings.push(fields));
  const settled = [];
  let leased = 0;
  t.mock.method(globalThis, "fetch", async (input, options) => {
    const url = new URL(input);
    if (url.origin === config.dataUrl) {
      const { operation, payload } = JSON.parse(options.body);
      if (operation === "settle") {
        settled.push(payload);
        return Response.json({ status: 409, error: "fixture_error" });
      }
      if (leased === 11) return new Response(null, { status: 503 });
      return Response.json({ status: 200, value: {
        tenant_id: "tenant-a", task_id: `task-${leased++}`, execution_id: "run-1", definition_id: "process:1:1",
        engine_execution_id: "branch-1", step_key: "review", variables: {}, marker: "marker", lease: "lease",
      } });
    }
    if (url.pathname.startsWith("/history/")) return Response.json({ data: [] });
    if (options.method === "POST") return new Response(null, { status: 503 });
    return Response.json({ id: url.pathname.split("/").at(-1), tenantId: "tenant-a", processInstanceId: "run-1",
      processDefinitionId: "process:1:1", executionId: "branch-1", taskDefinitionKey: "review" });
  });
  const stop = startWorkflowReconciler(config);
  await Promise.all([tick(), tick()]);
  assert.equal(settled.length, 10);
  await tick();
  await tick();
  stop();
  assert.equal(settled.length, 11);
  assert.ok(settled.every(job => job.state === "pending" && job.lease === "lease"));
  assert.deepEqual(warnings, [
    { operation: "reconcile", tenantId: "tenant-a", taskId: "task-0" },
    { operation: "settle", tenantId: "tenant-a", taskId: "task-0" },
    { operation: "lease", tenantId: undefined, taskId: undefined },
  ]);
});
