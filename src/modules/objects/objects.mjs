// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from "node:crypto";
import { HttpError, json, logicalRequestDigest, parseRecordJson, readBody, requireWriter, uuidPattern } from "../../platform/http/http.mjs";
import { resourceCommand, resourceRequest } from "../resources/resources.mjs";
import { requireCleanObject } from "./malware-scan.mjs";
import { boundaryOf, parseMultipart } from "./multipart.mjs";

const maxBytes = 5 * 1024 * 1024;
// Multipart framing adds the boundary and the metadata parts around the same
// 5 MiB file; the contract bounds the whole envelope at 5.308.416 bytes.
const maxEnvelopeBytes = 5_308_416;
const collectionPattern = /^[a-z][a-z0-9_-]{0,62}$/;
const tagPattern = /^[a-z][a-z0-9_-]{0,63}$/;

export async function checkObjectReadiness(config, request = fetch) {
  const filer = await request(`${config.objectsUrl}/?limit=0`, { signal: AbortSignal.timeout(3000), redirect: "error" });
  if (!filer.ok) throw new Error("Filer not ready");
  await filer.arrayBuffer();
  const master = await request(`${config.objectsMasterUrl}/dir/status`, { signal: AbortSignal.timeout(3000), redirect: "error" });
  if (!master.ok) throw new Error("Object master not ready");
  const topology = (await master.json()).Topology;
  // Filer metadata can respond before a restarted volume has registered.
  if (!topology?.DataCenters?.some((center) => center.Racks?.some((rack) => rack.DataNodes?.some((node) => node.Max > 0)))) {
    throw new Error("No object volume registered");
  }
}

export async function checkMalwareScannerReadiness(config, scanPing = defaultScannerPing) {
  if (!config.clamavHost || !config.clamavPort) throw new Error("Malware scanner not configured");
  await scanPing(config);
}

async function defaultScannerPing(config) {
  const net = await import("node:net");
  await new Promise((resolve, reject) => {
    const socket = net.connect({ host: config.clamavHost, port: config.clamavPort });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Malware scanner timeout"));
    }, 3000);
    socket.on("connect", () => {
      socket.write("zPING\0");
    });
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      if (/PONG/i.test(data)) {
        clearTimeout(timer);
        socket.end();
        resolve();
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("end", () => {
      clearTimeout(timer);
      if (/PONG/i.test(data)) resolve();
      else reject(new Error("Malware scanner not ready"));
    });
  });
}

async function storage(config, tenantId, id, options = {}, scope, { quarantine = false } = {}) {
  let response;
  try {
    const path = quarantine
      ? `junctura-quarantine/${tenantId}/${id}/${scope?.version ?? "legacy"}`
      : scope
        ? `junctura-app/${tenantId}/${scope.ownerAppId}/${id}/${scope.version}`
        : `junctura/${tenantId}/${id}`;
    response = await fetch(`${config.objectsUrl}/${path}`, {
      ...options, signal: AbortSignal.timeout(10000), redirect: "error",
    });
  } catch { throw new HttpError(503, "objects_unavailable"); }
  if (response.status === 404) throw new HttpError(404, "not_found");
  if (!response.ok) throw new HttpError(503, "objects_unavailable");
  return response;
}

async function removeQuarantine(config, tenantId, id, scope) {
  try {
    await (await storage(config, tenantId, id, { method: "DELETE" }, scope, { quarantine: true })).arrayBuffer();
  } catch {
    // Best-effort cleanup; never publish unscanned bytes.
  }
}

async function removeVersion(config, tenantId, id, scope) {
  try {
    await (await storage(config, tenantId, id, { method: "DELETE" }, scope)).arrayBuffer();
  } catch {
    // Best-effort cleanup of bytes that never became the committed version.
  }
}

async function objectCommand(config, identity, operation, payload = {}) {
  const result = await resourceRequest(config, identity, "rpc/object_command", new URLSearchParams(),
    { method: "POST", body: JSON.stringify({ operation, payload }) });
  if (result.error) throw new HttpError(result.status, result.error, result.details);
  return result;
}

// Legacy published versions carry no byte size in PostgreSQL. Before the app
// quota is charged, Core reads each unknown size from the Filer's current
// version and backfills it; a version that has since been replaced backfills
// never and old bytes stay uncounted.
async function backfillObjectSizes(config, identity) {
  const { value: missing } = await objectCommand(config, identity, "missing", { limit: 64 });
  if (!missing.length) return;
  const sizes = [];
  for (const entry of missing) {
    try {
      const head = await storage(config, identity.tenantId, entry.id, { method: "HEAD" },
        { ownerAppId: identity.appId, version: entry.version });
      const length = Number(head.headers.get("content-length"));
      if (Number.isSafeInteger(length) && length >= 1 && length <= maxBytes) {
        sizes.push({ id: entry.id, version: entry.version, size: length });
      }
    } catch { /* The next pass retries a missing or unavailable legacy byte. */ }
  }
  if (sizes.length) await objectCommand(config, identity, "backfill", { sizes });
}

function parseTags(value) {
  if (!Array.isArray(value) || value.length > 20 ||
      value.some(tag => typeof tag !== "string" || !tag.isWellFormed() || !tagPattern.test(tag))) {
    throw new HttpError(400, "invalid_request");
  }
  if (new Set(value).size !== value.length) throw new HttpError(400, "invalid_request");
  return value;
}

function parseRecordRef(value) {
  if (value !== null && (typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "collection,id" ||
      !collectionPattern.test(value.collection) || !uuidPattern.test(value.id))) {
    throw new HttpError(400, "invalid_request");
  }
  return value;
}

function metadataPart(parts, name) {
  const part = parts.find(part => part.name === name);
  if (!part) return { present: false, value: undefined };
  if (part.contentType !== "application/json") throw new HttpError(415, "json_required");
  let parsed;
  try {
    parsed = parseRecordJson(new TextDecoder("utf-8", { fatal: true }).decode(part.value));
  } catch (error) {
    if (error instanceof SyntaxError) throw new HttpError(400, "invalid_request");
    throw error;
  }
  return { present: true, value: parsed };
}

// The logical request covers the file bytes and the normalized metadata; the
// boundary is transport framing. An omitted metadata part differs from an
// explicit null or empty array because the digest covers presence too.
export function uploadDigest(bytes, recordRef, tags) {
  return logicalRequestDigest({ body: {
    bytes: createHash("sha256").update(bytes).digest("hex"),
    ...(recordRef.present ? { recordRef: parseRecordRef(recordRef.value) } : {}),
    ...(tags.present ? { tags: parseTags(tags.value) } : {}),
  } });
}

function metadataPayload(recordRef, tags) {
  return {
    ...(recordRef.present ? { recordRef: recordRef.value === undefined ? null : parseRecordRef(recordRef.value) } : {}),
    ...(tags.present ? { tags: parseTags(tags.value) } : {}),
  };
}

// The envelope policy: exactly one binary file part, at most one JSON part per
// metadata field, no unknown parts. The metadata part descriptors keep the
// presence distinction that the digest and the replace semantics rely on.
export function metadataEnvelope(parts) {
  const names = parts.map(part => part.name);
  if (names.filter(name => name === "file").length !== 1 || new Set(names).size !== names.length ||
      names.some(name => name !== "file" && name !== "recordRef" && name !== "tags")) {
    throw new HttpError(400, "invalid_multipart");
  }
  const file = parts.find(part => part.name === "file");
  if (file.contentType !== "application/octet-stream") throw new HttpError(415, "binary_required");
  return { file: file.value, recordRef: metadataPart(parts, "recordRef"), tags: metadataPart(parts, "tags") };
}

async function uploadObject(request, response, identity, config, url, objectId) {
  requireWriter(identity);
  if (url.search) throw new HttpError(400, "invalid_query");
  const contentType = request.headers["content-type"] ?? "";
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  let bytes;
  let recordRef = { present: false, value: undefined };
  let tags = { present: false, value: undefined };
  if (mediaType === "multipart/form-data") {
    const boundary = boundaryOf(contentType);
    if (!boundary) throw new HttpError(400, "invalid_multipart");
    ({ file: bytes, recordRef, tags } = metadataEnvelope(
      parseMultipart(await readBody(request, maxEnvelopeBytes), boundary)));
  } else {
    if (mediaType !== "application/octet-stream") throw new HttpError(415, "binary_required");
    bytes = await readBody(request, maxBytes);
  }
  if (bytes.length < 1) throw new HttpError(400, "invalid_request");
  if (bytes.length > maxBytes) throw new HttpError(413, "body_too_large");

  const key = request.headers["idempotency-key"];
  if (!uuidPattern.test(key ?? "")) throw new HttpError(400, "invalid_request");
  const method = request.method;
  const path = url.pathname;
  const digest = uploadDigest(bytes, recordRef, tags);
  const replay = await objectCommand(config, identity, "replay", { key, digest, method, path });
  if (replay.value !== null) return json(response, replay.status, replay.value, method);

  await backfillObjectSizes(config, identity);
  const current = (await objectCommand(config, identity, "prepare", {
    id: objectId, ...metadataPayload(recordRef, tags),
  })).value;
  const status = current.version ? 200 : 201;
  // Quarantine → ClamAV → publish. Unscanned bytes never become downloadable.
  const scope = { ownerAppId: current.ownerAppId, version: randomUUID() };
  const uploadForm = () => {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "application/octet-stream" }), objectId);
    return form;
  };
  try {
    const quarantined = await storage(config, identity.tenantId, objectId, { method: "POST", body: uploadForm() }, scope, { quarantine: true });
    await quarantined.arrayBuffer();
    await requireCleanObject(bytes, config);
    const published = await storage(config, identity.tenantId, objectId, { method: "POST", body: uploadForm() }, scope);
    await published.arrayBuffer();
    const commit = await objectCommand(config, identity, "commit", {
      id: objectId, version: scope.version, size: bytes.length, status, key, digest, method, path,
      ...metadataPayload(recordRef, tags),
    });
    if (commit.replayed) {
      // A concurrent identical upload committed first; its result replays and
      // the bytes published for this attempt stay orphans no longer.
      await removeVersion(config, identity.tenantId, objectId, scope);
      return json(response, commit.status, commit.value, method);
    }
    return json(response, commit.status, commit.value, method);
  } catch (error) {
    await removeVersion(config, identity.tenantId, objectId, scope);
    throw error;
  } finally {
    await removeQuarantine(config, identity.tenantId, objectId, scope);
  }
}

export function parseMetadataQuery(url) {
  const values = new Map();
  for (const [key, value] of url.searchParams) {
    if (!["limit", "cursor", "recordRef[collection]", "recordRef[id]", "tag"].includes(key) ||
        values.has(key)) throw new HttpError(400, "invalid_query");
    values.set(key, value);
  }
  const refCollection = values.get("recordRef[collection]");
  const refId = values.get("recordRef[id]");
  if ((refCollection === undefined) !== (refId === undefined)) throw new HttpError(400, "invalid_query");
  if (refCollection !== undefined && (!collectionPattern.test(refCollection) || !uuidPattern.test(refId))) {
    throw new HttpError(400, "invalid_query");
  }
  const tag = values.get("tag");
  if (tag !== undefined && !tagPattern.test(tag)) throw new HttpError(400, "invalid_query");
  const limit = values.get("limit") ?? "50";
  if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100) throw new HttpError(400, "invalid_query");
  return {
    limit: Number(limit),
    recordRef: refCollection === undefined ? null : { collection: refCollection, id: refId },
    tag,
    cursor: values.get("cursor"),
  };
}

// The cursor binds to the caller, the filters and the page number space; a
// cursor reused with different filters is an invalid_cursor.
export function encodeMetadataCursor(filters, after) {
  const fingerprint = createHash("sha256").update(JSON.stringify({
    appId: filters.appId, recordRef: filters.recordRef, tag: filters.tag,
  })).digest("base64url");
  return Buffer.from(JSON.stringify({ a: after, f: fingerprint })).toString("base64url");
}

export function decodeMetadataCursor(cursor, filters) {
  try {
    if (!cursor || cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw Error();
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) throw Error();
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const fingerprint = createHash("sha256").update(JSON.stringify({
      appId: filters.appId, recordRef: filters.recordRef, tag: filters.tag,
    })).digest("base64url");
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== "a,f" || !uuidPattern.test(value.a) || value.f !== fingerprint) {
      throw Error();
    }
    return value.a;
  } catch { throw new HttpError(400, "invalid_cursor"); }
}

async function listObjects(request, response, identity, config, url) {
  const filters = parseMetadataQuery(url);
  const after = filters.cursor === undefined
    ? undefined : decodeMetadataCursor(filters.cursor, { appId: identity.appId, recordRef: filters.recordRef, tag: filters.tag });
  await backfillObjectSizes(config, identity);
  const { value } = await objectCommand(config, identity, "list", {
    limit: filters.limit,
    ...(filters.recordRef ? { recordRef: filters.recordRef } : {}),
    ...(filters.tag !== undefined ? { tag: filters.tag } : {}),
    ...(after !== undefined ? { after } : {}),
  });
  const items = value.slice(0, filters.limit);
  const nextCursor = value.length > filters.limit
    ? encodeMetadataCursor({ appId: identity.appId, recordRef: filters.recordRef, tag: filters.tag }, items.at(-1).id)
    : null;
  return json(response, 200, { items, nextCursor });
}

export async function handleObjects(request, response, identity, config, url) {
  const requestId = randomUUID();
  response.setHeader("X-Request-Id", requestId);
  try {
    return await serveObjects(request, response, identity, config, url);
  } catch (error) {
    if (error.status === 413) response.setHeader("Connection", "close");
    return json(response, error instanceof HttpError ? error.status : 503,
      { error: error instanceof HttpError ? error.message : "objects_unavailable", requestId,
        ...(error instanceof HttpError && error.details ? error.details : {}) }, request.method);
  }
}

async function serveObjects(request, response, identity, config, url) {
  const match = url.pathname.match(/^\/v[12]\/objects(?:\/([0-9a-f-]+))?$/);
  if (!match || (match[1] && !uuidPattern.test(match[1]))) throw new HttpError(400, "invalid_object_path");
  const id = match[1];
  const scoped = Boolean(identity.appId);
  const command = (operation, payload) => resourceCommand(config, identity, operation, payload).then(result => result.value);
  if ((request.method === "POST" && !id) || (request.method === "PUT" && id)) {
    if (scoped) return uploadObject(request, response, identity, config, url, id ?? randomUUID());
    if (url.search) throw new HttpError(400, "invalid_object_path");
    if (request.headers["content-type"]?.split(";", 1)[0].trim() !== "application/octet-stream") throw new HttpError(415, "binary_required");
    const bytes = await readBody(request, maxBytes);
    if (!bytes.length) throw new HttpError(400, "empty_object");
    const objectId = id ?? randomUUID();
    let status = 201;
    if (id) {
      try { await (await storage(config, identity.tenantId, id, { method: "HEAD" })).arrayBuffer(); status = 200; }
      catch (error) { if (error.status !== 404) throw error; }
    }

    // Quarantine → ClamAV → publish. Unscanned bytes never become downloadable.
    const uploadForm = () => {
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: "application/octet-stream" }), objectId);
      return form;
    };
    try {
      const quarantined = await storage(config, identity.tenantId, objectId, { method: "POST", body: uploadForm() }, undefined, { quarantine: true });
      await quarantined.arrayBuffer();
      await requireCleanObject(bytes, config);
      const published = await storage(config, identity.tenantId, objectId, { method: "POST", body: uploadForm() });
      await published.arrayBuffer();
      return json(response, status, { id: objectId, size: bytes.length }, request.method);
    } finally {
      await removeQuarantine(config, identity.tenantId, objectId);
    }
  }
  if (request.method === "GET" && id) {
    if (url.search) throw new HttpError(400, "invalid_object_path");
    const scope = scoped ? await command("object_get", { id }) : undefined;
    // v2 object_get already denies version=NULL (never committed / never scanned clean).
    const result = await storage(config, identity.tenantId, id, {}, scope);
    const bytes = Buffer.from(await result.arrayBuffer());
    if (scoped) await command("object_get", { id });
    response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": bytes.length,
      "Content-Disposition": `attachment; filename="${id}.bin"`, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });
    return response.end(bytes);
  }
  if (request.method === "GET" && !id && url.pathname === "/v2/objects") {
    if (!scoped) throw new HttpError(403, "application_access_required");
    return listObjects(request, response, identity, config, url);
  }
  if (request.method === "DELETE" && id) {
    requireWriter(identity);
    if (url.search) throw new HttpError(400, "invalid_object_path");
    if (scoped) await command("object_delete", { id });
    else {
      await (await storage(config, identity.tenantId, id, { method: "HEAD" })).arrayBuffer();
      await (await storage(config, identity.tenantId, id, { method: "DELETE" })).arrayBuffer();
    }
    response.writeHead(204);
    return response.end();
  }
  response.setHeader("Allow", id ? "GET, PUT, DELETE" : url.pathname === "/v2/objects" ? "GET, POST" : "POST");
  throw new HttpError(405, "method_not_allowed");
}
