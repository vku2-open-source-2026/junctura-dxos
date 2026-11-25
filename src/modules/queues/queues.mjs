// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { HttpError, json, jsonObject, readRecordJson, requestIdFor, uuidPattern } from "../../platform/http/http.mjs";
import { signInternalToken } from "../../platform/security/internal-token.mjs";

const pathPattern = /^\/v1\/queues\/([a-z][a-z0-9-]{0,62})(?:\/(messages|lease|dead-letters)|\/messages\/([^/]+)\/(ack|nack)|\/dead-letters\/([^/]+)\/replay)?$/;
const accessLists = ["producerAppIds", "consumerAppIds", "producerCapabilityVersionIds", "consumerCapabilityVersionIds"];
const maxPayloadBytes = 64 * 1024;
const validUuid = value => typeof value === "string" && uuidPattern.test(value);
const invalid = () => { throw new HttpError(400, "invalid_queue_request"); };

const routes = {
  configure: { method: "PUT", status: 200, fields: [...accessLists, "maxAttempts"] },
  send: { method: "POST", status: 201, fields: ["payload", "delaySeconds"] },
  lease: { method: "POST", status: 200, fields: ["visibilityTimeoutSeconds"] },
  ack: { method: "POST", status: 204, fields: ["leaseToken"] },
  nack: { method: "POST", status: 204, fields: ["leaseToken"] },
  list: { method: "GET", status: 200 },
  replay: { method: "POST", status: 204, fields: [] },
};

function boundedInteger(value, min, max, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) invalid();
  return value;
}

async function readCommand(request, url, operation) {
  if (operation === "list") {
    const query = Object.fromEntries(url.searchParams);
    if (url.searchParams.size !== Object.keys(query).length || Object.keys(query).some(key => !["limit", "cursor"].includes(key)) ||
        (query.limit !== undefined && !/^[0-9]{1,2}$/.test(query.limit)) ||
        (query.cursor !== undefined && !validUuid(query.cursor))) invalid();
    return { limit: boundedInteger(query.limit === undefined ? undefined : Number(query.limit), 1, 50, 20), cursor: query.cursor };
  }
  if (url.search) invalid();
  const body = await readRecordJson(request, operation === "send" ? maxPayloadBytes + 1024 : 16384);
  if (!jsonObject(body) || Object.keys(body).some(key => !routes[operation].fields.includes(key))) invalid();
  switch (operation) {
    case "configure": {
      const policy = { maxAttempts: boundedInteger(body.maxAttempts, 1, 10, 5) };
      for (const key of accessLists) {
        const ids = Object.hasOwn(body, key) ? body[key] : [];
        if (!Array.isArray(ids) || ids.length > 100 || !ids.every(validUuid) || new Set(ids).size !== ids.length) invalid();
        policy[key] = ids;
      }
      return policy;
    }
    case "send": {
      const key = request.headers["idempotency-key"];
      if (!validUuid(key)) throw new HttpError(400, "invalid_idempotency_key");
      if (!Object.hasOwn(body, "payload")) invalid();
      const payloadJson = JSON.stringify(body.payload);
      if (Buffer.byteLength(payloadJson) > maxPayloadBytes) throw new HttpError(413, "body_too_large");
      return { payloadJson, key, delaySeconds: boundedInteger(body.delaySeconds, 0, 86400, 0) };
    }
    case "lease":
      return { visibilityTimeoutSeconds: boundedInteger(body.visibilityTimeoutSeconds, 1, 3600, 30) };
    case "ack":
    case "nack":
      if (!validUuid(body.leaseToken)) invalid();
      return body;
    default:
      return body;
  }
}

export async function handleQueues(request, response, identity, config, url) {
  const match = pathPattern.exec(url.pathname);
  if (!match) throw new HttpError(404, "not_found");
  const [, queue, suffix, messageId, action, deadId] = match;
  const operation = action ?? (deadId ? "replay" : { messages: "send", lease: "lease", "dead-letters": "list" }[suffix] ?? "configure");
  const { method, status } = routes[operation];
  if (request.method !== method) {
    response.setHeader("Allow", method);
    throw new HttpError(405, "method_not_allowed");
  }
  if ((messageId || deadId) && !validUuid(messageId ?? deadId)) invalid();
  if (!identity.clientId) throw new HttpError(403, "verified_client_required");
  if (!config.dataUrl) throw new HttpError(503, "queues_unavailable");
  const command = await readCommand(request, url, operation);
  const writer = !identity.actor && identity.roles.includes("core-writer");
  const token = signInternalToken(config.dataSecret, {
    role: "junctura_queue_api", aud: "junctura-data", exp: Math.floor(Date.now() / 1000) + 30,
    tenant_id: identity.tenantId, iss: identity.issuer, sub: identity.subject, client_id: identity.clientId,
    actor_sub: identity.actor?.sub, trust_writer: writer,
  });
  let result;
  try {
    const db = await fetch(`${config.dataUrl}/rpc/queue_command`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ operation, queue_name: queue, payload: { ...command, messageId: messageId ?? deadId, requestId: requestIdFor(request) } }),
    });
    if (db.ok) result = await db.json();
  } catch { /* The queue RPC is the only source of operation results. */ }
  if ([400, 403, 404, 409].includes(result?.status) && typeof result.error === "string") {
    throw new HttpError(result.status, result.error);
  }
  if (result?.status !== status) throw new HttpError(503, "queues_unavailable");
  if (status === 204) {
    response.writeHead(204, { "Cache-Control": "no-store" });
    return response.end();
  }
  return json(response, status, result.value);
}
