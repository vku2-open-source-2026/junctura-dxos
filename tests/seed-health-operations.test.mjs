// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import {
  ADMIN_PROFILES,
  APPLICATION_PROFILES,
  seedApprovalQueue,
  seedConsents,
  seedPrincipalProfiles,
  seedWorkflowRequests,
  workflowSeedItems,
} from "../scripts/lib/seed-health-operations.mjs";
import { HEALTH_APPS, HEALTH_CAPABILITIES, generateHealthDataset } from "../scripts/lib/seed-health-data.mjs";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function bodyOf(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function listen(handler) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const json = (status, value, headers = {}) => {
      response.writeHead(status, { "Content-Type": "application/json", ...headers });
      response.end(JSON.stringify(value));
    };
    try { await handler({ request, response, url, json, body: bodyOf }); }
    catch { json(500, { error: "fixture_failure" }); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const api = (path, token, body, headers = {}, method = body === undefined ? "GET" : "POST") =>
    fetch(baseUrl + path, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
  return { baseUrl, api, close: () => new Promise(resolve => server.close(resolve)) };
}

function appsFixture() {
  return Object.fromEntries(HEALTH_APPS.map(app => [app.name, {
    appId: `app-${app.name}`, subject: `subject-${app.name}`, token: `token-${app.name}`,
  }]));
}

function publishedFixture(apps) {
  return Object.fromEntries(HEALTH_CAPABILITIES.map(capability => [`${capability.app}/${capability.name}`, {
    capabilityId: `urn:junctura:capability:${apps[capability.app].appId}:${capability.name}`,
    version: "1.0.0",
    digest: `sha256:${"a".repeat(64)}`,
    manifest: { requiredPermissions: [`urn:junctura:permission:${apps[capability.app].appId}:invoke`] },
  }]));
}

test("workflow seed items are deterministic, unique and cover every outcome", () => {
  const dataset = generateHealthDataset({ seed: 36 });
  const first = workflowSeedItems(dataset);
  assert.deepEqual(first, workflowSeedItems(dataset));
  assert.equal(new Set(first.map(item => item.idempotencyKey)).size, first.length);
  assert.ok(first.every(item => uuid.test(item.idempotencyKey)));
  assert.deepEqual(new Set(first.map(item => item.outcome)), new Set(["pending", "approved", "rejected"]));
  assert.deepEqual(new Set(first.map(item => item.definitionKey)),
    new Set(["junctura_chuyen_tuyen", "junctura_xac_minh_don_thuoc", "junctura_xac_minh_chi_phi"]));
  assert.ok(first.some(item => item.input.loai === "chuyen-tuyen"));
  assert.ok(first.some(item => item.input.loai === "xac-minh-don-thuoc"));
  assert.ok(first.some(item => item.input.loai === "xac-minh-chi-phi"));
});

test("workflow requests start once, complete approved and cancel rejected items", async () => {
  const executions = new Map();
  const keys = new Map();
  let next = 1;
  const stack = await listen(async ({ request, url, json, body }) => {
    if (request.headers.authorization !== "Bearer owner-token") return json(403, { error: "forbidden" });
    if (request.method === "POST" && url.pathname === "/v1/workflows/executions") {
      const key = request.headers["idempotency-key"];
      if (!uuid.test(key)) return json(400, { error: "uuid_idempotency_key_required" });
      if (keys.has(key)) return json(200, executions.get(keys.get(key)));
      const value = JSON.parse((await body(request)).toString("utf8"));
      const execution = { id: `execution-${next++}`, definitionId: value.definitionId, status: "running", input: value.input };
      executions.set(execution.id, execution);
      keys.set(key, execution.id);
      return json(201, execution);
    }
    const complete = url.pathname.match(/^\/v1\/workflows\/executions\/([^/]+)\/complete$/);
    if (request.method === "POST" && complete) {
      const execution = executions.get(complete[1]);
      execution.status = "completed";
      return json(200, execution);
    }
    const cancel = url.pathname.match(/^\/v1\/workflows\/executions\/([^/]+)$/);
    if (request.method === "DELETE" && cancel) {
      executions.get(cancel[1]).status = "cancelled";
      return json(204, null);
    }
    return json(404, { error: "not_found" });
  });
  try {
    const items = workflowSeedItems(generateHealthDataset({ seed: 36 }));
    const definitions = new Map(["junctura_chuyen_tuyen", "junctura_xac_minh_don_thuoc", "junctura_xac_minh_chi_phi"]
      .map(key => [key, { id: `definition-${key}` }]));
    const first = await seedWorkflowRequests({ api: stack.api, token: "owner-token", definitions, items });
    assert.deepEqual(first, { created: items.length, existing: 0, completed: 4, cancelled: 1, pending: 4 });
    assert.equal(executions.size, items.length);
    const second = await seedWorkflowRequests({ api: stack.api, token: "owner-token", definitions, items });
    assert.deepEqual(second, { created: 0, existing: items.length, completed: 4, cancelled: 1, pending: 4 });
    assert.equal(executions.size, items.length);
  } finally {
    await stack.close();
  }
});

test("approval queue creates pending and rejected proposals idempotently", async () => {
  const apps = appsFixture();
  const published = publishedFixture(apps);
  const grants = [];
  const stack = await listen(async ({ request, url, json, body }) => {
    if (request.method === "POST" && url.pathname === "/v1/trust/grants") {
      const value = JSON.parse((await body(request)).toString("utf8"));
      const grant = { grantId: `grant-${grants.length + 1}`, revision: 1, state: "pending",
        providerAppId: value.providerAppId, consumerAppId: value.consumerAppId,
        capabilityId: value.capabilities[0].capabilityId, version: value.capabilities[0].version };
      grants.push(grant);
      return json(201, grant, { ETag: `"grant-${grant.grantId}-1"` });
    }
    const revoke = url.pathname.match(/^\/v1\/trust\/grants\/([^/]+)\/revoke$/);
    if (request.method === "POST" && revoke) {
      const grant = grants.find(value => value.grantId === revoke[1]);
      if (request.headers["if-match"] !== `"grant-${grant.grantId}-1"`) return json(412, { error: "stale" });
      if (!JSON.parse((await body(request)).toString("utf8")).reason) return json(400, { error: "reason_required" });
      grant.state = "revoked";
      return json(200, grant);
    }
    return json(404, { error: "not_found" });
  });
  try {
    const owner = { token: "owner-token" };
    const first = await seedApprovalQueue({ api: stack.api, edges: [], owner, apps, published });
    assert.deepEqual(first, { pending: 2, rejected: 1, existing: 0 });
    assert.equal(grants.filter(grant => grant.state === "pending").length, 2);
    assert.equal(grants.filter(grant => grant.state === "revoked").length, 1);
    const second = await seedApprovalQueue({ api: stack.api, edges: grants.map(grant => ({ ...grant })), owner, apps, published });
    assert.deepEqual(second, { pending: 0, rejected: 0, existing: 3 });
    assert.equal(grants.length, 3);
  } finally {
    await stack.close();
  }
});

test("consents are created for the signed-in person and one is revoked", async () => {
  const apps = appsFixture();
  const published = publishedFixture(apps);
  const rows = [];
  let next = 1;
  const stack = await listen(async ({ request, url, json, body }) => {
    if (request.headers.authorization !== "Bearer admin-token") return json(403, { error: "forbidden" });
    if (request.method === "GET" && url.pathname === "/v1/me/consents") return json(200, { consents: rows });
    if (request.method === "POST" && url.pathname === "/v1/me/consents") {
      const value = JSON.parse((await body(request)).toString("utf8"));
      const consent = { consentId: `consent-${next++}`, consumer: { appId: value.consumerAppId }, capabilityId: value.capabilityId, state: "active" };
      rows.push(consent);
      return json(201, consent);
    }
    const revoke = url.pathname.match(/^\/v1\/me\/consents\/([^/]+)\/revoke$/);
    if (request.method === "POST" && revoke) {
      const consent = rows.find(value => value.consentId === revoke[1]);
      consent.state = "revoked";
      return json(200, consent);
    }
    return json(404, { error: "not_found" });
  });
  try {
    const first = await seedConsents({ api: stack.api, token: "admin-token", apps, published });
    assert.deepEqual(first, { active: 2, revoked: 1, existing: 0 });
    assert.equal(rows.filter(row => row.state === "active").length, 2);
    assert.equal(rows.filter(row => row.state === "revoked").length, 1);
    const second = await seedConsents({ api: stack.api, token: "admin-token", apps, published });
    assert.deepEqual(second, { active: 0, revoked: 0, existing: 3 });
    assert.equal(rows.length, 3);
  } finally {
    await stack.close();
  }
});

test("principal profiles update three administrators and upsert two applications", async () => {
  const apps = appsFixture();
  const statements = [];
  const stack = {
    tenant: "tenant-a", issuer: "https://identity.example.invalid/realms/junctura", q: value => `'${value}'`,
    admin: async path => ({ json: async () => path.includes("admin3") ? [] :
      ADMIN_PROFILES.filter(user => path.includes(user.username)).map(user => ({ id: `id-${user.username}` })) }),
    sql: async text => {
      statements.push(text);
      return text.includes("INSERT") ? "subject-app" : "id";
    },
  };
  const stats = await seedPrincipalProfiles({ stack, apps });
  assert.deepEqual(stats, { admins: 2, applications: APPLICATION_PROFILES.length, missing: ["admin3"] });
  assert.equal(statements.filter(text => text.startsWith("UPDATE")).length, 2);
  assert.equal(statements.filter(text => text.startsWith("INSERT")).length, APPLICATION_PROFILES.length);
  assert.ok(statements.every(text => !text.includes("permissions=") || text.includes("ARRAY[]::text[]")));
  assert.ok(statements.filter(text => text.startsWith("UPDATE")).every(text => text.includes("kind='admin'")));
});
