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

const identity = { tenantId: "tenant-a", subject: "auditor", clientId: "management", roles: ["core-reader"] };
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
const reply = (response, error) => json(response, error instanceof HttpError ? error.status : 500, { error: error.message });

let core, base;
let currentIdentity = identity;

before(async () => {
  core = createServer(async (request, response) => {
    try { await handleMetrics(request, response, currentIdentity, {}, new URL(request.url, "http://core")); }
    catch (error) { reply(response, error); }
  });
  base = await listen(core);
});
after(() => core.close());
beforeEach(() => { resetMetrics(); currentIdentity = identity; });

const ZERO = { requests: 0, errors4xx: 0, errors5xx: 0, avgLatencyMs: 0, maxLatencyMs: 0 };

test("records requests into the current one-minute bucket and totals", () => {
  const now = Date.now();
  recordRequest({ method: "GET", path: "/v1/applications", statusCode: 200, durationMs: 10, at: now });
  recordRequest({ method: "POST", path: "/v1/applications", statusCode: 404, durationMs: 20, at: now });
  recordRequest({ method: "GET", path: "/v1/approvals", statusCode: 503, durationMs: 40, at: now });
  const series = trafficSeries({ minutes: 60 });
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
  const series = trafficSeries({ minutes: 1440 });
  assert.equal(series.buckets.length, 1440);
  assert.ok(series.buckets.every((bucket) => Object.entries(bucket).every(([key, value]) => key === "at" || value === ZERO[key])));
  assert.equal(series.totals.requests, 0);
  assert.equal(series.from, series.buckets[0].at);
});

test("recent requests stay newest-first and bounded by the 200-entry ring", () => {
  for (let index = 0; index <= 204; index += 1) {
    recordRequest({ method: "GET", path: `/items/r${index}`, statusCode: 200, durationMs: 1, at: Date.now() });
  }
  const items = recentRequests({ limit: 100 });
  assert.equal(items.length, 100);
  assert.equal(items[0].path, "/items/r204");
  assert.equal(items.at(-1).path, "/items/r105");
  assert.equal(recentRequests().length, 20);
  assert.equal(recentRequests({ limit: 1000 }).length, 100);
});

test("recent paths never carry queries, tokens or identifiers", () => {
  const userId = "11111111-1111-4111-8111-111111111111";
  recordRequest({
    method: "GET",
    path: `/v1/me/${userId}/tokens/${"a".repeat(40)}?access_token=secret#fragment`,
    statusCode: 200,
    durationMs: 5,
    at: Date.now(),
  });
  const [item] = recentRequests({ limit: 1 });
  assert.equal(item.path, "/v1/me/:id/tokens/:token");
  assert.equal(item.path.includes("secret"), false);
  assert.equal(JSON.stringify(item).includes("access_token"), false);
  recordRequest({ method: "GET", path: "/v1/users/12345?token=other", statusCode: 200, durationMs: 1, at: Date.now() });
  assert.equal(recentRequests({ limit: 1 })[0].path, "/v1/users/:id");
});

test("traffic route validates method, query and limits", async () => {
  recordRequest({ method: "GET", path: "/v1/applications", statusCode: 200, durationMs: 4 });
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
  recordRequest({ method: "GET", path: "/v1/applications", statusCode: 200, durationMs: 4 });
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
});

test("the router records every finished request without affecting the response", async () => {
  const route = createApi({});
  const server = createServer(async (request, response) => {
    try { await route(request, response); }
    catch (error) { reply(response, error); }
  });
  const url = await listen(server);
  try {
    const response = await fetch(`${url}/not-a-route`);
    assert.equal(response.status, 404);
    const [item] = recentRequests({ limit: 1 });
    assert.deepEqual([item.method, item.path, item.status], ["GET", "/not-a-route", 404]);
    assert.ok(item.durationMs >= 0);
  } finally {
    server.close();
  }
});

test("requests are assigned to fixed features and grouped per minute", () => {
  const now = Date.now();
  recordRequest({ method: "GET", path: "/v1/data/records?limit=1", statusCode: 200, durationMs: 10, at: now });
  recordRequest({ method: "POST", path: "/v2/data/records/11111111-1111-4111-8111-111111111111", statusCode: 201, durationMs: 30, at: now });
  recordRequest({ method: "GET", path: "/v1/objects/11111111-1111-4111-8111-111111111111", statusCode: 500, durationMs: 50, at: now });
  recordRequest({ method: "GET", path: "/v1/workflows/executions", statusCode: 401, durationMs: 5, at: now });
  recordRequest({ method: "GET", path: "/v1/trust/graph", statusCode: 200, durationMs: 7, at: now });
  recordRequest({ method: "GET", path: "/v2/resource-shares", statusCode: 200, durationMs: 9, at: now });
  recordRequest({ method: "GET", path: "/v1/metrics/traffic", statusCode: 200, durationMs: 2, at: now });
  recordRequest({ method: "GET", path: "/v1/identity", statusCode: 200, durationMs: 3, at: now });
  const summary = featureSeries({ minutes: 3 });
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
  recordRequest({ method: "GET", path: "/v1/audit-events", statusCode: 200, durationMs: 4 });
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
