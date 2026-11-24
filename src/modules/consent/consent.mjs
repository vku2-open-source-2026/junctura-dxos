// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Data subject consent and emergency-access review. A person grants a consumer
// application the right to call one capability about them for named purposes,
// until an expiry, and can revoke it. Tenant administrators (trust.approve) review
// every emergency call made without consent. The database owns every decision;
// Core only asserts the private role for the verified caller.
import { applicationToken } from "../applications/applications.mjs";
import { parseStrictJson } from "../capability/compatibility/compatibility.mjs";
import { resourceRequest } from "../resources/resources.mjs";
import { HttpError, json, logicalRequestDigest, readBody, requestIdFor, requireWriter, uuidPattern } from "../../platform/http/http.mjs";

export const CONSENTS_PATH = "/v1/me/consents";
const RESOURCE_CONSENTS_PATH = "/v1/me/resource-consents";
const RESOURCE_REQUESTS_PATH = "/v1/resource-consent-requests";
const SUBJECT_REQUESTS_PATH = "/v1/me/resource-consent-requests";
export const isPlannedSubjectPath = path => /^\/v1\/me\/(?:data-access\/[^/]+\/flag|emergency-accesses\/[^/]+\/feedback)$/.test(path);
export const EMERGENCY_PATH = "/v1/emergency-accesses";

const capabilityPattern = /^urn:junctura:capability:[0-9a-f-]{36}:[a-z][a-z0-9-]{0,62}$/;
const purposePattern = /^[a-z][a-z0-9_]{1,62}$/;

function validConsentText(value) {
  return typeof value === "string" && value.isWellFormed() && value.trim() &&
    [...value].length <= 255 && !/[\p{Cc}]/u.test(value);
}

function validateResourceConsent(body, proposal = false) {
  const invalid = proposal ? "invalid_consent_request" : "invalid_consent";
  const keys = ["resourceType", "resourceId", "purpose", "expiresAt"];
  if (!proposal) keys.push("recipientUnit");
  if (Object.keys(body).some(key => !keys.includes(key)) ||
      !["record", "object"].includes(body.resourceType) || typeof body.resourceId !== "string" || !uuidPattern.test(body.resourceId) ||
      (!proposal && (typeof body.recipientUnit !== "string" || !/^[a-z][a-z0-9-]{1,63}$/.test(body.recipientUnit))) ||
      !validConsentText(body.purpose)) {
    throw new HttpError(400, invalid);
  }
  if ((proposal || Object.hasOwn(body, "expiresAt")) &&
      (typeof body.expiresAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(body.expiresAt) ||
       !Number.isFinite(Date.parse(body.expiresAt)) ||
       new Date(body.expiresAt).toISOString().slice(0, 19) !== body.expiresAt.slice(0, 19))) {
    throw new HttpError(400, "invalid_consent_expiry");
  }
  return body;
}

export async function readResourceConsent(request, config, identity, target) {
  if (!identity.actor) return null;
  const result = await resourceRequest(config, identity, "rpc/resource_consent_read", undefined,
    { method: "POST", body: JSON.stringify({ payload: { ...target, requestId: requestIdFor(request) } }) });
  if (result.status === 404) return null;
  if (result.error) throw new HttpError(result.status, result.error);
  return result;
}

function validateConsentBody(body) {
  if (Object.keys(body).sort().join(",") !== "capabilityId,consumerAppId,expiresAt,purposes" ||
    !uuidPattern.test(body.consumerAppId) || !capabilityPattern.test(body.capabilityId) ||
    !Array.isArray(body.purposes) || body.purposes.length < 1 || body.purposes.length > 8 ||
    body.purposes.some(purpose => !purposePattern.test(purpose)) ||
    typeof body.expiresAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(body.expiresAt) ||
    !Number.isFinite(Date.parse(body.expiresAt))) {
    throw new HttpError(400, "invalid_consent");
  }
  return { consumerAppId: body.consumerAppId, capabilityId: body.capabilityId,
    purposes: body.purposes, expiresAt: body.expiresAt };
}

async function readObject(request) {
  if (request.headers["content-type"]?.split(";", 1)[0].trim() !== "application/json") throw new HttpError(415, "json_required");
  const bytes = await readBody(request, 16384);
  let value;
  try { value = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new HttpError(400, "invalid_json"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid_json");
  return value;
}

async function command(config, identity, role, rpc, operation, payload) {
  if (!config.dataUrl) throw new HttpError(503, "consent_unavailable");
  if (!identity.clientId) throw new HttpError(403, "verified_client_required");
  let result;
  try {
    const db = await fetch(`${config.dataUrl}/rpc/${rpc}`, { method: "POST", redirect: "error",
      headers: { Authorization: `Bearer ${applicationToken(identity, config.dataSecret, role)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ operation, payload }), signal: AbortSignal.timeout(5000) });
    if (!db.ok) throw Error();
    result = await db.json();
  } catch { throw new HttpError(503, "consent_unavailable"); }
  if (result?.error) throw new HttpError(result.status, result.error);
  if (![200, 201, 404, 422, 429].includes(result?.status)) throw new HttpError(503, "consent_unavailable");
  return result;
}

export function isConsentPath(path) {
  if (typeof path !== "string") return false;
  return [RESOURCE_CONSENTS_PATH, RESOURCE_REQUESTS_PATH, SUBJECT_REQUESTS_PATH, CONSENTS_PATH, EMERGENCY_PATH]
    .some(base => path === base || path.startsWith(`${base}/`));
}

async function handleResourceConsents(request, response, identity, config, path) {
  const run = (operation, payload) =>
    command(config, identity, "junctura_subject_api", "resource_consent_command", operation, payload);
  if (identity.actor || !identity.subjectId) throw new HttpError(403, "verified_subject_required");
  if (path === RESOURCE_CONSENTS_PATH) {
    if (request.method === "GET") return json(response, 200, (await run("list", {})).value);
    if (request.method !== "POST") throw new HttpError(405, "method_not_allowed");
    const consent = validateResourceConsent(await readObject(request));
    const key = request.headers["idempotency-key"];
    if (!uuidPattern.test(key ?? "")) throw new HttpError(400, "invalid_request");
    const result = await run("create", { consent, key, digest: logicalRequestDigest({ body: consent }) });
    return json(response, result.status, result.value);
  }
  const revoke = /^\/v1\/me\/resource-consents\/([^/]+)\/revoke$/.exec(path);
  if (!revoke) throw new HttpError(404, "not_found");
  if (!uuidPattern.test(revoke[1])) throw new HttpError(400, "invalid_consent_path");
  if (request.method !== "POST") throw new HttpError(405, "method_not_allowed");
  if (Object.keys(await readObject(request)).length) throw new HttpError(400, "invalid_consent");
  return json(response, 200, (await run("revoke", { consentId: revoke[1] })).value);
}

async function handleResourceConsentRequests(request, response, identity, config, path, base) {
  const subject = base === SUBJECT_REQUESTS_PATH;
  if (subject && (identity.actor || !identity.subjectId)) throw new HttpError(403, "verified_subject_required");
  if (!subject && (!identity.actor || !identity.humanAppId || !identity.resourceUnit)) {
    throw new HttpError(403, "application_access_required");
  }
  const role = subject ? "junctura_subject_api" : "junctura_resource_api";
  const run = (operation, payload) => command(config, identity, role, "resource_consent_request_command", operation, payload);
  let result;
  if (path === base) {
    if (request.method !== (subject ? "GET" : "POST")) throw new HttpError(405, "method_not_allowed");
    result = subject ? await run("list", {}) : await run("create", validateResourceConsent(await readObject(request), true));
    if (!subject) response.setHeader("Location", `${base}/${result.value.requestId}`);
  } else {
    const match = /^\/([^/]+)(?:\/([^/]+))?$/.exec(path.slice(base.length));
    if (!match || !(subject ? ["accept", "decline"].includes(match[2]) : match[2] === undefined || match[2] === "cancel")) {
      throw new HttpError(404, "not_found");
    }
    const [, id, operation = "get"] = match;
    if (!uuidPattern.test(id)) throw new HttpError(400, "invalid_consent_request_path");
    if (request.method !== (operation === "get" ? "GET" : "POST")) throw new HttpError(405, "method_not_allowed");
    const body = operation === "get" ? {} : await readObject(request);
    if (Object.keys(body).some(key => operation !== "decline" || key !== "reason") ||
        (Object.hasOwn(body, "reason") && !validConsentText(body.reason))) {
      throw new HttpError(400, "invalid_consent_request");
    }
    result = await run(operation, { ...body, requestId: id });
  }
  return json(response, result.status, result.value);
}

export async function handleConsent(request, response, identity, config, url) {
  if (url.search) throw new HttpError(400, "invalid_query");
  response.setHeader("Cache-Control", "no-store");
  const path = url.pathname;
  for (const base of [RESOURCE_REQUESTS_PATH, SUBJECT_REQUESTS_PATH]) {
    if (path === base || path.startsWith(`${base}/`)) {
      return handleResourceConsentRequests(request, response, identity, config, path, base);
    }
  }
  if (path === RESOURCE_CONSENTS_PATH || path.startsWith(`${RESOURCE_CONSENTS_PATH}/`)) {
    return handleResourceConsents(request, response, identity, config, path);
  }
  if (path === CONSENTS_PATH) {
    if (request.method === "GET") {
      return json(response, 200, (await command(config, identity, "junctura_subject_api", "subject_consent", "list", {})).value);
    }
    if (request.method !== "POST") throw new HttpError(405, "method_not_allowed");
    const consent = validateConsentBody(await readObject(request));
    const key = request.headers["idempotency-key"];
    if (!uuidPattern.test(key ?? "")) throw new HttpError(400, "invalid_request");
    const result = await command(config, identity, "junctura_subject_api", "subject_consent", "create",
      { consent, key, digest: logicalRequestDigest({ body: consent }) });
    response.setHeader("Location", result.headers?.Location ?? `${CONSENTS_PATH}/${result.value.consentId}`);
    return json(response, result.status, result.value);
  }
  const revoke = path.match(/^\/v1\/me\/consents\/([^/]+)\/revoke$/);
  if (revoke) {
    if (revoke[1].length !== 36 || !uuidPattern.test(revoke[1])) throw new HttpError(400, "invalid_consent_path");
    if (request.method !== "POST") throw new HttpError(405, "method_not_allowed");
    const body = await readObject(request);
    if (Object.keys(body).length) throw new HttpError(400, "invalid_consent");
    return json(response, 200, (await command(config, identity, "junctura_subject_api", "subject_consent", "revoke", { consentId: revoke[1] })).value);
  }
  if (path === EMERGENCY_PATH) {
    if (request.method !== "GET") throw new HttpError(405, "method_not_allowed");
    return json(response, 200, (await command(config, identity, "junctura_trust_api", "emergency_review", "list", {})).value);
  }
  const review = path.match(/^\/v1\/emergency-accesses\/([^/]+)\/review$/);
  if (review) {
    if (review[1].length !== 36 || !uuidPattern.test(review[1])) throw new HttpError(400, "invalid_emergency_path");
    if (request.method !== "POST") throw new HttpError(405, "method_not_allowed");
    requireWriter(identity);
    const body = await readObject(request);
    if (Object.keys(body).sort().join(",") !== "decision,note") throw new HttpError(400, "invalid_emergency_review");
    return json(response, 200, (await command(config, identity, "junctura_trust_api", "emergency_review", "review", { executionId: review[1], ...body })).value);
  }
  throw new HttpError(404, "not_found");
}
