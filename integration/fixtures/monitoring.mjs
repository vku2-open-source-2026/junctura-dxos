// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { base } from "../record-test-support.mjs";

const run = promisify(execFile);

// The core /metrics endpoint never passes the gateway, so the only host-side
// vantage point on a compose stack is the core container itself.
const CORE_PROBE = `
const probe = async (method, path = "/metrics") => {
  const response = await fetch("http://127.0.0.1:" + (process.env.PORT ?? 8080) + path, {
    method, signal: AbortSignal.timeout(10_000) });
  return { status: response.status, contentType: response.headers.get("content-type"),
    cacheControl: response.headers.get("cache-control"), allow: response.headers.get("allow"),
    body: await response.text() };
};
// One counted warmup request: /metrics, /health and /ready never reach the
// counters themselves, so a fresh Core otherwise serves an empty counter set.
const warmup = await probe("GET", "/metrics-probe");
console.log(JSON.stringify({ warmupStatus: warmup.status, get: await probe("GET"), post: await probe("POST") }));`;

export function monitoringFixture() {
  const prometheusOrigin = `http://127.0.0.1:${process.env.PROMETHEUS_PORT ?? 9090}`;
  const grafanaOrigin = `http://127.0.0.1:${process.env.GRAFANA_PORT ?? 3300}`;
  const grafanaAuthorization = `Basic ${Buffer.from(`admin:${process.env.GRAFANA_ADMIN_PASSWORD ?? "admin"}`).toString("base64")}`;

  const coreMetrics = async () =>
    JSON.parse((await run("docker", ["compose", "exec", "-T", "core", "node", "-e", CORE_PROBE],
      { timeout: 30_000 })).stdout.trim());

  const gateway = (path, init) => fetch(`${base}${path}`, { signal: AbortSignal.timeout(15_000), ...init });
  const prometheus = (path, init) => fetch(`${prometheusOrigin}${path}`, { signal: AbortSignal.timeout(15_000), ...init });
  const grafana = (path, init) => fetch(`${grafanaOrigin}${path}`,
    { signal: AbortSignal.timeout(15_000), headers: { Authorization: grafanaAuthorization }, ...init });

  const prometheusJson = async (path) => {
    const response = await prometheus(path);
    if (response.status !== 200) throw new Error(`${prometheusOrigin}${path} answered ${response.status}: ${await response.text()}`);
    return response.json();
  };
  const grafanaJson = async (path) => {
    const response = await grafana(path);
    if (response.status !== 200) throw new Error(`${grafanaOrigin}${path} answered ${response.status}: ${await response.text()}`);
    return response.json();
  };

  return { base, coreMetrics, gateway, prometheus, grafana, prometheusJson, grafanaJson, prometheusOrigin, grafanaOrigin };
}
