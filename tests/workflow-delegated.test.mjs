// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { handleWorkflow } from "../src/modules/workflow/workflow.mjs";

const config = { dataUrl: "https://data.invalid", dataSecret: "fixture",
  workflowUrl: "https://engine.invalid", workflowPassword: "fixture" };
const identity = {
  tenantId: "tenant-a", subject: "user-a", issuer: "https://identity.invalid",
  clientId: "app-x", actor: { sub: "service-account", client_id: "app-x" },
  humanAppId: "22222222-2222-4222-8222-222222222222",
  roles: ["core-reader", "core-writer"], units: ["unit-a"],
  resourceUnit: "unit-a", groups: ["/unit-a/sender"],
  appRoles: ["editor"], assignmentRoles: ["junctura-assignment-11111111-1111-4111-8111-111111111111"],
  delegatedWriter: true,
};
const key = "11111111-1111-4111-8111-111111111111";
const definition = { id: "process_delegated:1:tenant-a", key: "process_delegated", tenantId: "tenant-a", version: 1 };
const run = { id: "run-1", tenantId: "tenant-a", processDefinitionId: definition.id, endTime: null, deleteReason: null,
  variables: [{ name: "input", value: JSON.stringify({ reference: "CASE-1" }) }] };
const xml = `<?xml version="1.0" encoding="UTF-8"?>
  <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:flowable="http://flowable.org/bpmn"
    targetNamespace="https://example.invalid">
    <process id="process_delegated" isExecutable="true" name="Delegated process">
      <startEvent id="start"/>
      <sequenceFlow id="a" sourceRef="start" targetRef="review"/>
      <userTask id="review" name="Review" flowable:candidateGroups="receiver"/>
      <sequenceFlow id="b" sourceRef="review" targetRef="end"/>
      <endEvent id="end"/>
    </process>
  </definitions>`;

function request(method, path, body) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  return Object.assign(stream, { method, url: path,
    headers: body === undefined ? {} : { "content-type": "application/json", "idempotency-key": key } });
}
function response() {
  const result = { headers: {}, setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); },
    end(body) { this.body = body ? JSON.parse(body) : null; } };
  return result;
}

test("a delegated start reserves through the dedicated policy boundary before the engine starts", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input, options = {}) => {
    const target = new URL(input);
    calls.push(`${options.method ?? "GET"} ${target.origin}${target.pathname}`);
    if (target.origin === config.dataUrl) {
      assert.equal(target.pathname, "/rpc/workflow_delegated_command");
      const claims = JSON.parse(Buffer.from(options.headers.Authorization.split(".")[1], "base64url"));
      assert.equal(claims.role, "junctura_workflow_api");
      assert.equal(claims.actor_sub, "service-account");
      assert.equal(claims.app_id, identity.humanAppId);
      assert.equal(claims.app_unit, "unit-a");
      assert.deepEqual(claims.client_roles, identity.assignmentRoles);
      const body = JSON.parse(options.body);
      if (body.operation === "reserve") {
        assert.deepEqual(body.payload.steps.review, { name: "Review", groups: ["receiver"], unit: "unit-b" });
        return Response.json({ status: 200, value: { reserved: true, businessKey: "business-1" } });
      }
      assert.equal(body.operation, "confirm");
      assert.equal(body.payload.execution.id, run.id);
      return Response.json({ status: 201, value: { id: run.id, definitionId: definition.id,
        status: "running", input: { reference: "CASE-1" }, dueAt: null } });
    }
    assert.equal(target.origin, config.workflowUrl);
    if (target.pathname === `/repository/process-definitions/${encodeURIComponent(definition.id)}`) {
      return Response.json(definition);
    }
    if (target.pathname === `/repository/process-definitions/${encodeURIComponent(definition.id)}/resourcedata`) {
      return new Response(xml);
    }
    if (target.pathname === "/runtime/process-instances") {
      const body = JSON.parse(options.body);
      assert.equal(body.processDefinitionId, definition.id);
      return Response.json(run);
    }
    if (target.pathname === "/history/historic-process-instances") return Response.json({ data: [run] });
    assert.fail(`unexpected engine request ${options.method ?? "GET"} ${target.pathname}`);
  });
  const result = response();
  await handleWorkflow(request("POST", "/v1/workflows/executions", {
    definitionId: definition.id, input: { reference: "CASE-1" }, taskUnits: { review: "unit-b" },
  }), result, identity, config, new URL("http://core/v1/workflows/executions"));
  assert.equal(result.status, 201);
  assert.equal(result.body.id, run.id);
  assert.ok(calls.some(call => call === `POST ${config.dataUrl}/rpc/workflow_delegated_command`));
  assert.ok(!calls.some(call => call.includes("/rpc/workflow_execution_command")));
  assert.equal(calls.filter(call => call.includes("/rpc/workflow_delegated_command")).length, 2);
  assert.equal(calls.filter(call => call === `POST ${config.workflowUrl}/runtime/process-instances`).length, 1);
});

test("a delegated checkpoint never reserves or starts", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input, options = {}) => {
    const target = new URL(input);
    calls.push(`${options.method ?? "GET"} ${target.pathname}`);
    assert.equal(target.origin, config.workflowUrl);
    assert.equal(target.pathname, `/repository/process-definitions/${encodeURIComponent("junctura_checkpoint:1:1")}`);
    return Response.json({ id: "junctura_checkpoint:1:1", key: "junctura_checkpoint", tenantId: "tenant-a", version: 1 });
  });
  const result = response();
  await assert.rejects(handleWorkflow(request("POST", "/v1/workflows/executions", {
    definitionId: "junctura_checkpoint:1:1", input: {},
  }), result, identity, config, new URL("http://core/v1/workflows/executions")),
  { status: 403, message: "workflow_unit_required" });
  assert.deepEqual(calls, ["GET /repository/process-definitions/junctura_checkpoint%3A1%3A1"]);
});

for (const [label, access, status, code] of [
  ["missing or foreign ownership", { status: 404, error: "not_found" }, 404, "not_found"],
  ["authorization storage failure", null, 503, "workflow_unavailable"],
]) {
  test(`delegated detail fails closed on ${label} before any engine read`, async (t) => {
    const calls = [];
    t.mock.method(globalThis, "fetch", async (input, options = {}) => {
      const target = new URL(input);
      calls.push(`${options.method ?? "GET"} ${target.origin}${target.pathname}`);
      assert.equal(target.origin, config.dataUrl);
      assert.equal(target.pathname, "/rpc/workflow_delegated_command");
      assert.equal(JSON.parse(options.body).operation, "access");
      return access === null ? new Response(null, { status: 503 }) : Response.json(access);
    });
    const result = response();
    await assert.rejects(handleWorkflow(request("GET", "/v1/workflows/executions/run-1"), result,
      identity, config, new URL("http://core/v1/workflows/executions/run-1")), { status, message: code });
    assert.deepEqual(calls, [`POST ${config.dataUrl}/rpc/workflow_delegated_command`]);
  });
}

test("delegated detail uses the participation access result without a legacy policy round trip", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input, options = {}) => {
    const target = new URL(input);
    calls.push(`${options.method ?? "GET"} ${target.origin}${target.pathname}`);
    if (target.origin === config.dataUrl) {
      assert.equal(target.pathname, "/rpc/workflow_delegated_command");
      const body = JSON.parse(options.body);
      assert.equal(body.operation, "access");
      return Response.json({ status: 200, value: { allowed: true, executionId: run.id, appId: identity.humanAppId,
        senderUnit: "unit-a", senderGroup: "sender", dueAt: "2030-01-12T12:00:00Z" } });
    }
    if (target.pathname === "/history/historic-process-instances") return Response.json({ data: [run] });
    if (target.pathname.startsWith("/repository/process-definitions/")) return Response.json(definition);
    assert.fail(`unexpected engine request ${target.pathname}`);
  });
  const result = response();
  await handleWorkflow(request("GET", "/v1/workflows/executions/run-1"), result,
    identity, config, new URL("http://core/v1/workflows/executions/run-1"));
  assert.equal(result.status, 200);
  assert.equal(result.body.dueAt, "2030-01-12T12:00:00Z");
  assert.equal(calls[0], `POST ${config.dataUrl}/rpc/workflow_delegated_command`);
  assert.ok(!calls.some(call => call.includes("/rpc/workflow_execution_command")));
  assert.ok(calls.indexOf(`GET ${config.workflowUrl}/history/historic-process-instances`) >
    calls.indexOf(`POST ${config.dataUrl}/rpc/workflow_delegated_command`));
});

test("delegated history uses the dedicated participant operation before returning engine history", async (t) => {
  const calls = [];
  let access = { status: 200, value: { allowed: true, dueAt: null } };
  t.mock.method(globalThis, "fetch", async (input, options = {}) => {
    const target = new URL(input);
    calls.push(`${options.method ?? "GET"} ${target.origin}${target.pathname}`);
    if (target.origin === config.dataUrl) {
      assert.equal(target.pathname, "/rpc/workflow_delegated_command");
      const body = JSON.parse(options.body);
      if (body.operation === "access") return Response.json(access);
      assert.equal(body.operation, "history");
      return Response.json({ status: 200, value: [] });
    }
    if (target.pathname === "/history/historic-process-instances") return Response.json({ data: [run] });
    if (target.pathname.startsWith("/repository/process-definitions/")) return Response.json(definition);
    assert.fail(`unexpected engine request ${target.pathname}`);
  });
  const result = response();
  await handleWorkflow(request("GET", "/v1/workflows/executions/run-1/history"), result,
    identity, config, new URL("http://core/v1/workflows/executions/run-1/history"));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { items: [], nextCursor: null });
  assert.equal(calls[0], `POST ${config.dataUrl}/rpc/workflow_delegated_command`);
  assert.ok(!calls.some(call => call.includes("/rpc/workflow_task_command")));
  assert.equal(calls.filter(call => call === `POST ${config.dataUrl}/rpc/workflow_delegated_command`).length, 2);

  access = { status: 404, error: "not_found" };
  calls.length = 0;
  await assert.rejects(handleWorkflow(request("GET", "/v1/workflows/executions/run-1/history"), response(),
    identity, config, new URL("http://core/v1/workflows/executions/run-1/history")),
  { status: 404, message: "not_found" });
  assert.deepEqual(calls, [`POST ${config.dataUrl}/rpc/workflow_delegated_command`]);
});
