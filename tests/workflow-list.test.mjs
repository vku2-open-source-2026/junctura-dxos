// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { handleWorkflow } from "../src/modules/workflow/workflow.mjs";
import { HttpError, json } from "../src/platform/http/http.mjs";

const identity = {
  tenantId: "tenant-a",
  subject: "auditor",
  issuer: "https://identity.example.invalid",
  clientId: "management",
  roles: ["core-reader"],
};

const executions = [
  {
    id: "run-1",
    tenantId: "tenant-a",
    processDefinitionId: "33333333-3333-4333-8333-333333333333",
    processDefinitionName: "Chuyển tuyến bệnh nhân",
    startTime: "2026-02-01T08:00:00.000Z",
    endTime: null,
    deleteReason: null,
    variables: [{ name: "input", value: JSON.stringify({
      loai: "chuyen-tuyen", ma_ho_so: "CT-0001", ho_ten_benh_nhan: "Nguyễn Văn Bí Mật",
      ma_benh_nhan: "BN-0001",
    }) }],
  },
  {
    id: "done-1",
    tenantId: "tenant-a",
    processDefinitionId: "junctura_xac_minh_don_thuoc:1:1",
    processDefinitionKey: "junctura_xac_minh_don_thuoc",
    processDefinitionName: "Xác minh đơn thuốc",
    processDefinitionVersion: 1,
    startTime: "2026-02-02T08:00:00.000Z",
    endTime: "2026-02-02T09:00:00.000Z",
    deleteReason: null,
    variables: [{ name: "input", value: JSON.stringify({ loai: "xac-minh-don-thuoc", ma_ho_so: "DT-0002" }) }],
  },
  {
    id: "cancel-1",
    tenantId: "tenant-a",
    processDefinitionId: "junctura_missing:1:1",
    processDefinitionKey: "junctura_missing",
    processDefinitionName: "Quy trình khác",
    processDefinitionVersion: 1,
    startTime: "2026-02-03T08:00:00.000Z",
    endTime: "2026-02-03T09:00:00.000Z",
    deleteReason: "cancelled",
    variables: [],
  },
  {
    id: "internal-1",
    tenantId: "tenant-a",
    processDefinitionId: "junctura_c4a_single:1:1",
    processDefinitionName: "Internal",
    startTime: "2026-02-04T08:00:00.000Z",
    endTime: null,
    deleteReason: null,
    variables: [],
  },
];

let access = { status: 200, value: { allowed: true } };
let engineDown = false;
let seen = [];
let data, engine, core, base;

const listen = (server) => new Promise((resolve) =>
  server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));

before(async () => {
  data = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    seen.push({ kind: "data", url: request.url, authorization: request.headers.authorization,
      body: Buffer.concat(chunks).toString() });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(access));
  });
  const dataUrl = await listen(data);
  engine = createServer(async (request, response) => {
    seen.push({ kind: "engine", url: request.url });
    if (engineDown) { response.writeHead(503); return response.end(); }
    const url = new URL(request.url, "http://engine");
    if (url.pathname === "/repository/process-definitions") {
      response.writeHead(200, { "Content-Type": "application/json" });
      return response.end(JSON.stringify({ data: [
        { id: "33333333-3333-4333-8333-333333333333", key: "junctura_chuyen_tuyen", name: "Chuyển tuyến bệnh nhân", version: 1 },
        { id: "junctura_xac_minh_don_thuoc:1:1", key: "junctura_xac_minh_don_thuoc", name: "Xác minh đơn thuốc", version: 1 },
        { id: "junctura_c4a_single:1:1", key: "junctura_c4a_single", name: "Internal", version: 1 },
      ] }));
    }
    if (url.pathname === "/history/historic-process-instances") {
      response.writeHead(200, { "Content-Type": "application/json" });
      return response.end(JSON.stringify({ data: executions, total: executions.length }));
    }
    if (url.pathname === "/runtime/tasks") {
      response.writeHead(200, { "Content-Type": "application/json" });
      return response.end(JSON.stringify({ data: [{
        id: "task-1", name: "Bác sĩ bệnh viện duyệt", assignee: null,
        createTime: "2026-02-01T08:05:00.000Z",
      }] }));
    }
    if (url.pathname === "/runtime/tasks/task-1/identitylinks") {
      response.writeHead(200, { "Content-Type": "application/json" });
      return response.end(JSON.stringify([{ type: "candidate", groupId: "benh-vien" }]));
    }
    response.writeHead(404);
    response.end();
  });
  const workflowUrl = await listen(engine);
  core = createServer(async (request, response) => {
    try {
      await handleWorkflow(request, response, identity,
        { dataUrl, dataSecret: "x".repeat(32), workflowUrl }, new URL(request.url, "http://core"));
    } catch (error) {
      json(response, error instanceof HttpError ? error.status : 500, { error: error.message });
    }
  });
  base = await listen(core);
});
after(() => { data.close(); engine.close(); core.close(); });

const get = (path = "/v1/workflows/executions") => fetch(`${base}${path}`);

test("list executions requires audit.read and returns safe business summaries", async () => {
  seen = [];
  access = { status: 200, value: { allowed: true } };
  engineDown = false;
  const response = await get("/v1/workflows/executions?limit=2");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.limit, 2);
  assert.equal(body.items.length, 2);
  assert.equal(seen[0].kind, "data");
  assert.equal(seen[0].url, "/rpc/workflow_audit_access");
  const claims = JSON.parse(Buffer.from(seen[0].authorization.split(".")[1], "base64url"));
  assert.equal(claims.role, "junctura_workflow_audit_api");
  const [running, completed] = body.items;
  assert.equal(running.id, "run-1");
  assert.equal(running.status, "running");
  assert.equal(running.definition.name, "Chuyển tuyến bệnh nhân");
  assert.equal(running.definition.key, "junctura_chuyen_tuyen");
  assert.equal(running.definition.version, 1);
  assert.equal(running.title, "Chuyển tuyến CT-0001");
  assert.deepEqual(running.currentStep, {
    name: "Bác sĩ bệnh viện duyệt", assignee: null, groups: ["benh-vien"],
  });
  assert.equal(running.updatedAt, "2026-02-01T08:05:00.000Z");
  assert.equal(completed.status, "completed");
  assert.equal(completed.title, "Xác minh đơn thuốc DT-0002");
  assert.equal(completed.currentStep, null);
  const text = JSON.stringify(body);
  for (const secret of ["Nguyễn Văn Bí Mật", "BN-0001", "internal-1"]) {
    assert.ok(!text.includes(secret), `${secret} must not be returned`);
  }
});

test("status filter, limit bounds and closed query parameters are enforced", async () => {
  access = { status: 200, value: { allowed: true } };
  const cancelled = await get("/v1/workflows/executions?status=cancelled");
  assert.equal(cancelled.status, 200);
  const items = (await cancelled.json()).items;
  assert.deepEqual(items.map(item => item.id), ["cancel-1"]);
  assert.equal(items[0].status, "cancelled");

  const running = await get("/v1/workflows/executions?status=running&limit=1");
  assert.deepEqual((await running.json()).items.map(item => item.id), ["run-1"]);

  for (const query of ["limit=0", "limit=101", "limit=x", "status=done", "status=running&status=completed", "tenant=b", "limit=1&limit=2"]) {
    assert.equal((await get(`/v1/workflows/executions?${query}`)).status, 400, query);
  }
});

test("permission, database and engine failures fail closed", async () => {
  access = { status: 403, error: "workflow_audit_permission_required" };
  const denied = await get();
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error, "workflow_audit_permission_required");

  access = { status: 200, value: { allowed: false } };
  assert.equal((await get()).status, 503);

  access = { status: 200, value: { allowed: true } };
  engineDown = true;
  assert.equal((await get()).status, 503);
  engineDown = false;
});

test("workflow summary aggregates real definitions and counts without patient data", async () => {
  access = { status: 200, value: { allowed: true } };
  engineDown = false;
  const response = await get("/v1/workflows/summary");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.deepEqual(body.totals, { definitions: 4, running: 1, completed: 1, cancelled: 1 });
  const byKey = new Map(body.definitions.map((item) => [item.key, item]));
  assert.equal(byKey.has("junctura_checkpoint"), false);
  assert.equal(byKey.has("junctura_c4a_single"), false);
  const referral = byKey.get("junctura_chuyen_tuyen");
  assert.deepEqual(referral.application, { id: "tram-y-te", name: "Trạm y tế" });
  assert.deepEqual(referral.steps.map((step) => [step.name, step.owner]), [
    ["Tiếp nhận ở Trạm y tế", "Trạm y tế"],
    ["Bác sĩ bệnh viện duyệt", "Bệnh viện"],
    ["Hoàn tất", "Bệnh viện"],
  ]);
  assert.deepEqual(referral.counts, { running: 1, completed: 0, cancelled: 0 });
  assert.equal(referral.updatedAt, "2026-02-01T08:00:00.000Z");
  assert.deepEqual(byKey.get("junctura_xac_minh_don_thuoc").counts, { running: 0, completed: 1, cancelled: 0 });
  assert.deepEqual(byKey.get("junctura_xac_minh_chi_phi").counts, { running: 0, completed: 0, cancelled: 0 });
  assert.deepEqual(byKey.get("junctura_missing").counts, { running: 0, completed: 0, cancelled: 1 });
  assert.equal(byKey.get("junctura_missing").application, null);
  const text = JSON.stringify(body);
  for (const secret of ["Nguyễn Văn Bí Mật", "BN-0001", "internal-1"]) {
    assert.ok(!text.includes(secret), `${secret} must not be returned`);
  }
});

test("workflow summary enforces GET-only, closed query and fail-closed access", async () => {
  access = { status: 200, value: { allowed: true } };
  engineDown = false;
  assert.equal((await get("/v1/workflows/summary?minutes=5")).status, 400);
  const post = await fetch(`${base}/v1/workflows/summary`, { method: "POST" });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET");
  assert.equal((await fetch(`${base}/v1/workflows/summary`, { method: "DELETE" })).status, 405);

  access = { status: 403, error: "workflow_audit_permission_required" };
  assert.equal((await get("/v1/workflows/summary")).status, 403);
  access = { status: 200, value: { allowed: false } };
  assert.equal((await get("/v1/workflows/summary")).status, 503);
  access = { status: 200, value: { allowed: true } };
  engineDown = true;
  assert.equal((await get("/v1/workflows/summary")).status, 503);
  engineDown = false;
});
