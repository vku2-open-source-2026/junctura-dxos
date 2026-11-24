// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { HttpError, requestIdFor, json, jsonObject, logicalRequestDigest, readRecordJson, requireWriter, uuidPattern } from "../../platform/http/http.mjs";
import { signInternalToken } from "../../platform/security/internal-token.mjs";
import { readResourceConsent } from "../consent/consent.mjs";
import { collectionPattern, fieldPattern, parseCollectionSchema, uniqueKeyPattern } from "./schema/collection.mjs";

export { logicalRequestDigest, parseCollectionSchema };
export const recordETagPattern = /^"record-[a-f0-9]{64}-[1-9][0-9]{0,15}"$/;

export function validRecordETag(value) {
  return typeof value === "string" && recordETagPattern.test(value);
}

export function parseRecordWrite(body) {
  if (!jsonObject(body) || Object.keys(body).length !== 1 || !jsonObject(body.data)) {
    throw new HttpError(400, "invalid_request");
  }
  return body;
}

export function parseRecordIncrements(operations) {
  if (!Array.isArray(operations) || operations.length === 0) throw new HttpError(400, "invalid_request");
  for (const operation of operations) {
    if (!jsonObject(operation) || operation.op !== "increment" || typeof operation.field !== "string" ||
        !fieldPattern.test(operation.field) || !Number.isFinite(operation.by) ||
        Object.keys(operation).some(field => !["op", "field", "by", "min", "max"].includes(field)) ||
        ["min", "max"].some(field => Object.hasOwn(operation, field) && !Number.isFinite(operation[field])) ||
        operation.min > operation.max) {
      throw new HttpError(400, "invalid_request");
    }
  }
  return operations;
}

export function parseRecordLockWrite(body) {
  if (!jsonObject(body) || Object.keys(body).some(key => !["lockId", "ttlSeconds"].includes(key)) ||
      (Object.hasOwn(body, "lockId") && (typeof body.lockId !== "string" || !uuidPattern.test(body.lockId))) ||
      (Object.hasOwn(body, "ttlSeconds") && (!Number.isInteger(body.ttlSeconds) || body.ttlSeconds < 1 || body.ttlSeconds > 1800))) {
    throw new HttpError(400, "invalid_request");
  }
  return body;
}

export function parseRecordWriteHeaders(headers, { requireIdempotency = false, allowIfMatch = false } = {}) {
  const requestKey = headers["idempotency-key"];
  const ifMatch = allowIfMatch ? headers["if-match"] : undefined;
  if ((requestKey === undefined && requireIdempotency) ||
      (requestKey !== undefined && (typeof requestKey !== "string" || !uuidPattern.test(requestKey))) ||
      (ifMatch !== undefined && !validRecordETag(ifMatch))) throw new HttpError(400, "invalid_request");
  return { requestKey, ifMatch };
}

export async function recordCommand(config, identity, operation, payload) {
  const { tenantId, issuer, subject, clientId, roles } = identity;
  if (!clientId) throw new HttpError(403, "verified_client_required");
  if (!config.dataUrl) throw new HttpError(503, "data_unavailable");
  try {
    const token = signInternalToken(config.dataSecret, { role: "junctura_record_api", tenant_id: tenantId,
      iss: issuer, sub: subject, client_id: clientId, resource_unit: identity.resourceUnit, human_app_id: identity.humanAppId, resource_writer: roles.includes("core-writer"),
      display_name: identity.preferredUsername, aud: "junctura-data", exp: Math.floor(Date.now() / 1000) + 30 });
    const upstream = await fetch(`${config.dataUrl}/rpc/record_command`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ operation, payload }),
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    if (!upstream.ok) throw new Error();
    const result = await upstream.json();
    if (!Number.isInteger(result?.status) || result.status < 200 || result.status > 499) throw new Error();
    return result;
  } catch { throw new HttpError(503, "data_unavailable"); }
}

const errorFields = Object.freeze({
  schema_violation: ["issues"], quota_exceeded: ["quota"], locked: ["lockedBy", "lockedUntil"],
  task_claimed: ["claimedBy", "claimedUntil"],
  limit_exceeded: ["field"], invalid_request: ["issues"],
});

const legacyErrors = new Set([
  "bearer_token_required", "invalid_token", "tenant_required", "insufficient_role", "identity_unavailable",
  "verified_client_required", "application_access_required", "write_forbidden", "not_found", "data_unavailable",
  "invalid_record_path", "invalid_query", "method_not_allowed", "json_required", "invalid_json",
  "object_required", "data_object_required",
]);

export async function presentRecordRequest(request, response, run, compatibility = false) {
  const requestId = requestIdFor(request);
  response.setHeader("X-Request-Id", requestId);
  try { return await run(); }
  catch (error) {
    if (response.headersSent) return response.destroy();
    const status = error instanceof HttpError ? error.status : 503;
    if (status === 413) response.setHeader("Connection", "close");
    const code = error instanceof HttpError ? error.message : "data_unavailable";
    if (compatibility && request.headers["idempotency-key"] === undefined && legacyErrors.has(code)) {
      return json(response, status, { error: code }, request.method);
    }
    const details = Object.fromEntries((Object.hasOwn(errorFields, code) ? errorFields[code] : [])
      .filter(field => Object.hasOwn(error.details ?? {}, field)).map(field => [field, error.details[field]]));
    if (compatibility && status === 409) {
      return json(response, status, { error: "conflict", requestId, details: { code, ...details } }, request.method);
    }
    return json(response, status, { error: code, requestId, ...details }, request.method);
  }
}

export function sendRecordResult(response, result, { legacyBody = false } = {}) {
  if (result.error) throw new HttpError(result.status, result.error, result.details);
  for (const name of ["ETag", "Location"]) {
    if (typeof result.headers?.[name] === "string") response.setHeader(name, result.headers[name]);
  }
  if (result.status === 204) {
    response.writeHead(204, { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    return response.end();
  }
  const value = result.value;
  if (legacyBody && Object.hasOwn(value, "version")) {
    const { version, ...record } = value;
    return json(response, result.status, record);
  }
  return json(response, result.status, value);
}

function methodNotAllowed(response, allow) {
  response.setHeader("Allow", allow);
  throw new HttpError(405, "method_not_allowed");
}

async function handleRecordLock(request, response, identity, config, url, payload) {
  if (!["POST", "DELETE"].includes(request.method)) return methodNotAllowed(response, "POST, DELETE");
  requireWriter(identity);
  if (url.search) throw new HttpError(400, "invalid_query");
  if (request.method === "DELETE") {
    const lockId = request.headers["lock-id"];
    if (typeof lockId !== "string" || !uuidPattern.test(lockId)) throw new HttpError(400, "invalid_request");
    return sendRecordResult(response, await recordCommand(config, identity, "unlock", { ...payload, lockId }));
  }
  const { requestKey } = parseRecordWriteHeaders(request.headers, { requireIdempotency: true });
  const hasBody = (request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0") ||
    request.headers["transfer-encoding"] !== undefined;
  const body = hasBody ? parseRecordLockWrite(await readRecordJson(request)) : {};
  return sendRecordResult(response, await recordCommand(config, identity, "lock", {
    ...payload, body, requestKey, digest: logicalRequestDigest({ body }),
  }));
}

const batchFields = Object.freeze({
  create: ["data"], replace: ["id", "data", "ifMatch"], delete: ["id", "ifMatch"], increment: ["id", "operations", "ifMatch"],
});

function batchBadRequest(index, field = "", keyword = "properties") {
  const path = `/operations/${index}${field ? "/" + field : ""}`;
  throw new HttpError(400, "invalid_request", { issues: [{ path, keyword }] });
}

export function parseRecordBatch(body) {
  if (!jsonObject(body) || Object.keys(body).length !== 1 ||
      !Array.isArray(body.operations) || body.operations.length < 1 || body.operations.length > 50) {
    throw new HttpError(400, "invalid_request");
  }
  for (const [index, item] of body.operations.entries()) {
    if (!jsonObject(item)) batchBadRequest(index, "", "type");
    if (typeof item.op !== "string" || !Object.hasOwn(batchFields, item.op)) batchBadRequest(index, "op", "enum");
    const fields = batchFields[item.op];
    if (Object.keys(item).some(key => !["op", "collection", ...fields].includes(key))) batchBadRequest(index);
    if (typeof item.collection !== "string" || !collectionPattern.test(item.collection)) batchBadRequest(index, "collection", "pattern");
    if (fields.includes("id") && (typeof item.id !== "string" || !uuidPattern.test(item.id))) batchBadRequest(index, "id", "pattern");
    if (fields.includes("data") && !jsonObject(item.data)) batchBadRequest(index, "data", "type");
    if (Object.hasOwn(item, "ifMatch") && !validRecordETag(item.ifMatch)) batchBadRequest(index, "ifMatch", "pattern");
    if (item.op === "increment") {
      try { parseRecordIncrements(item.operations); }
      catch (error) {
        if (!(error instanceof HttpError)) throw error;
        batchBadRequest(index, "operations");
      }
    }
  }
  return body;
}

async function handleRecordBulk(request, response, identity, config, url) {
  const batch = url.pathname === "/v2/data:batch";
  const method = batch ? "POST" : "PUT";
  if (request.method !== method) return methodNotAllowed(response, method);
  requireWriter(identity);
  if (url.search) throw new HttpError(400, "invalid_query");
  const path = batch ? null : url.pathname.match(/^\/v2\/data\/([^/]+)\/by-key\/([^/]+)$/);
  const collection = path?.[1];
  const uniqueValue = path?.[2];
  if (!batch && (!collectionPattern.test(collection ?? "") || !uniqueKeyPattern.test(uniqueValue ?? ""))) {
    throw new HttpError(400, "invalid_request");
  }
  const headers = parseRecordWriteHeaders(request.headers, { requireIdempotency: true, allowIfMatch: !batch });
  const incoming = await readRecordJson(request, batch ? 4194304 : 65536);
  const body = batch ? parseRecordBatch(incoming) : parseRecordWrite(incoming);
  return sendRecordResult(response, await recordCommand(config, identity, batch ? "batch" : "upsert", {
    method, path: url.pathname, collection, uniqueValue, ...headers, body,
    digest: logicalRequestDigest({ body, ifMatch: headers.ifMatch }),
  }));
}

export async function handleAppRecords(request, response, identity, config, url) {
  if (url.pathname === "/v2/data:batch" || /^\/v2\/data\/[^/]+\/by-key(?:\/|$)/.test(url.pathname)) {
    return handleRecordBulk(request, response, identity, config, url);
  }
  const method = request.method;
  const schemaPath = url.pathname.startsWith("/v2/data-schemas/");
  const path = schemaPath ? url.pathname.match(/^\/v2\/data-schemas\/([^/]+)$/)
    : url.pathname.match(/^\/v2\/data\/([^/]+)(?:\/([^/]+))?$/);
  const collection = path?.[1];
  const lockPath = !schemaPath && path?.[2]?.endsWith(":lock");
  const id = lockPath ? path[2].slice(0, -5) : path?.[2];
  if (!collectionPattern.test(collection ?? "") || (id !== undefined && !uuidPattern.test(id))) {
    throw new HttpError(400, !schemaPath && !lockPath && !config.strictRecords ? "invalid_record_path" : "invalid_request");
  }
  const payload = { collection, id, method, path: url.pathname };
  if (lockPath) return handleRecordLock(request, response, identity, config, url, payload);
  if (schemaPath && method === "PUT") {
    requireWriter(identity);
    if (url.search) throw new HttpError(400, "invalid_query");
    payload.body = parseCollectionSchema(await readRecordJson(request));
    return sendRecordResult(response, await recordCommand(config, identity, "register", payload));
  }
  if (!schemaPath && id && method === "GET") {
    const limit = url.searchParams.get("limit") ?? "100";
    if ([...url.searchParams.keys()].some(key => key !== "limit") || !/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100) {
      throw new HttpError(400, "invalid_query");
    }
    const legacyBody = !config.strictRecords;
    const result = await recordCommand(config, identity, "get", { ...payload, legacyBody });
    const consent = result.error === "not_found"
      ? await readResourceConsent(request, config, identity, { kind: "record", collection, id })
      : null;
    return sendRecordResult(response, consent ?? result, { legacyBody });
  }
  let operation = schemaPath ? undefined : !id && method === "POST" ? "create"
    : id && method === "PATCH" ? "replace" : id && method === "DELETE" ? "delete" : undefined;
  if (!operation) return methodNotAllowed(response, schemaPath ? "PUT" : id ? "GET, PATCH, DELETE" : "GET, POST");

  requireWriter(identity);
  if (url.search) throw new HttpError(400, "invalid_query");
  if (operation !== "delete") {
    const legacy = !config.strictRecords && request.headers["idempotency-key"] === undefined;
    let body;
    try { body = await readRecordJson(request); }
    catch (error) {
      if (legacy && error.message === "invalid_request") throw new HttpError(400, "invalid_json");
      throw error;
    }
    if (operation === "replace" && jsonObject(body) && Object.hasOwn(body, "operations")) {
      if (Object.keys(body).length !== 1) throw new HttpError(400, "invalid_request");
      parseRecordIncrements(body.operations);
      operation = "increment";
      payload.body = body;
    } else {
      if (legacy) {
        if (!jsonObject(body)) throw new HttpError(400, "object_required");
        if (Object.keys(body).length !== 1 || !jsonObject(body.data)) throw new HttpError(400, "data_object_required");
      }
      payload.body = parseRecordWrite(body);
    }
  }
  const headers = parseRecordWriteHeaders(request.headers, {
    requireIdempotency: operation === "increment" || (config.strictRecords && operation === "create"),
    allowIfMatch: operation !== "create",
  });
  Object.assign(payload, headers, {
    requireMatch: Boolean(config.strictRecords) && ["replace", "delete"].includes(operation),
    legacyBody: !config.strictRecords && (operation === "replace" || (operation === "create" && !headers.requestKey)),
  });
  if (headers.requestKey) payload.digest = logicalRequestDigest(payload);
  return sendRecordResult(response, await recordCommand(config, identity, operation, payload));
}
