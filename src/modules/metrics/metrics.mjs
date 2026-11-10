// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// In-memory traffic counters for the operator overview. Every value comes from
// requests that actually reached Core; nothing is sampled, estimated or seeded.
// The data is per-process and deliberately disappears when Core restarts.
import { HttpError, json } from "../../platform/http/http.mjs";

export const METRICS_TRAFFIC_PATH = "/v1/metrics/traffic";
export const METRICS_REQUESTS_PATH = "/v1/metrics/requests";
export const METRICS_FEATURES_PATH = "/v1/metrics/features";

const MINUTE_MS = 60_000;
const MAX_MINUTES = 24 * 60;
const RECENT_CAPACITY = 200;
const MAX_PATH_LENGTH = 512;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_ID_PATTERN = /^[0-9]+$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_.~-]{32,}$/;

// Fixed prefix to feature table. Prefixes are matched on whole path segments so
// "/v1/data" never captures an unrelated route such as "/v1/database".
const FEATURE_PREFIXES = [
  ["data", ["/v1/data", "/v2/data"]],
  ["files", ["/v1/objects", "/v2/objects"]],
  ["workflows", ["/v1/workflows"]],
  ["approvals", ["/v1/approvals"]],
  ["sharing", ["/v1/trust", "/v2/resource-shares"]],
  ["capabilities", ["/v1/capabilities", "/v1/capability-executions", "/v1/compositions"]],
  ["applications", ["/v1/applications"]],
  ["consents", ["/v1/me/consents", "/v1/me/data-access", "/v1/emergency-accesses"]],
  ["secrets", ["/v2/secrets"]],
  ["audit", ["/v1/audit-events"]],
];
const OTHER_FEATURE = "other";

const buckets = new Array(MAX_MINUTES);
let recent = [];

function minuteOf(now) {
  return Math.floor(now / MINUTE_MS);
}

function bucketAt(minute) {
  const index = ((minute % MAX_MINUTES) + MAX_MINUTES) % MAX_MINUTES;
  const existing = buckets[index];
  if (existing && existing.minute === minute) return existing;
  const bucket = { minute, requests: 0, errors4xx: 0, errors5xx: 0, latencyTotalMs: 0, maxLatencyMs: 0 };
  buckets[index] = bucket;
  return bucket;
}

function bucketView(bucket) {
  const requests = bucket?.requests ?? 0;
  return {
    at: new Date((bucket?.minute ?? 0) * MINUTE_MS).toISOString(),
    requests,
    errors4xx: bucket?.errors4xx ?? 0,
    errors5xx: bucket?.errors5xx ?? 0,
    avgLatencyMs: requests ? Math.round(bucket.latencyTotalMs / requests) : 0,
    maxLatencyMs: Math.round(bucket?.maxLatencyMs ?? 0),
  };
}

// Keep only paths: query strings, fragments and recognizable identifiers never
// reach the buffer, so tokens and user/tenant identifiers cannot leak through it.
export function normalizePath(rawPath) {
  if (typeof rawPath !== "string" || !rawPath.startsWith("/")) return "/";
  const path = rawPath.split(/[?#]/, 1)[0].slice(0, MAX_PATH_LENGTH);
  return path.split("/").map((segment) =>
    UUID_PATTERN.test(segment) || NUMERIC_ID_PATTERN.test(segment)
      ? ":id"
      : TOKEN_PATTERN.test(segment) ? ":token" : segment).join("/");
}

export function featureForPath(rawPath) {
  const path = normalizePath(rawPath);
  for (const [feature, prefixes] of FEATURE_PREFIXES) {
    for (const prefix of prefixes) {
      if (path === prefix || path.startsWith(`${prefix}/`)) return feature;
    }
  }
  return OTHER_FEATURE;
}

function emptyFeatureCounter() {
  return { requests: 0, errors4xx: 0, errors5xx: 0, latencyTotalMs: 0, maxLatencyMs: 0 };
}

function featureBucket(bucket, feature) {
  bucket.features ??= new Map();
  let counter = bucket.features.get(feature);
  if (!counter) {
    counter = emptyFeatureCounter();
    bucket.features.set(feature, counter);
  }
  return counter;
}

function safeMethod(method) {
  return typeof method === "string" && /^[A-Z]{1,16}$/i.test(method) ? method.toUpperCase() : "GET";
}

function safeDuration(durationMs) {
  return Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
}

function safeStatus(statusCode) {
  return Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599 ? statusCode : 0;
}

export function recordRequest({ method, path, statusCode, durationMs, at = Date.now() } = {}) {
  const now = Number.isFinite(at) ? at : Date.now();
  const status = safeStatus(statusCode);
  const duration = safeDuration(durationMs);
  const normalizedPath = normalizePath(path);
  const minute = minuteOf(now);
  const bucket = bucketAt(minute);
  bucket.requests += 1;
  if (status >= 400 && status < 500) bucket.errors4xx += 1;
  else if (status >= 500) bucket.errors5xx += 1;
  bucket.latencyTotalMs += duration;
  bucket.maxLatencyMs = Math.max(bucket.maxLatencyMs, duration);
  const counter = featureBucket(bucket, featureForPath(normalizedPath));
  counter.requests += 1;
  if (status >= 400 && status < 500) counter.errors4xx += 1;
  else if (status >= 500) counter.errors5xx += 1;
  counter.latencyTotalMs += duration;
  counter.maxLatencyMs = Math.max(counter.maxLatencyMs, duration);
  recent.push({
    at: new Date(now).toISOString(),
    method: safeMethod(method),
    path: normalizedPath,
    status,
    durationMs: duration,
  });
  if (recent.length > RECENT_CAPACITY) recent = recent.slice(-RECENT_CAPACITY);
}

function clampInteger(value, fallback, minimum, maximum) {
  return Number.isInteger(value) ? Math.min(Math.max(value, minimum), maximum) : fallback;
}

export function trafficSeries({ minutes } = {}) {
  const count = clampInteger(minutes, 60, 1, MAX_MINUTES);
  const endMinute = minuteOf(Date.now());
  const startMinute = endMinute - count + 1;
  const items = [];
  const totals = { requests: 0, errors4xx: 0, errors5xx: 0, avgLatencyMs: 0, maxLatencyMs: 0 };
  let latencyTotal = 0;
  for (let minute = startMinute; minute <= endMinute; minute += 1) {
    const index = ((minute % MAX_MINUTES) + MAX_MINUTES) % MAX_MINUTES;
    const stored = buckets[index]?.minute === minute ? buckets[index] : undefined;
    const view = bucketView(stored ? { ...stored, minute } : { minute });
    items.push(view);
    totals.requests += view.requests;
    totals.errors4xx += view.errors4xx;
    totals.errors5xx += view.errors5xx;
    latencyTotal += stored?.latencyTotalMs ?? 0;
    totals.maxLatencyMs = Math.max(totals.maxLatencyMs, view.maxLatencyMs);
  }
  totals.avgLatencyMs = totals.requests ? Math.round(latencyTotal / totals.requests) : 0;
  return {
    from: new Date(startMinute * MINUTE_MS).toISOString(),
    to: new Date((endMinute + 1) * MINUTE_MS).toISOString(),
    intervalSeconds: MINUTE_MS / 1000,
    buckets: items,
    totals,
  };
}

export function featureSeries({ minutes } = {}) {
  const count = clampInteger(minutes, 60, 1, MAX_MINUTES);
  const endMinute = minuteOf(Date.now());
  const startMinute = endMinute - count + 1;
  const at = (minute) => new Date(minute * MINUTE_MS).toISOString();
  const features = new Map();
  for (let offset = 0; offset < count; offset += 1) {
    const minute = startMinute + offset;
    const index = ((minute % MAX_MINUTES) + MAX_MINUTES) % MAX_MINUTES;
    const stored = buckets[index]?.minute === minute ? buckets[index] : undefined;
    if (!stored?.features) continue;
    for (const [feature, counter] of stored.features) {
      let aggregate = features.get(feature);
      if (!aggregate) {
        aggregate = {
          feature,
          requests: 0,
          errors4xx: 0,
          errors5xx: 0,
          latencyTotalMs: 0,
          maxLatencyMs: 0,
          series: Array.from({ length: count }, (_, position) => ({
            at: at(startMinute + position),
            requests: 0,
          })),
        };
        features.set(feature, aggregate);
      }
      aggregate.requests += counter.requests;
      aggregate.errors4xx += counter.errors4xx;
      aggregate.errors5xx += counter.errors5xx;
      aggregate.latencyTotalMs += counter.latencyTotalMs;
      aggregate.maxLatencyMs = Math.max(aggregate.maxLatencyMs, counter.maxLatencyMs);
      aggregate.series[offset].requests = counter.requests;
    }
  }
  const items = [...features.values()]
    .filter((item) => item.requests > 0)
    .sort((left, right) => right.requests - left.requests || left.feature.localeCompare(right.feature))
    .map(({ feature, requests, errors4xx, errors5xx, latencyTotalMs, maxLatencyMs, series }) => ({
      feature,
      requests,
      errors4xx,
      errors5xx,
      avgLatencyMs: requests ? Math.round(latencyTotalMs / requests) : 0,
      maxLatencyMs: Math.round(maxLatencyMs),
      series,
    }));
  return {
    from: new Date(startMinute * MINUTE_MS).toISOString(),
    to: new Date((endMinute + 1) * MINUTE_MS).toISOString(),
    features: items,
  };
}

export function recentRequests({ limit } = {}) {
  const count = clampInteger(limit, 20, 1, 100);
  return recent.slice(-count).reverse().map((item) => ({ ...item }));
}

// Tests use this to isolate cases; production code never calls it.
export function resetMetrics() {
  buckets.length = 0;
  buckets.length = MAX_MINUTES;
  recent = [];
}

export function isMetricsPath(path) {
  return path === METRICS_TRAFFIC_PATH || path === METRICS_REQUESTS_PATH || path === METRICS_FEATURES_PATH;
}

const QUERY_LIMITS = {
  [METRICS_TRAFFIC_PATH]: { key: "minutes", minimum: 1, maximum: MAX_MINUTES, fallback: 60 },
  [METRICS_REQUESTS_PATH]: { key: "limit", minimum: 1, maximum: 100, fallback: 20 },
  [METRICS_FEATURES_PATH]: { key: "minutes", minimum: 1, maximum: MAX_MINUTES, fallback: 60 },
};

function readQuery(url, rule) {
  let value;
  for (const [key, raw] of url.searchParams) {
    if (key !== rule.key || value !== undefined) throw new HttpError(400, "invalid_metrics_query");
    if (!/^[0-9]{1,4}$/.test(raw)) throw new HttpError(400, `invalid_metrics_${rule.key}`);
    value = Number(raw);
  }
  if (value === undefined) return rule.fallback;
  if (value < rule.minimum || value > rule.maximum) throw new HttpError(400, `invalid_metrics_${rule.key}`);
  return value;
}

export async function handleMetrics(request, response, identity, config, url) {
  if (!isMetricsPath(url.pathname)) throw new HttpError(404, "not_found");
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    throw new HttpError(405, "method_not_allowed");
  }
  if (!identity.clientId) throw new HttpError(403, "verified_client_required");
  const rule = QUERY_LIMITS[url.pathname];
  const value = readQuery(url, rule);
  response.setHeader("Cache-Control", "no-store");
  if (url.pathname === METRICS_TRAFFIC_PATH) return json(response, 200, trafficSeries({ minutes: value }));
  if (url.pathname === METRICS_FEATURES_PATH) return json(response, 200, featureSeries({ minutes: value }));
  return json(response, 200, { items: recentRequests({ limit: value }) });
}
