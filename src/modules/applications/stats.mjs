// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Management aggregates only. Project every response field so dependency
// metadata and private content cannot escape through the statistics endpoint.
import { applicationToken } from "./applications.mjs";
import { aggregateObjects } from "../storage/filer.mjs";
import { HttpError, json, uuidPattern } from "../../platform/http/http.mjs";

export const APPLICATION_STATS_PATH = "/v1/applications/stats";

const states = new Set(["pending", "active", "suspended", "revoked"]);
const totalFields = ["applications", "activeApplications", "activeLast24h", "activeLast7d", "activeConnections"];
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const counts = (value, fields) => object(value) && fields.every((field) => count(value[field]));
const unavailable = () => new HttpError(503, "application_stats_unavailable");

function timestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) return null;
  const parsed = Date.parse(value);
  const day = Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(parsed) || !Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== value.slice(0, 10)) return null;
  return new Date(parsed).toISOString();
}

function validStats(value) {
  return object(value) && counts(value.totals, totalFields) && Array.isArray(value.applications) &&
    value.applications.every((app) => object(app) && typeof app.id === "string" && uuidPattern.test(app.id) &&
      typeof app.name === "string" && app.name.length >= 1 && app.name.length <= 200 &&
      app.name.isWellFormed() && !/[\u0000-\u001f\u007f]/u.test(app.name) && states.has(app.state) &&
      timestamp(app.registeredAt) !== null && (app.lastActivityAt === null || timestamp(app.lastActivityAt) !== null) &&
      object(app.calls) && counts(app.calls.outgoing, ["last24h", "last7d"]) &&
      counts(app.calls.incoming, ["last24h", "last7d"]) && counts(app.capabilities, ["published"]) &&
      counts(app.connections, ["given", "received"]) && counts(app.data, ["collections", "records"]));
}

async function readStats(config, identity, request) {
  let result;
  try {
    const response = await request(`${config.dataUrl}/rpc/application_stats`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${applicationToken(identity, config.dataSecret, "junctura_application_stats_api")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ payload: {} }),
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    if (!response.ok) throw unavailable();
    result = await response.json();
  } catch { throw unavailable(); }
  if (result?.error) {
    if (!Number.isInteger(result.status) || result.status < 400 || result.status > 599 || typeof result.error !== "string") throw unavailable();
    throw new HttpError(result.status, result.error);
  }
  if (result?.status !== 200 || !validStats(result.value)) throw unavailable();
  return result.value;
}

export async function handleApplicationStats(request, response, identity, config, url, deps = {}) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    throw new HttpError(405, "method_not_allowed");
  }
  if (url.search || url.href.includes("?")) throw new HttpError(400, "invalid_query");
  if (!config.dataUrl) throw unavailable();
  if (!identity.clientId) throw new HttpError(403, "verified_client_required");
  const requestImpl = deps.request ?? fetch;
  const value = await readStats(config, identity, requestImpl);
  const applications = [];
  for (const app of value.applications) {
    let files = null;
    if (config.objectsUrl) {
      let aggregate;
      try { aggregate = await aggregateObjects(config, `/junctura-app/${identity.tenantId}/${app.id}`, requestImpl); }
      catch { throw unavailable(); }
      if (!counts(aggregate, ["count", "bytes"])) throw unavailable();
      files = { count: aggregate.count, bytes: aggregate.bytes };
    }
    applications.push({
      id: app.id,
      name: app.name,
      state: app.state,
      registeredAt: timestamp(app.registeredAt),
      lastActivityAt: timestamp(app.lastActivityAt),
      calls: {
        outgoing: { last24h: app.calls.outgoing.last24h, last7d: app.calls.outgoing.last7d },
        incoming: { last24h: app.calls.incoming.last24h, last7d: app.calls.incoming.last7d },
      },
      capabilities: { published: app.capabilities.published },
      connections: { given: app.connections.given, received: app.connections.received },
      data: { collections: app.data.collections, records: app.data.records },
      files,
    });
  }
  response.setHeader("Cache-Control", "no-store");
  return json(response, 200, {
    generatedAt: new Date().toISOString(),
    totals: Object.fromEntries(totalFields.map((field) => [field, value.totals[field]])),
    applications,
  });
}
