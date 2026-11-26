// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from "node:crypto";

export class HttpError extends Error {
  constructor(status, code, details) {
    super(code);
    this.status = status;
    if (details) this.details = details;
  }
}

const requestIds = new WeakMap();
export const accessDenialCodes = new Set([
  "not_assigned_to_app", "capability_not_granted", "consent_required", "consent_missing",
  "consent_revoked", "consent_expired", "unit_mismatch", "delegation_not_allowed",
]);

export function requestIdFor(request) {
  if (!requestIds.has(request)) {
    const gatewayId = request.headers["x-junctura-request-id"];
    requestIds.set(request, typeof gatewayId === "string" && /^[0-9a-f]{32}$/.test(gatewayId)
      ? gatewayId.replace(/^(........)(....)(....)(....)(............)$/, "$1-$2-$3-$4-$5")
      : randomUUID());
  }
  return requestIds.get(request);
}

export function json(response, status, payload, method = "GET") {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(method === "HEAD" ? undefined : body);
}

export async function readBody(request, limit) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > limit) {
      request.resume();
      throw new HttpError(413, "body_too_large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(request) {
  if (request.headers["content-type"]?.split(";", 1)[0].trim() !== "application/json") throw new HttpError(415, "json_required");
  const bytes = await readBody(request, 65536);
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw new HttpError(400, "invalid_json"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "object_required");
  return value;
}

// Strict reader for flat registration/share bodies. It rejects duplicate keys,
// malformed Unicode and nested values; it is not a general schema validator.
export async function readFlatJsonObject(request) {
  if (request.headers["content-type"]?.split(";", 1)[0].trim() !== "application/json") throw new HttpError(415, "json_required");
  const bytes = await readBody(request, 65536);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw Error();
    for (const value of Object.values(body)) {
      if ((typeof value !== "string" || !value.isWellFormed()) && (typeof value !== "number" || !Number.isSafeInteger(value))) throw Error();
    }
    const keys = new Set();
    for (const match of text.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
      if (text.slice(match.index + match[0].length).trimStart().startsWith(":")) {
        const key = JSON.parse(match[0]);
        if (keys.has(key) || !key.isWellFormed()) throw Error();
        keys.add(key);
      }
    }
    return body;
  } catch { throw new HttpError(400, "invalid_json"); }
}

export function requireWriter(identity) {
  if (!identity.roles.includes("core-writer")) throw new HttpError(403, "write_forbidden");
}

export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function readCursorPage(params, queryError, cursorError, filters = {}) {
  const payload = {};
  const keys = new Set(["limit", "cursor", ...Object.keys(filters)]);
  const supplied = [...params.keys()];
  if (new Set(supplied).size !== supplied.length || supplied.some(key => !keys.has(key))) {
    throw new HttpError(400, queryError);
  }
  if (params.has("limit")) {
    const value = params.get("limit");
    const limit = Number(value);
    if (!/^[0-9]{1,3}$/.test(value) || limit < 1 || limit > 100) throw new HttpError(400, queryError);
    payload.limit = limit;
  }
  if (params.has("cursor")) {
    const value = params.get("cursor");
    if (!/^[0-9a-f]{1,512}$/i.test(value)) throw new HttpError(400, cursorError);
    payload.cursor = value.toLowerCase();
  }
  for (const [key, allowed] of Object.entries(filters)) {
    if (!params.has(key)) continue;
    const value = params.get(key);
    if (!allowed.includes(value)) {
      throw new HttpError(400, queryError);
    }
    payload[key] = value;
  }
  return payload;
}

export const jsonObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (jsonObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function logicalRequestDigest({ body, ifMatch }) {
  return createHash("sha256").update(canonicalJson({ body: body ?? null, ifMatch: ifMatch ?? null })).digest("hex");
}

export function parseRecordJson(text) {
  if (!text.isWellFormed()) throw new SyntaxError("invalid_unicode");
  const value = JSON.parse(text, (key, item, context) => {
    if (key.includes("\0") || !key.isWellFormed() ||
        (typeof item === "string" && (item.includes("\0") || !item.isWellFormed()))) {
      throw new SyntaxError("invalid_unicode");
    }
    if (typeof item === "number" &&
        (Math.abs(item) > 2 ** 53 || !Number.isFinite(item) ||
          decimalValue(context.source) !== decimalValue(String(item)))) {
      throw new SyntaxError("invalid_number");
    }
    return item;
  });
  const containers = [];
  for (const [token, keyToken] of text.matchAll(/("(?:[^"\\]|\\.)*"(?=[ \r\n\t]*:))|"(?:[^"\\]|\\.)*"|[{}\[\]]/gs)) {
    if (token === "{" || token === "[") {
      containers.push(token === "{" ? new Set() : null);
      if (containers.length > 256) throw new SyntaxError("document_too_deep");
    } else if (token === "}" || token === "]") {
      containers.pop();
    } else if (keyToken) {
      const keys = containers.at(-1);
      const key = JSON.parse(keyToken);
      if (keys.has(key)) throw new SyntaxError("duplicate_key");
      keys.add(key);
    }
  }
  return value;
}

function decimalValue(source) {
  const [mantissa, exponent = "0"] = source.toLowerCase().split("e");
  const sign = mantissa.startsWith("-") ? "-" : "";
  const [whole, fraction = ""] = mantissa.replace("-", "").split(".");
  const digits = (whole + fraction).replace(/^0+/, "");
  if (!digits) return "0";
  const significant = digits.replace(/0+$/, "");
  return sign + significant + "e" + (Number(exponent) - fraction.length + digits.length - significant.length);
}

export async function readRecordJson(request, limit = 65536) {
  if (request.headers["content-type"]?.split(";", 1)[0].trim() !== "application/json") {
    throw new HttpError(415, "json_required");
  }
  const bytes = await readBody(request, limit);
  try { return parseRecordJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)); }
  catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError) {
      throw new HttpError(400, "invalid_request");
    }
    throw error;
  }
}
