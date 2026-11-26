// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { signInternalToken } from "../../platform/security/internal-token.mjs";
import { HttpError, json, jsonObject, readFlatJsonObject, readRecordJson, requireWriter, uuidPattern } from "../../platform/http/http.mjs";

export const AUDIT_VERIFY_PATH = "/v1/audit-events/verify";
export const AUDIT_EVENTS_PATH = "/v1/audit-events";

export async function handleAudit(request, response, identity, config, url) {
  if (!config.dataUrl) throw new HttpError(503, "audit_unavailable");
  if (!identity.clientId) throw new HttpError(403, "verified_client_required");
  if (url.pathname !== AUDIT_VERIFY_PATH) throw new HttpError(404, "not_found");
  if (request.method !== "POST") throw new HttpError(405, "method_not_allowed");
  if (url.search) throw new HttpError(400, "invalid_query");
  const body = await readFlatJsonObject(request);
  if (Object.keys(body).length) throw new HttpError(400, "invalid_audit_verification");
  const verification = await auditRpc(config, identity, "audit_verify", { payload: {} }, 200);
  if (typeof verification?.verified !== "boolean") throw new HttpError(503, "audit_unavailable");
  return json(response, 200, verification);
}

export const AUDIT_EXPORT_PATH = "/v1/audit-events:export";

const actionPattern = /^[a-z][a-z0-9_.-]{1,63}$/;
const subjectPattern = /^[^\u0000-\u001f\u007f]{1,255}$/u;
const unitPattern = /^[a-z][a-z0-9-]{1,63}$/;
const auditFilters = new Set(["app", "action", "actor", "subjectId", "unit", "from", "to"]);

function queryPayload(url, exporting) {
  const payload = Object.create(null);
  for (const [key, value] of url.searchParams) {
    const queryKey = auditFilters.has(key) || (!exporting && ["since", "until", "limit", "cursor"].includes(key));
    if (!queryKey || key in payload) throw new HttpError(400, "invalid_audit_query");
    if (key === "limit") {
      if (!/^[0-9]{1,3}$/.test(value)) throw new HttpError(400, "invalid_audit_limit");
      payload.limit = Number(value);
    } else {
      if (value.length < 1 || value.length > 1024) {
        throw new HttpError(400, key === "cursor" ? "invalid_cursor" : "invalid_audit_query");
      }
      payload[key] = value;
    }
  }
  if ((payload.app !== undefined && payload.app !== "self") || (payload.app && payload.unit) ||
      (payload.from && payload.since) || (payload.to && payload.until) ||
      (payload.action && !actionPattern.test(payload.action)) || (payload.subjectId && !subjectPattern.test(payload.subjectId)) ||
      (payload.actor && !subjectPattern.test(payload.actor)) || (payload.unit && !unitPattern.test(payload.unit))) throw new HttpError(400, "invalid_audit_query");
  return payload;
}

function validateWrite(body) {
  if (!jsonObject(body) || Object.keys(body).some(key =>
    !["action", "subjectId", "resourceRef", "outcome", "purpose", "meta"].includes(key))) {
    throw new HttpError(400, "invalid_audit_event");
  }
  const { action, subjectId, resourceRef, outcome, purpose, meta } = body;
  if (typeof action !== "string" || !actionPattern.test(action) ||
      (subjectId !== undefined && (typeof subjectId !== "string" || !subjectPattern.test(subjectId))) ||
      !["success", "denied", "failed"].includes(outcome) || typeof purpose !== "string" ||
      !/^[a-z][a-z0-9_]{1,62}$/.test(purpose) || !validReference(resourceRef)) {
    throw new HttpError(400, "invalid_audit_event");
  }
  if (meta !== undefined && (!jsonObject(meta) ||
      Object.entries(meta).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) ||
        (value !== null && !["string", "number", "boolean"].includes(typeof value))) ||
      Buffer.byteLength(JSON.stringify(meta)) > 2048)) throw new HttpError(400, "invalid_audit_meta");
}

function validReference(ref) {
  if (!jsonObject(ref) || typeof ref.id !== "string") return false;
  if (ref.type === "record") {
    return Object.keys(ref).length === 3 && typeof ref.collection === "string" &&
      /^[a-z][a-z0-9_-]{0,62}$/.test(ref.collection) && uuidPattern.test(ref.id);
  }
  if (Object.keys(ref).length !== 2) return false;
  if (ref.type === "object") return uuidPattern.test(ref.id);
  return ref.type === "workflowExecution" && /^[A-Za-z0-9:_-]{1,128}$/.test(ref.id);
}

async function auditRpc(config, identity, name, body, status, signal) {
  const token = signInternalToken(config.dataSecret, {
    role: "junctura_audit_api", aud: "junctura-data", exp: Math.floor(Date.now() / 1000) + 30,
    tenant_id: identity.tenantId, iss: identity.issuer, sub: identity.subject, client_id: identity.clientId,
    resource_writer: identity.roles.includes("core-writer"), subject_id: identity.subjectId, units: identity.units, regulator: identity.roles.includes("regulator"),
  });
  let result;
  try {
    const timeout = AbortSignal.timeout(15000);
    const db = await fetch(`${config.dataUrl}/rpc/${name}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      redirect: "error",
    });
    if (db.ok) result = await db.json();
  } catch { /* An unavailable upstream never yields a receipt or page. */ }
  if (result?.error && Number.isInteger(result.status) && result.status >= 400 && result.status < 500) {
    throw new HttpError(result.status, result.error);
  }
  if (result?.status !== status) throw new HttpError(503, "audit_unavailable");
  return result.value;
}

async function exportAudit(response, identity, config, filters) {
  const control = new AbortController();
  const disconnect = () => control.abort();
  response.once("close", disconnect);
  let snapshotId;
  const exportRpc = (operation, payload, status = 200) =>
    auditRpc(config, identity, "audit_app_export", { operation, payload }, status,
      operation === "page" ? control.signal : undefined);
  const readPage = async (after) => {
    const page = await exportRpc("page", after === undefined ? { snapshotId } : { snapshotId, after });
    if (!Array.isArray(page?.lines) || (page.nextAfter !== null &&
        (typeof page.nextAfter !== "string" || !/^[1-9][0-9]{0,18}$/.test(page.nextAfter) ||
          BigInt(page.nextAfter) <= BigInt(after ?? 0) || page.lines.length === 0))) {
      throw new HttpError(503, "audit_unavailable");
    }
    return page;
  };
  try {
    const started = await exportRpc("start", filters);
    snapshotId = started?.snapshotId;
    if (!uuidPattern.test(snapshotId ?? "") || started.head?.type !== "chainHead") {
      throw new HttpError(503, "audit_unavailable");
    }
    if (control.signal.aborted) return;
    let page = await readPage();
    response.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    });
    await writeLines(response, [started.head, ...page.lines], control.signal);
    while (page.nextAfter !== null) {
      page = await readPage(page.nextAfter);
      await writeLines(response, page.lines, control.signal);
    }
    response.end();
  } catch (error) {
    if (response.headersSent || control.signal.aborted) response.destroy();
    else throw error;
  } finally {
    response.off("close", disconnect);
    if (snapshotId) {
      try { await exportRpc("end", { snapshotId }, 204); }
      catch { /* The database expires abandoned snapshots. */ }
    }
  }
}

async function writeLines(response, lines, signal) {
  for (const line of lines) {
    signal.throwIfAborted();
    if (response.write(`${JSON.stringify(line)}\n`)) continue;
    await new Promise((resolve, reject) => {
      const unsubscribe = () => {
        response.off("drain", drain);
        signal.removeEventListener("abort", abort);
        clearTimeout(timeout);
      };
      const drain = () => { unsubscribe(); resolve(); };
      const abort = () => { unsubscribe(); reject(signal.reason); };
      const timeout = setTimeout(() => { unsubscribe(); reject(new Error("audit export stalled")); }, 10000);
      response.once("drain", drain);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
}

export async function handleAuditEvents(request, response, identity, config, url) {
  const exporting = url.pathname === AUDIT_EXPORT_PATH;
  if (!exporting && url.pathname !== AUDIT_EVENTS_PATH) throw new HttpError(404, "not_found");
  if (request.method !== "GET" && (exporting || request.method !== "POST")) {
    response.setHeader("Allow", exporting ? "GET" : "GET, POST");
    throw new HttpError(405, "method_not_allowed");
  }
  if (!config.dataUrl) throw new HttpError(503, "audit_unavailable");
  if (!identity.clientId) throw new HttpError(403, "verified_client_required");
  response.setHeader("Cache-Control", "no-store");
  if (request.method === "POST") {
    requireWriter(identity);
    if (url.search) throw new HttpError(400, "invalid_query");
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !uuidPattern.test(key)) throw new HttpError(400, "invalid_idempotency_key");
    const body = await readRecordJson(request, 16384);
    validateWrite(body);
    const receipt = await auditRpc(config, identity, "audit_app_append", { payload: { body, key } }, 201);
    if (!uuidPattern.test(receipt?.eventId ?? "") || !receipt.actor) throw new HttpError(503, "audit_unavailable");
    return json(response, 201, receipt);
  }
  const payload = queryPayload(url, exporting);
  if (exporting) return exportAudit(response, identity, config, payload);
  const page = await auditRpc(config, identity, "audit_query", { payload }, 200);
  if (!Array.isArray(page?.items)) throw new HttpError(503, "audit_unavailable");
  return json(response, 200, page);
}
