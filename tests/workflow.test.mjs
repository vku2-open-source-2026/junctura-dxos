// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalInput } from "../src/modules/workflow/workflow.mjs";

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
  const identity = { tenantId: "tenant-a", issuer: "https://identity.invalid", subject: "actor", clientId: "client",
    roles: ["core-reader", "core-writer"], groups: ["/unit-a/reviewers"] };
  const response = { writeHead: status => assert.equal(status, 202), end: body => assert.deepEqual(JSON.parse(body), receipt) };
  await completeTask({ headers: { "idempotency-key": key } }, response, identity,
    { dataUrl: "https://data.invalid", dataSecret: "fixture" }, receipt.execution.id, { taskId: receipt.taskId },
    () => assert.fail("a recorded receipt needs no engine request"));
  assert.equal(calls, 1);
});
