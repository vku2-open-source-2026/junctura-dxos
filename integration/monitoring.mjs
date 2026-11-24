// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Monitoring integration checks. Requires the compose stack with Core running
// and, for the Prometheus and Grafana cases, the monitoring profile started
// with: docker compose --profile monitoring up --detach --wait prometheus grafana
import assert from "node:assert/strict";
import { test } from "node:test";
import { monitoringFixture } from "./fixtures/monitoring.mjs";

const { coreMetrics, gateway, prometheusJson, grafanaJson, prometheusOrigin, grafanaOrigin } = monitoringFixture();

// Same fixed route vocabulary the core counters clamp every path into.
const ROUTES = new Set(["data", "files", "workflows", "approvals", "sharing", "capabilities",
  "applications", "consents", "secrets", "audit", "other"]);
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

const waitForSample = async (query, deadlineMs = 60_000) => {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const result = await prometheusJson(`/api/v1/query?query=${encodeURIComponent(query)}`);
    assert.equal(result.status, "success", query);
    if (result.data.result.length) return result.data.result;
    if (Date.now() > deadline) throw new Error(`${prometheusOrigin} never returned samples for ${query}`);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
};

test("the gateway never proxies the metrics endpoint", async () => {
  const response = await gateway("/metrics");
  assert.equal(response.status, 404);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  assert.deepEqual(await response.json(), { error: "not_found" });
});

test("core serves unauthenticated Prometheus text on its internal network", async () => {
  const { warmupStatus, get, post } = await coreMetrics();
  // The probe issues one counted GET /metrics-probe (answered 404, route
  // "other") so the counter series below exists even on a freshly started Core;
  // /metrics itself is excluded from its own counters.
  assert.equal(warmupStatus, 404);
  assert.equal(get.status, 200);
  assert.equal(get.contentType, "text/plain; version=0.0.4; charset=utf-8");
  assert.equal(get.cacheControl, "no-store");
  assert.ok(get.body.startsWith("# HELP junctura_core_requests_total"), get.body);
  assert.ok(get.body.includes("# TYPE junctura_core_requests_total counter"), get.body);
  assert.match(get.body, /junctura_core_requests_total\{method="GET",route="[a-z]+",code="\d+"\} \d+/);
  assert.match(get.body, /junctura_core_requests_total\{method="GET",route="other",code="404"\} \d+/);
  assert.ok(get.body.includes("# TYPE junctura_core_request_duration_seconds_total counter"), get.body);
  for (const gauge of ["process_uptime_seconds", "process_start_time_seconds",
    "process_resident_memory_bytes", "process_heap_used_bytes"]) {
    const line = get.body.split("\n").find(candidate => candidate.startsWith(`${gauge} `));
    assert.ok(line, gauge);
    assert.ok(Number(line.split(" ")[1]) >= 0, gauge);
  }
  assert.equal(post.status, 405);
  assert.equal(post.allow, "GET");
  assert.deepEqual(JSON.parse(post.body), { error: "method_not_allowed" });
});

test("prometheus scrapes the core target over the internal network", { timeout: 120_000 }, async () => {
  // The first scrape can run before Core joins the network; wait for a healthy one.
  const [up] = await waitForSample('up{job="core"} == 1');
  assert.equal(up.value[1], "1");
  assert.equal(up.metric.job, "core");
  const { data: { activeTargets } } = await prometheusJson("/api/v1/targets");
  const core = activeTargets.find(target => target.labels.job === "core");
  assert.ok(core, "active core target");
  assert.equal(core.health, "up");
  assert.equal(core.scrapeUrl, "http://core:8080/metrics");
  const counters = await prometheusJson(`/api/v1/query?query=${encodeURIComponent("junctura_core_requests_total")}`);
  assert.equal(counters.status, "success");
  assert.ok(counters.data.result.length > 0);
  for (const series of counters.data.result) {
    assert.equal(series.metric.__name__, "junctura_core_requests_total");
    assert.ok(ROUTES.has(series.metric.route), series.metric.route);
    assert.ok(METHODS.has(series.metric.method) || series.metric.method === "OTHER", series.metric.method);
    assert.ok(/^\d+$/.test(series.metric.code), series.metric.code);
    assert.ok(Number(series.value[1]) >= 0);
  }
});

test("grafana provisions the prometheus datasource and the core dashboard", async () => {
  const health = await grafanaJson("/api/health");
  assert.equal(health.database, "ok");
  const datasources = await grafanaJson("/api/datasources");
  const datasource = datasources.find(candidate => candidate.type === "prometheus" && candidate.name === "Prometheus");
  assert.ok(datasource, "provisioned Prometheus datasource");
  assert.equal(datasource.url, "http://prometheus:9090");
  assert.equal(datasource.isDefault, true);
  const { dashboard } = await grafanaJson("/api/dashboards/uid/core-overview");
  assert.equal(dashboard.uid, "core-overview");
  assert.equal(dashboard.title, "Core overview");
  assert.ok(dashboard.panels.length >= 4, "request rate, errors, latency and uptime panels");
  const expressions = dashboard.panels.flatMap(panel => (panel.targets ?? []).map(target => target.expr ?? "")).join("\n");
  assert.ok(expressions.includes("junctura_core_requests_total"), expressions);
  assert.ok(expressions.includes("process_uptime_seconds"), expressions);
});
