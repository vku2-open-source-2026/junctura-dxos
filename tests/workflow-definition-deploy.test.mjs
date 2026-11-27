// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { test } from "node:test";
import { handleWorkflow } from "../src/modules/workflow/workflow.mjs";

const config = { dataUrl: "https://data.invalid", dataSecret: "fixture",
  workflowUrl: "https://engine.invalid", workflowPassword: "engine-private-password" };
const identity = { tenantId: "tenant-a", issuer: "https://identity.invalid", subject: "actor",
  clientId: "junctura-console", consoleRole: "admin", roles: ["core-reader", "core-writer"],
  groups: ["/unit-a/reviewers"] };
const key = "aaaaaaaa-1111-4111-8111-111111111111";
const otherKey = "22222222-2222-4222-8222-222222222222";
const url = new URL("http://core/v1/workflows/definitions");
const sample = readFileSync(new URL("./fixtures/workflows/sample-two-step.bpmn20.xml", import.meta.url), "utf8");
const hashOf = xml => createHash("sha256").update(xml).digest("hex");

function newState() {
  return { ledger: new Map(), definitions: new Map(), deployments: 0, calls: [] };
}

// Minimal faithful engine plus tenant ledger. Flowable stays on its private
// network: requests must carry the internal Basic credential and every
// definition must stay inside the verified tenant.
function mockBackend(t, state, { loseDeploymentReply = false } = {}) {
  t.mock.method(globalThis, "fetch", async (input, options = {}) => {
    const target = new URL(input);
    state.calls.push(`${options.method ?? "GET"} ${target.pathname}${target.search}`);
    if (target.origin === config.dataUrl) {
      assert.equal(target.pathname, "/workflow_requests");
      assert.equal(JSON.parse(Buffer.from(options.headers.Authorization.split(".")[1], "base64url")).tenant_id, identity.tenantId);
      const requestKey = target.searchParams.get("key").slice(3);
      if (options.method === "POST") {
        const row = JSON.parse(options.body);
        assert.deepEqual(row, { key: requestKey, definition_id: row.definition_id, input_hash: row.input_hash });
        if (state.ledger.has(requestKey)) return new Response("duplicate key", { status: 409 });
        state.ledger.set(requestKey, { ...row, engine_id: null });
        return Response.json([state.ledger.get(requestKey)]);
      }
      if (options.method === "PATCH") {
        const row = state.ledger.get(requestKey);
        row.engine_id = JSON.parse(options.body).engine_id;
        return Response.json([row]);
      }
      const row = state.ledger.get(requestKey);
      return Response.json(row ? [row] : []);
    }
    assert.equal(options.headers.Authorization,
      `Basic ${Buffer.from(`junctura-engine:${config.workflowPassword}`).toString("base64")}`);
    if (target.pathname === "/repository/deployments") {
      assert.equal(options.method, "POST");
      const tenant = options.body.get("tenantId");
      const file = options.body.get("file");
      assert.equal(file.name, "sample_two_step.bpmn20.xml");
      const xml = await file.text();
      const processKey = /<process\b[^>]*\bid="([^"]+)"/.exec(xml)[1];
      state.deployments += 1;
      const versions = [...state.definitions.values()].filter(item => item.key === processKey && item.tenantId === tenant);
      const definition = { id: `${processKey}:${versions.length + 1}:${tenant}`, key: processKey,
        version: versions.length + 1, tenantId: tenant, xml, deploymentId: `dep-${state.deployments}` };
      state.definitions.set(definition.id, definition);
      if (loseDeploymentReply) throw new Error("engine reply lost");
      return Response.json({ id: definition.deploymentId });
    }
    if (target.pathname === "/repository/process-definitions") {
      const all = [...state.definitions.values()];
      if (target.searchParams.get("deploymentId")) {
        return Response.json({ data: all.filter(item => item.deploymentId === target.searchParams.get("deploymentId") &&
          item.tenantId === target.searchParams.get("tenantId") && item.key === target.searchParams.get("key")) });
      }
      assert.equal(target.searchParams.get("latest"), "true");
      const matching = all.filter(item => item.tenantId === target.searchParams.get("tenantId") &&
        item.key === target.searchParams.get("key"));
      matching.sort((left, right) => right.version - left.version);
      return Response.json({ data: matching.slice(0, 1) });
    }
    const id = decodeURIComponent(target.pathname.split("/").at(-1));
    if (target.pathname.endsWith("/resourcedata")) {
      const definition = state.definitions.get(decodeURIComponent(target.pathname.split("/").at(-2)));
      return definition ? new Response(definition.xml) : new Response(null, { status: 404 });
    }
    const definition = state.definitions.get(id);
    return definition ? Response.json(definition) : new Response(null, { status: 404 });
  });
}

async function publish(request, who = identity, publishUrl = url) {
  const result = {};
  await handleWorkflow(Object.assign(Readable.from([Buffer.from(JSON.stringify(request))]), {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": key },
  }), {
    setHeader() {},
    writeHead(status) { result.status = status; },
    end(body) { result.body = body ? JSON.parse(body) : null; },
  }, who, config, publishUrl);
  return result;
}

async function publishRaw(request, who = identity, publishUrl = url) {
  const result = {};
  const record = {
    setHeader() {},
    writeHead(status) { result.status = status; },
    end(body) { result.body = body ? JSON.parse(body) : null; },
  };
  try { await handleWorkflow(request, record, who, config, publishUrl); }
  catch (error) {
    result.status = error.status;
    result.error = error.message;
    result.details = error.details;
  }
  return result;
}

test("publishing requires the verified direct tenant administrator before any engine request", async (t) => {
  const state = newState();
  mockBackend(t, state);
  const rejections = [
    // A reader without the writer role.
    [{ ...identity, roles: ["core-reader"] }, "write_forbidden"],
    // Ordinary application writers, backends and non-administrator console
    // sessions are direct writers but never operators.
    [{ ...identity, clientId: "workspace-backend", consoleRole: undefined }, "operator_required"],
    [{ ...identity, consoleRole: "manager" }, "operator_required"],
    [{ ...identity, consoleRole: "viewer" }, "operator_required"],
    [{ ...identity, consoleRole: undefined }, "operator_required"],
    // Delegated app-actor calls are rejected even for administrators.
    [{ ...identity, actor: { sub: "service" } }, "delegation_not_allowed"],
  ];
  for (const [who, code] of rejections) {
    await assert.rejects(publish({ xml: sample }, who), { status: 403, message: code });
  }
  assert.deepEqual(state.calls, []);
});

test("the request needs a UUID key, a single xml field and no identity fields", async (t) => {
  const state = newState();
  mockBackend(t, state);
  for (const body of [{}, { definition: sample }, { xml: sample, tenantId: "tenant-b" },
      { xml: sample, definitionId: "sample_two_step:1:tenant-a" }, { xml: 42 }, { xml: null }]) {
    await assert.rejects(publish(body), { status: 400, message: "invalid_workflow_request" });
  }
  for (const requestKey of [undefined, "not-a-uuid", key.toUpperCase()]) {
    const raw = await publishRaw(Object.assign(Readable.from([Buffer.from(JSON.stringify({ xml: sample }))]), {
      method: "POST", headers: { "content-type": "application/json", ...(requestKey ? { "idempotency-key": requestKey } : {}) },
    }));
    assert.deepEqual([raw.status, raw.error], [400, "uuid_idempotency_key_required"]);
  }
  assert.deepEqual(state.calls, []);
});

test("oversized bodies and XML are rejected before any engine request", async (t) => {
  const state = newState();
  mockBackend(t, state);
  const padded = sample.replace("</definitions>", " ".repeat(262146 - Buffer.byteLength(sample)) + "</definitions>");
  await assert.rejects(publish({ xml: padded }), (error) => error.status === 400 &&
    error.message === "definition_invalid" && error.details.problems.some(problem => problem.rule === "too_large"));
  const raw = await publishRaw(Object.assign(Readable.from([Buffer.from(JSON.stringify({ xml: "x".repeat(280000) }))]), {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": key },
  }));
  assert.deepEqual([raw.status, raw.error], [413, "body_too_large"]);
  assert.deepEqual(state.calls, []);
});

test("unsafe XML, reserved process ids and ungoverned tasks never reach SQL or the engine", async (t) => {
  const state = newState();
  mockBackend(t, state);
  const cases = [
    [sample.replace("</definitions>", "<!DOCTYPE definitions [ <!ENTITY x \"y\"> ]></definitions>"), "doctype_forbidden"],
    [sample.replace("sample_two_step", "junctura_checkpoint"), "reserved_key"],
    [sample.replace(' flowable:candidateGroups="nhom-a"', ""), "missing_group"],
    [sample.replace('id="first" name="Bước 1"', 'id="first" name="Bước 1" flowable:class="private.Class"'), "attribute_forbidden"],
    [sample.replace("${decision == 'approved'}", "${decision == request.param}"), "condition_forbidden"],
  ];
  for (const [xml, rule] of cases) {
    await assert.rejects(publish({ xml }), (error) => error.status === 400 &&
      error.message === "definition_invalid" && error.details.problems.some(problem => problem.rule === rule));
  }
  assert.deepEqual(state.calls, []);
});

test("a fresh publication deploys to the verified tenant and reports key and version", async (t) => {
  const state = newState();
  mockBackend(t, state);
  const result = await publish({ xml: sample });
  assert.equal(result.status, 201);
  assert.deepEqual(result.body, { id: "sample_two_step:1:tenant-a", key: "sample_two_step", version: 1 });
  assert.equal(state.deployments, 1);
  assert.ok(state.calls.some(call => call.startsWith("POST /workflow_requests")));
  assert.ok(state.calls.some(call => call.includes("deploymentId=dep-1")));
});

test("an identical retry replays the recorded version without another deployment", async (t) => {
  const state = newState();
  mockBackend(t, state);
  await publish({ xml: sample });
  const replay = await publish({ xml: sample });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, { id: "sample_two_step:1:tenant-a", key: "sample_two_step", version: 1 });
  assert.equal(state.deployments, 1);
});

test("a lost engine reply replays safely from the deployed resource on the next run", async (t) => {
  const state = newState();
  mockBackend(t, state, { loseDeploymentReply: true });
  await assert.rejects(publish({ xml: sample }), { status: 503, message: "workflow_unavailable" });
  assert.equal(state.deployments, 1);
  const retry = await publish({ xml: sample });
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.body, { id: "sample_two_step:1:tenant-a", key: "sample_two_step", version: 1 });
  assert.equal(state.deployments, 1);
});

test("the same key with different content conflicts and a colliding start key is rejected", async (t) => {
  const state = newState();
  mockBackend(t, state);
  await publish({ xml: sample });
  await assert.rejects(publish({ xml: sample.replace("Quy trình mẫu", "Quy trình khác") }),
    { status: 409, message: "idempotency_conflict" });
  assert.equal(state.deployments, 1);
  state.ledger.set(key, { key, definition_id: "sample_two_step:3:tenant-a", input_hash: hashOf(sample), engine_id: null });
  await assert.rejects(publish({ xml: sample }), { status: 409, message: "idempotency_conflict" });
  assert.equal(state.deployments, 1);
});

test("identical content under a new key converges on the deployed version", async (t) => {
  const state = newState();
  mockBackend(t, state);
  await publish({ xml: sample });
  const converging = await publishRaw(Object.assign(Readable.from([Buffer.from(JSON.stringify({ xml: sample }))]), {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": otherKey },
  }));
  assert.equal(converging.status, 200);
  assert.deepEqual(converging.body, { id: "sample_two_step:1:tenant-a", key: "sample_two_step", version: 1 });
  assert.equal(state.deployments, 1);
});

test("a simultaneous representative without a visible result waits; only the reserving request deploys", async (t) => {
  const state = newState();
  mockBackend(t, state);
  // Reserve first (simulating the concurrent rep that holds the row), keep the
  // engine silent: the losing request must not deploy and must report the
  // defined pending conflict.
  state.ledger.set(key, { key, definition_id: "sample_two_step", input_hash: hashOf(sample), engine_id: null });
  await assert.rejects(publish({ xml: sample }), { status: 409, message: "deployment_pending_reconciliation" });
  assert.equal(state.deployments, 0);
  assert.ok(!state.calls.some(call => call.startsWith("POST /repository/deployments")));
  // The holder reserves next and deploys; the identical losing retry then replays.
  state.ledger.delete(key);
  const holder = await publish({ xml: sample });
  assert.equal(holder.status, 201);
  const replay = await publish({ xml: sample });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, { id: "sample_two_step:1:tenant-a", key: "sample_two_step", version: 1 });
  assert.equal(state.deployments, 1);
});

test("truly concurrent representatives deploy exactly once and both answer from durable state", async (t) => {
  const state = newState();
  mockBackend(t, state);
  const request = () => Object.assign(Readable.from([Buffer.from(JSON.stringify({ xml: sample }))]), {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": key },
  });
  const outcomes = await Promise.all([publishRaw(request()), publishRaw(request()), publishRaw(request())]);
  assert.equal(state.deployments, 1);
  const versions = outcomes.map(outcome => {
    assert.ok(outcome.status === 201 || outcome.status === 200 || outcome.status === 409);
    return outcome.status === 409 ? null : outcome.body;
  });
  const deployed = versions.filter(Boolean);
  assert.ok(deployed.length >= 1);
  for (const body of deployed) {
    assert.deepEqual(body, { id: "sample_two_step:1:tenant-a", key: "sample_two_step", version: 1 });
  }
  const settled = await publishRaw(request());
  assert.equal(settled.status, 200);
  assert.deepEqual(settled.body, { id: "sample_two_step:1:tenant-a", key: "sample_two_step", version: 1 });
});

test("engine data from another tenant is never returned or deployed to", async (t) => {
  const state = newState();
  mockBackend(t, state);
  state.definitions.set("sample_two_step:2:tenant-b", { id: "sample_two_step:2:tenant-b", key: "sample_two_step",
    version: 2, tenantId: "tenant-b", xml: sample, deploymentId: "dep-foreign" });
  state.ledger.set(key, { key, definition_id: "sample_two_step", input_hash: hashOf(sample), engine_id: "sample_two_step:2:tenant-b" });
  await assert.rejects(publish({ xml: sample }), { status: 409, message: "deployment_pending_reconciliation" });
  assert.equal(state.deployments, 0);
  state.ledger.delete(key);
  const result = await publish({ xml: sample });
  assert.equal(result.status, 201);
  assert.deepEqual(result.body, { id: "sample_two_step:1:tenant-a", key: "sample_two_step", version: 1 });
});

test("an engine deployment whose lookup leaves the tenant answers unavailable", async (t) => {
  const state = newState();
  t.mock.method(globalThis, "fetch", async (input, options = {}) => {
    const target = new URL(input);
    state.calls.push(`${options.method ?? "GET"} ${target.pathname}${target.search}`);
    if (target.origin === config.dataUrl) {
      if (options.method === "POST") return Response.json([{ key, definition_id: "sample_two_step",
        input_hash: hashOf(sample), engine_id: null }]);
      return Response.json([{ key, definition_id: "sample_two_step", input_hash: hashOf(sample),
        engine_id: "sample_two_step:1:tenant-a" }]);
    }
    if (target.pathname === "/repository/deployments") {
      state.deployments += 1;
      return Response.json({ id: "dep-1" });
    }
    if (target.pathname === "/repository/process-definitions") {
      return Response.json({ data: [{ id: "sample_two_step:1:tenant-a", key: "sample_two_step",
        version: 1, tenantId: "tenant-b" }] });
    }
    return new Response(null, { status: 404 });
  });
  await assert.rejects(publish({ xml: sample }), { status: 503, message: "workflow_unavailable" });
  assert.equal(state.deployments, 1);
});

test("unsupported methods stay undocumented 404s and queries are invalid", async (t) => {
  const state = newState();
  mockBackend(t, state);
  const response = { setHeader() {}, writeHead: () => assert.fail(), end: () => assert.fail() };
  await assert.rejects(handleWorkflow({ method: "PUT", headers: {} }, response, identity, config, url),
    { status: 404, message: "not_found" });
  const queried = await publishRaw(Object.assign(Readable.from([Buffer.from(JSON.stringify({ xml: sample }))]), {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": key },
  }), identity, new URL("http://core/v1/workflows/definitions?latest=true"));
  assert.deepEqual([queried.status, queried.error], [400, "invalid_query"]);
  assert.deepEqual(state.calls, []);
});
