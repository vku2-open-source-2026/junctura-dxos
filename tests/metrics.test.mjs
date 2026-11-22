// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { createApi } from "../src/api.mjs";
import {
  featureForPath, featureSeries, handleMetrics, recentRequests, recordRequest, resetMetrics, trafficSeries,
} from "../src/modules/metrics/metrics.mjs";
import { HttpError, json } from "../src/platform/http/http.mjs";

const identity = { tenantId: "tenant-a", subject: "auditor", issuer: "https://issuer.example", clientId: "management", roles: ["core-reader"] };
const listen = (server) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
});
const reply = (response, error) => json(response, error instanceof HttpError ? error.status : 500, { error: error.message });

let data, core, base, config, currentConfig;
let currentIdentity = identity;
let access, dataStatus, dataBody, seen;
const allowed = { status: 200, value: { allowed: true } };

before(async () => {
  data = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    seen.push({ path: request.url, method: request.method, headers: request.headers,
      body: JSON.parse(Buffer.concat(chunks).toString()) });
    if (dataStatus === "disconnect") return response.destroy();
    response.writeHead(dataStatus, { "Content-Type": "application/json" });
    response.end(dataBody ?? JSON.stringify(access));
  });
  config = { dataUrl: await listen(data), dataSecret: "x".repeat(32) };
  core = createServer(async (request, response) => {
    try { await handleMetrics(request, response, currentIdentity, currentConfig, new URL(request.url, "http://core")); }
    catch (error) { reply(response, error); }
  });
  base = await listen(core);
});
after(() => { data?.close(); core?.close(); });
beforeEach(() => {
  resetMetrics();
  currentIdentity = identity;
  currentConfig = config;
  access = allowed;
  dataStatus = 200;
  dataBody = undefined;
  seen = [];
});

const ZERO = { requests: 0, errors4xx: 0, errors5xx: 0, avgLatencyMs: 0, maxLatencyMs: 0 };

test("records requests into the current one-minute bucket and totals", () => {
  const now = Date.now();
  recordRequest({ tenantId: identity.tenantId, method: "GET", path: "/v1/applications", statusCode: 200, durationMs: 10, at: now });
  recordRequest({ tenantId: identity.tenantId, method: "POST", path: "/v1/applications", statusCode: 404, durationMs: 20, at: now });
  recordRequest({ tenantId: identity.tenantId, method: "GET", path: "/v1/approvals", statusCode: 503, durationMs: 40, at: now });
  const series = trafficSeries({ tenantId: identity.tenantId, minutes: 60 });
  assert.equal(series.intervalSeconds, 60);
  assert.equal(series.buckets.length, 60);
  const current = series.buckets.at(-1);
  assert.deepEqual(
    [current.requests, current.errors4xx, current.errors5xx, current.avgLatencyMs, current.maxLatencyMs],
    [3, 1, 1, 23, 40],
  );
  assert.deepEqual(series.totals, { requests: 3, errors4xx: 1, errors5xx: 1, avgLatencyMs: 23, maxLatencyMs: 40 });
  assert.ok(series.buckets.slice(0, -1).every((bucket) => bucket.requests === 0 && bucket.avgLatencyMs === 0));
  assert.ok(Date.parse(series.buckets[0].at) < Date.parse(series.buckets.at(-1).at));
});

test("empty minutes are returned as zero buckets in chronological order", () => {
  const series = trafficSeries({ tenantId: identity.tenantId, minutes: 1440 });
  assert.equal(series.buckets.length, 1440);
  assert.ok(series.buckets.every((bucket) => Object.entries(bucket).every(([key, value]) => key === "at" || value === ZERO[key])));
  assert.equal(series.totals.requests, 0);
  assert.equal(series.from, series.buckets[0].at);
});

test("recent requests stay newest-first and bounded by the 200-entry ring", () => {
  for (let index = 0; index <= 204; index += 1) {
    recordRequest({ tenantId: identity.tenantId, method: "GET", path: `/items/r${index}`, statusCode: 200, durationMs: 1, at: Date.now() });
  }
  const items = recentRequests({ tenantId: identity.tenantId, limit: 100 });
  assert.equal(items.length, 100);
  assert.equal(items[0].path, "/items/r204");
  assert.equal(items.at(-1).path, "/items/r105");
  assert.equal(recentRequests({ tenantId: identity.tenantId }).length, 20);
  assert.equal(recentRequests({ tenantId: identity.tenantId, limit: 1000 }).length, 100);
});

test("recent paths never carry queries, tokens or identifiers", () => {
  const userId = "11111111-1111-4111-8111-111111111111";
  recordRequest({ tenantId: identity.tenantId,
    method: "GET",
    path: `/v1/me/${userId}/tokens/${"a".repeat(40)}?access_token=secret#fragment`,
    statusCode: 200,
    durationMs: 5,
    at: Date.now(),
  });
  const [item] = recentRequests({ tenantId: identity.tenantId, limit: 1 });
  assert.equal(item.path, "/v1/me/:id/tokens/:token");
  assert.equal(item.path.includes("secret"), false);
  assert.equal(JSON.stringify(item).includes("access_token"), false);
  recordRequest({ tenantId: identity.tenantId, method: "GET", path: "/v1/users/12345?token=other", statusCode: 200, durationMs: 1, at: Date.now() });
  assert.equal(recentRequests({ tenantId: identity.tenantId, limit: 1 })[0].path, "/v1/users/:id");
});

test("traffic route validates method, query and limits", async () => {
  recordRequest({ tenantId: identity.tenantId, method: "GET", path: "/v1/applications", statusCode: 200, durationMs: 4 });
  const response = await fetch(`${base}/v1/metrics/traffic?minutes=5`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.buckets.length, 5);
  assert.equal(body.intervalSeconds, 60);
  assert.equal(body.totals.requests, 1);
  for (const bad of ["?minutes=0", "?minutes=1441", "?minutes=abc", "?minutes=", "?minutes=5&minutes=6", "?limit=5"]) {
    assert.equal((await fetch(`${base}/v1/metrics/traffic${bad}`)).status, 400, bad);
  }
  const post = await fetch(`${base}/v1/metrics/traffic`, { method: "POST" });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET");
});

test("recent route validates method, query and limits", async () => {
  recordRequest({ tenantId: identity.tenantId, method: "GET", path: "/v1/applications", statusCode: 200, durationMs: 4 });
  const response = await fetch(`${base}/v1/metrics/requests?limit=5`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).items.length, 1);
  for (const bad of ["?limit=0", "?limit=101", "?limit=abc", "?limit=", "?limit=5&limit=6", "?minutes=5"]) {
    assert.equal((await fetch(`${base}/v1/metrics/requests${bad}`)).status, 400, bad);
  }
  const post = await fetch(`${base}/v1/metrics/requests`, { method: "POST" });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET");
});

test("a principal without a verified client id fails closed", async () => {
  currentIdentity = { tenantId: "tenant-a", subject: "auditor", roles: ["core-reader"] };
  const response = await fetch(`${base}/v1/metrics/traffic`);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "verified_client_required");
  assert.equal(seen.length, 0);
});

test("all metrics require audit.read for a core-reader with a verified client", async () => {
  for (const name of ["traffic", "features", "requests"]) {
    access = { status: 403, error: "workflow_audit_permission_required" };
    const denied = await fetch(`${base}/v1/metrics/${name}`);
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error, "metrics_permission_required");
    access = allowed;
    const permitted = await fetch(`${base}/v1/metrics/${name}`);
    assert.equal(permitted.status, 200);
    await permitted.json();
  }
  assert.equal(seen.length, 6);
  for (const call of seen) {
    assert.equal(call.path, "/rpc/workflow_audit_access");
    assert.equal(call.method, "POST");
    assert.equal(call.headers["content-type"], "application/json");
    assert.deepEqual(call.body, { payload: {} });
    const claims = JSON.parse(Buffer.from(call.headers.authorization.split(".")[1], "base64url"));
    assert.equal(claims.role, "junctura_workflow_audit_api");
    assert.equal(claims.tenant_id, identity.tenantId);
    assert.equal(claims.iss, identity.issuer);
    assert.equal(claims.sub, identity.subject);
    assert.equal(claims.client_id, identity.clientId);
    assert.equal(claims.aud, "junctura-data");
  }
});

test("database HTTP 403 maps to metrics_permission_required", async () => {
  dataStatus = 403;
  access = { error: "workflow_audit_permission_required" };
  const response = await fetch(`${base}/v1/metrics/traffic`);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "metrics_permission_required");
});

test("missing data configuration and database failures fail closed", async () => {
  for (const failure of ["missing-url", "missing-secret", "disconnect", "http-error", "invalid-json", "null", "denied-value", "missing-value", "rpc-error"]) {
    currentConfig = failure === "missing-url" ? {} : failure === "missing-secret" ? { dataUrl: config.dataUrl } : config;
    dataStatus = failure === "disconnect" ? "disconnect" : failure === "http-error" ? 500 : 200;
    dataBody = failure === "invalid-json" ? "{" : failure === "null" ? "null" : undefined;
    access = failure === "denied-value" ? { status: 200, value: { allowed: false } }
      : failure === "missing-value" ? { status: 200 }
        : failure === "rpc-error" ? { status: 500, error: "database_error" } : allowed;
    const response = await fetch(`${base}/v1/metrics/traffic`);
    assert.equal(response.status, 503, failure);
    assert.equal((await response.json()).error, "metrics_unavailable", failure);
  }
});

test("method and query validation run before database authorization", async () => {
  access = { status: 403, error: "workflow_audit_permission_required" };
  for (const name of ["traffic", "features", "requests"]) {
    const post = await fetch(`${base}/v1/metrics/${name}`, { method: "POST" });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("allow"), "GET");
    await post.json();
    const bad = await fetch(`${base}/v1/metrics/${name}?unknown=1`);
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, "invalid_metrics_query");
  }
  assert.equal(seen.length, 0);
});

test("traffic, features and request paths are isolated by tenant", async () => {
  recordRequest({ tenantId: "tenant-a", method: "GET", path: "/v1/data/private-a", statusCode: 200, durationMs: 10 });
  assert.equal(trafficSeries({ tenantId: "tenant-a" }).totals.requests, 1);
  assert.deepEqual(featureSeries({ tenantId: "tenant-a" }).features.map((item) => item.feature), ["data"]);
  assert.deepEqual(recentRequests({ tenantId: "tenant-a" }).map((item) => item.path), ["/v1/data/private-a"]);
  assert.deepEqual(trafficSeries({ tenantId: "tenant-b" }).totals, ZERO);
  assert.deepEqual(featureSeries({ tenantId: "tenant-b" }).features, []);
  assert.deepEqual(recentRequests({ tenantId: "tenant-b" }), []);
  currentIdentity = { ...identity, tenantId: "tenant-b" };
  const traffic = await fetch(`${base}/v1/metrics/traffic`);
  assert.deepEqual((await traffic.json()).totals, ZERO);
  const features = await fetch(`${base}/v1/metrics/features`);
  assert.deepEqual((await features.json()).features, []);
  const requests = await fetch(`${base}/v1/metrics/requests`);
  assert.deepEqual((await requests.json()).items, []);
  recordRequest({ tenantId: "tenant-b", method: "GET", path: "/v1/objects/private-b", statusCode: 503, durationMs: 30 });
  assert.equal(trafficSeries({ tenantId: "tenant-a" }).totals.errors5xx, 0);
  assert.equal(trafficSeries({ tenantId: "tenant-b" }).totals.errors5xx, 1);
  assert.deepEqual(featureSeries({ tenantId: "tenant-b" }).features.map((item) => item.feature), ["files"]);
  assert.deepEqual(recentRequests({ tenantId: "tenant-b" }).map((item) => item.path), ["/v1/objects/private-b"]);
});

test("requests without a valid tenant are never recorded", () => {
  for (const tenantId of [undefined, null, "", "Tenant-a", "1tenant", "tenant_a", "a".repeat(64), 42, {}, ["tenant-a"]]) {
    recordRequest({ tenantId, method: "GET", path: "/v1/data/records", statusCode: 200, durationMs: 1 });
    assert.deepEqual(trafficSeries({ tenantId }).totals, ZERO);
    assert.deepEqual(featureSeries({ tenantId }).features, []);
    assert.deepEqual(recentRequests({ tenantId }), []);
  }
  recordRequest({ method: "GET", path: "/v1/data/records", statusCode: 200, durationMs: 1 });
  assert.deepEqual(trafficSeries().totals, ZERO);
  assert.deepEqual(featureSeries().features, []);
  assert.deepEqual(recentRequests(), []);
  for (const tenantId of ["a", "a".repeat(63)]) {
    recordRequest({ tenantId, method: "GET", path: "/v1/data/records", statusCode: 200, durationMs: 1 });
    assert.equal(trafficSeries({ tenantId }).totals.requests, 1);
  }
});

test("probes and 401 responses are excluded even with a valid tenant", () => {
  for (const [path, statusCode] of [["/health", 200], ["/ready?probe=1", 503], ["/v1/data/records", 401]]) {
    recordRequest({ tenantId: "tenant-a", method: "GET", path, statusCode, durationMs: 1 });
  }
  assert.deepEqual(trafficSeries({ tenantId: "tenant-a" }).totals, ZERO);
  assert.deepEqual(featureSeries({ tenantId: "tenant-a" }).features, []);
  assert.deepEqual(recentRequests({ tenantId: "tenant-a" }), []);
});

test("tenant stores evict the least recently written after 256 tenants", () => {
  const record = (tenantId) => recordRequest({ tenantId, path: "/v1/data/records", statusCode: 200 });
  for (let index = 0; index < 256; index += 1) record(`tenant-${index}`);
  // Reading the oldest store does not prolong its lifetime; writing does.
  assert.equal(trafficSeries({ tenantId: "tenant-0" }).totals.requests, 1);
  featureSeries({ tenantId: "tenant-0" });
  recentRequests({ tenantId: "tenant-0" });
  record("tenant-1");
  record("tenant-256");
  record("tenant-257");
  for (const tenantId of ["tenant-0", "tenant-2"]) {
    assert.deepEqual(trafficSeries({ tenantId }).totals, ZERO);
    assert.deepEqual(featureSeries({ tenantId }).features, []);
    assert.deepEqual(recentRequests({ tenantId }), []);
  }
  assert.equal(trafficSeries({ tenantId: "tenant-1" }).totals.requests, 2);
  assert.equal(trafficSeries({ tenantId: "tenant-257" }).totals.requests, 1);
});

test("resetMetrics clears all tenant stores", () => {
  for (const tenantId of ["tenant-a", "tenant-b"]) recordRequest({ tenantId, path: "/v1/data/records", statusCode: 200 });
  resetMetrics();
  for (const tenantId of ["tenant-a", "tenant-b"]) {
    assert.deepEqual(trafficSeries({ tenantId }).totals, ZERO);
    assert.deepEqual(featureSeries({ tenantId }).features, []);
    assert.deepEqual(recentRequests({ tenantId }), []);
  }
});

test("the router attributes authorized requests to the verified tenant", async () => {
  const auth = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const token = new URLSearchParams(Buffer.concat(chunks).toString()).get("token");
    const tenantId = token === "tenant-a-token" ? "tenant-a" : "tenant-b";
    json(response, 200, {
      active: token !== "invalid-token", iss: identity.issuer, aud: "junctura-core",
      exp: Math.floor(Date.now() / 1000) + 300, sub: identity.subject,
      tenant_id: tenantId, tenant_memberships: [tenantId], client_id: identity.clientId,
      realm_access: { roles: identity.roles },
    });
  });
  const identityUrl = await listen(auth);
  const route = createApi({ ...config, identityUrl, issuer: identity.issuer, clientSecret: "test-client-secret" });
  const server = createServer(async (request, response) => {
    try { await route(request, response); }
    catch (error) { reply(response, error); }
  });
  try {
    const url = await listen(server);
    for (const [path, authorization, status] of [
      ["/not-a-route", undefined, 404],
      ["/v1/identity", undefined, 401],
      ["/v1/identity", "Bearer invalid-token", 401],
    ]) {
      const response = await fetch(`${url}${path}`, {
        headers: { "X-Tenant-Id": "tenant-a", ...(authorization ? { Authorization: authorization } : {}) },
      });
      assert.equal(response.status, status);
      await response.json();
    }
    assert.deepEqual(recentRequests({ tenantId: "tenant-a" }), []);
    for (const tenantId of ["tenant-a", "tenant-b"]) {
      const response = await fetch(`${url}/v1/identity`, {
        headers: { Authorization: `Bearer ${tenantId}-token`, "X-Tenant-Id": "tenant-c" },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { tenantId, subject: identity.subject, roles: identity.roles, units: [], groups: [] });
      const [item] = recentRequests({ tenantId, limit: 1 });
      assert.deepEqual([item.method, item.path, item.status], ["GET", "/v1/identity", 200]);
      assert.ok(item.durationMs >= 0);
      assert.equal(trafficSeries({ tenantId }).totals.requests, 1);
    }
    assert.deepEqual(recentRequests({ tenantId: "tenant-c" }), []);
    const response = await fetch(`${url}/v1/metrics/requests`, {
      headers: { Authorization: "Bearer tenant-a-token" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).items.map((item) => item.path), ["/v1/identity"]);
    assert.equal(trafficSeries({ tenantId: "tenant-a" }).totals.requests, 2);
    assert.equal(trafficSeries({ tenantId: "tenant-b" }).totals.requests, 1);
  } finally {
    server.close();
    auth.close();
  }
});

test("requests are assigned to fixed features and grouped per minute", () => {
  const now = Date.now();
  recordRequest({ tenantId: identity.tenantId, method: "GET", path: "/v1/data/records?limit=1", statusCode: 200, durationMs: 10, at: now });
  recordRequest({ tenantId: identity.tenantId, method: "POST", path: "/v2/data/records/11111111-1111-4111-8111-111111111111", statusCode: 201, durationMs: 30, at: now });
  recordRequest({ tenantId: identity.tenantId, method: "GET", path: "/v1/objects/11111111-1111-4111-8111-111111111111", statusCode: 500, durationMs: 50, at: now });
  recordRequest({ tenantId: identity.tenantId, method: "GET", path: "/v1/workflows/executions", statusCode: 403, durationMs: 5, at: now });
  recordRequest({ tenantId: identity.tenantId, method: "GET", path: "/v1/trust/graph", statusCode: 200, durationMs: 7, at: now });
  recordRequest({ tenantId: identity.tenantId, method: "GET", path: "/v2/resource-shares", statusCode: 200, durationMs: 9, at: now });
  recordRequest({ tenantId: identity.tenantId, method: "GET", path: "/v1/metrics/traffic", statusCode: 200, durationMs: 2, at: now });
  recordRequest({ tenantId: identity.tenantId, method: "GET", path: "/v1/identity", statusCode: 200, durationMs: 3, at: now });
  const summary = featureSeries({ tenantId: identity.tenantId, minutes: 3 });
  assert.equal(summary.from, summary.features[0].series[0].at);
  assert.equal(summary.features[0].series.length, 3);
  assert.deepEqual(summary.features.map((item) => item.feature), ["data", "other", "sharing", "files", "workflows"]);
  const data = summary.features[0];
  assert.deepEqual(
    [data.requests, data.errors4xx, data.errors5xx, data.avgLatencyMs, data.maxLatencyMs],
    [2, 0, 0, 20, 30],
  );
  assert.equal(data.series.at(-1).requests, 2);
  assert.equal(summary.features.find((item) => item.feature === "files").errors5xx, 1);
  assert.equal(summary.features.find((item) => item.feature === "workflows").errors4xx, 1);
  assert.equal(summary.features.find((item) => item.feature === "other").requests, 2);
});

test("feature path matching is segment aware and unknown routes fall back to other", () => {
  assert.equal(featureForPath("/v1/data/records"), "data");
  assert.equal(featureForPath("/v2/data/records"), "data");
  assert.equal(featureForPath("/v1/database"), "other");
  assert.equal(featureForPath("/v1/capability-executions/abc"), "capabilities");
  assert.equal(featureForPath("/v1/emergency-accesses"), "consents");
  assert.equal(featureForPath("/v1/directory/principals"), "other");
  assert.equal(featureForPath("/v2/secrets/key"), "secrets");
});

test("feature route validates method, query and limits", async () => {
  recordRequest({ tenantId: identity.tenantId, method: "GET", path: "/v1/audit-events", statusCode: 200, durationMs: 4 });
  const response = await fetch(`${base}/v1/metrics/features?minutes=5`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.features[0].feature, "audit");
  assert.equal(body.features[0].series.length, 5);
  for (const bad of ["?minutes=0", "?minutes=1441", "?minutes=abc", "?minutes=", "?minutes=5&minutes=6", "?limit=5"]) {
    assert.equal((await fetch(`${base}/v1/metrics/features${bad}`)).status, 400, bad);
  }
  const post = await fetch(`${base}/v1/metrics/features`, { method: "POST" });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET");
});
