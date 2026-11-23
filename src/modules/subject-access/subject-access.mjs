// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// The data subject's own access history, reports and emergency feedback. The
// database merges capability calls and application events visible to the
// caller's bound subject, and re-checks that exact visibility for every flag;
// Core only validates the envelope and asserts the private subject role.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { applicationToken } from "../applications/applications.mjs";
import { HttpError, json, readBody, uuidPattern } from "../../platform/http/http.mjs";

export const SUBJECT_ACCESS_EVENTS_PATH = "/v1/me/data-access";
const accessIdPattern = /^(capability|app):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The database keeps and sorts full timestamp precision; the cursor key does
// the same so same-instant entries never fall between pages.
const accessedAtPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const controlPattern = /[\u0000-\u001f\u007f]/u;

async function subjectCommand(config, identity, operation, payload) {
  if (!config.dataUrl) throw new HttpError(503, "subject_access_unavailable");
  if (!identity.clientId) throw new HttpError(403, "verified_client_required");
  let result;
  try {
    const db = await fetch(`${config.dataUrl}/rpc/subject_access_command`, {
      method: "POST", redirect: "error",
      headers: { Authorization: `Bearer ${applicationToken(identity, config.dataSecret, "junctura_subject_api")}`,
        "Content-Type": "application/json" },
      body: JSON.stringify({ operation, payload }),
      signal: AbortSignal.timeout(5000),
    });
    if (!db.ok) throw Error();
    result = await db.json();
  } catch { throw new HttpError(503, "subject_access_unavailable"); }
  if (result?.error) throw new HttpError(result.status, result.error, result.details);
  if (![200, 201].includes(result?.status)) throw new HttpError(503, "subject_access_unavailable");
  return result;
}

// A cursor only pages the caller it was issued to. The raw issuer can be two
// kilobytes long, so the cursor never carries identity verbatim: it carries a
// fixed-length fingerprint of the tenant, issuer, login subject and verified
// subject, signed with the data secret so neither key nor binding can be
// forged, and fails closed on any mismatch.
function scopeFingerprint(identity) {
  return createHash("sha256").update(JSON.stringify({
    tenant: identity.tenantId, issuer: identity.issuer,
    login: identity.subject, subject: identity.subjectId,
  })).digest("base64url");
}

function decodeCursor(value, identity, secret) {
  try {
    if (!value || value.length > 1024) throw Error();
    const split = value.lastIndexOf(".");
    if (split <= 0) throw Error();
    const payload = value.slice(0, split);
    const mac = value.slice(split + 1);
    if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(mac)) throw Error();
    const expected = createHmac("sha256", secret).update(payload).digest("base64url");
    if (mac.length !== expected.length ||
        !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) throw Error();
    const cursor = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(payload, "base64url")));
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor) ||
        Object.keys(cursor).sort().join(",") !== "accessId,accessedAt,f" ||
        !accessedAtPattern.test(cursor.accessedAt) || !Number.isFinite(Date.parse(cursor.accessedAt)) ||
        !accessIdPattern.test(cursor.accessId) || cursor.f !== scopeFingerprint(identity)) {
      throw Error();
    }
    return { accessedAt: cursor.accessedAt, accessId: cursor.accessId };
  } catch { throw new HttpError(400, "invalid_cursor"); }
}

function encodeCursor(entry, identity, secret) {
  const payload = Buffer.from(JSON.stringify({
    accessedAt: entry.accessedAt, accessId: entry.accessId, f: scopeFingerprint(identity),
  })).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

async function readJson(request) {
  if (request.headers["content-type"]?.split(";", 1)[0].trim() !== "application/json") throw new HttpError(415, "json_required");
  const bytes = await readBody(request, 16384);
  let value;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new HttpError(400, "invalid_request"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid_request");
  return value;
}

export async function handleSubjectAccessEvents(request, response, identity, config, url) {
  response.setHeader("Cache-Control", "no-store");
  if (url.pathname === SUBJECT_ACCESS_EVENTS_PATH && request.method === "GET") {
    const values = new Map();
    for (const [key, value] of url.searchParams) {
      if (!["limit", "cursor"].includes(key) || values.has(key)) throw new HttpError(400, "invalid_query");
      values.set(key, value);
    }
    const limit = values.get("limit") ?? "200";
    if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 200) throw new HttpError(400, "invalid_query");
    const { value } = await subjectCommand(config, identity, "list", {
      limit: Number(limit),
      ...(values.has("cursor") ? { after: decodeCursor(values.get("cursor"), identity, config.dataSecret) } : {}),
    });
    const nextCursor = value.truncated && value.entries.length
      ? encodeCursor(value.entries.at(-1), identity, config.dataSecret) : null;
    return json(response, 200, {
      entries: value.entries, nextCursor, truncated: value.truncated, generatedAt: value.generatedAt,
    });
  }
  const flag = url.pathname.match(/^\/v1\/me\/data-access\/([^/]+)\/flag$/);
  if (flag && request.method === "POST") {
    if (!accessIdPattern.test(decodeURIComponent(flag[1]))) throw new HttpError(400, "invalid_request");
    if (url.search) throw new HttpError(400, "invalid_query");
    const body = await readJson(request);
    if (Object.keys(body).sort().join(",") !== "reason" || !["unrecognized", "other"].includes(body.reason)) {
      throw new HttpError(400, "invalid_request");
    }
    const { status, value } = await subjectCommand(config, identity, "flag", {
      accessId: decodeURIComponent(flag[1]), reason: body.reason,
    });
    return json(response, status, value);
  }
  const feedback = url.pathname.match(/^\/v1\/me\/emergency-accesses\/([^/]+)\/feedback$/);
  if (feedback && request.method === "POST") {
    if (feedback[1].length !== 36 || !uuidPattern.test(feedback[1])) throw new HttpError(400, "invalid_request");
    if (url.search) throw new HttpError(400, "invalid_query");
    const body = await readJson(request);
    const keys = Object.keys(body).sort().join(",");
    if ((keys !== "decision" && keys !== "decision,message") ||
        !["recognized", "unrecognized", "other"].includes(body.decision) ||
        (body.message !== undefined && (typeof body.message !== "string" || body.message.length < 1 ||
          body.message.length > 500 || controlPattern.test(body.message) || !body.message.isWellFormed()))) {
      throw new HttpError(400, "invalid_request");
    }
    const { status, value } = await subjectCommand(config, identity, "feedback", {
      executionId: feedback[1], decision: body.decision,
      ...(body.message !== undefined ? { message: body.message } : {}),
    });
    return json(response, status, value);
  }
  throw new HttpError(404, "not_found");
}
