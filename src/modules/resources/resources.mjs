// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { applicationToken } from "../applications/applications.mjs";
import { createHash } from "node:crypto";
import { HttpError, json, requestIdFor, readFlatJsonObject, requireWriter, uuidPattern } from "../../platform/http/http.mjs";

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function requestDigest(body) {
  return createHash("sha256").update(canonicalJson({ body: body ?? null, ifMatch: null })).digest("hex");
}

export function requireLegacyClient(identity, config) {
  if (!identity.clientId || !(config.legacyResourceClients ?? []).includes(identity.clientId)) {
    throw new HttpError(403, "legacy_resources_disabled");
  }
}

export async function resourceRequest(config, identity, resource, query = new URLSearchParams(), options = {}) {
  let result;
  try {
    result = await fetch(`${config.dataUrl}/${resource}?${query}`, {
      ...options,
      headers: { Authorization: `Bearer ${applicationToken(identity, config.dataSecret, "junctura_resource_api")}`,
        "Content-Type": "application/json", Prefer: "return=representation" },
      signal: AbortSignal.timeout(5000), redirect: "error",
    });
  } catch { throw new HttpError(503, "resources_unavailable"); }
  if (!result.ok) throw new HttpError([403, 409].includes(result.status) ? result.status : 503,
    result.status === 409 ? "conflict" : result.status === 403 ? "resource_forbidden" : "resources_unavailable");
  return result.json();
}

export async function resourceCommand(config, identity, operation, payload = {}) {
  const result = await resourceRequest(config, identity, "rpc/resource_command", new URLSearchParams(),
    { method: "POST", body: JSON.stringify({ operation, payload }) });
  if (result.error) throw new HttpError(result.status, result.error);
  return result;
}

export async function resourceIdentity(config, identity) {
  if (!identity.clientId) throw new HttpError(403, "verified_client_required");
  const { value } = await resourceCommand(config, identity, "context");
  return { ...identity, appId: value.appId };
}

export function validateShare(body) {
  const group = Object.hasOwn(body, "granteeAppGroup");
  const app = Object.hasOwn(body, "granteeAppId");
  const keys = ["resourceType", "resourceId", "action", "expiresAt"];
  if (Object.keys(body).length !== 5 || group === app || keys.some(key => !Object.hasOwn(body, key)) ||
      !["record", "object"].includes(body.resourceType) || body.action !== "read" ||
      !uuidPattern.test(body.resourceId) || (group && body.resourceType !== "record") ||
      (app && !uuidPattern.test(body.granteeAppId)) ||
      (group && (typeof body.granteeAppGroup !== "string" || !/^[a-z][a-z0-9-]{1,63}$/.test(body.granteeAppGroup))) ||
      typeof body.expiresAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(body.expiresAt) ||
      !Number.isFinite(Date.parse(body.expiresAt)) ||
      ![new Date(body.expiresAt).toISOString(), new Date(body.expiresAt).toISOString().replace(".000Z", "Z")].includes(body.expiresAt)) {
    throw new HttpError(400, "invalid_share");
  }
  return body;
}

async function shareCommand(config, identity, operation, payload) {
  const result = await resourceRequest(config, identity, "rpc/record_share_command", new URLSearchParams(),
    { method: "POST", body: JSON.stringify({ operation, payload }) });
  if (result.error) throw new HttpError(result.status, result.error, result.details);
  return result;
}

export async function handleShares(request, response, identity, config, url) {
  const requestId = requestIdFor(request);
  response.setHeader("X-Request-Id", requestId);
  try {
    return await shareRequest(request, response, identity, config, url);
  } catch (error) {
    if (response.headersSent) return response.destroy();
    const status = error instanceof HttpError ? error.status : 503;
    if (status === 413) response.setHeader("Connection", "close");
    return json(response, status, {
      error: error instanceof HttpError ? error.message : "resources_unavailable",
      requestId,
    }, request.method);
  }
}

async function shareRequest(request, response, identity, config, url) {
  requireWriter(identity);
  if (url.search) throw new HttpError(400, "invalid_query");
  if (url.pathname === "/v2/resource-shares" && request.method === "POST") {
    const body = validateShare(await readFlatJsonObject(request));
    const requestKey = request.headers["idempotency-key"];
    if (requestKey !== undefined && (typeof requestKey !== "string" || !uuidPattern.test(requestKey))) {
      throw new HttpError(400, "invalid_request");
    }
    const payload = { share: body };
    if (requestKey !== undefined) Object.assign(payload, {
      requestKey, digest: requestDigest(body), path: url.pathname, method: request.method,
    });
    const result = await shareCommand(config, identity, "create", payload);
    return json(response, result.status, result.value);
  }
  const match = url.pathname.match(/^\/v2\/resource-shares\/([0-9a-f-]+)$/);
  if (match && uuidPattern.test(match[1]) && request.method === "DELETE") {
    await resourceCommand(config, identity, "share_revoke", { shareId: match[1] });
    response.writeHead(204);
    return response.end();
  }
  throw new HttpError(404, "not_found");
}
