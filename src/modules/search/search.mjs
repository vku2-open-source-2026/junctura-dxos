// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Tenant search over records and clean object text. Meilisearch only ranks
// candidates; PostgreSQL answers the live access check on the current version
// and schema, so a stale or revoked hit never becomes a reference. The worker
// drains the transactional job queue and confirms every index task.
import { createHash, randomUUID } from "node:crypto";
import { applicationToken } from "../applications/applications.mjs";
import { signInternalToken } from "../../platform/security/internal-token.mjs";
import { HttpError, json, uuidPattern } from "../../platform/http/http.mjs";
import { extractText } from "./extract.mjs";
import { createMeilisearch } from "./meilisearch.mjs";

export const SEARCH_PATH = "/v1/search";
const maxTextLength = 65_536;

async function searchRpc(config, identity, operation, payload, worker = false) {
  if (!config.dataUrl) throw new HttpError(503, "search_unavailable");
  let result;
  try {
    const token = worker
      ? signInternalToken(config.dataSecret, { role: "junctura_search_worker",
        ...(identity.tenantId ? { tenant_id: identity.tenantId } : {}),
        aud: "junctura-data", exp: Math.floor(Date.now() / 1000) + 30 })
      : applicationToken(identity, config.dataSecret, "junctura_resource_api");
    const db = await fetch(`${config.dataUrl}/rpc/search_command`, {
      method: "POST", redirect: "error",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ operation, payload }),
      signal: AbortSignal.timeout(5000),
    });
    if (!db.ok) throw Error();
    result = await db.json();
  } catch { throw new HttpError(503, "search_unavailable"); }
  if (result?.error) throw new HttpError(result.status, result.error);
  if (result?.status !== 200) throw new HttpError(503, "search_unavailable");
  return result;
}

// The cursor binds to the query, the caller and the index generation; an
// expired or foreign cursor fails closed with invalid_cursor.
function fingerprint(query, identity) {
  return createHash("sha256").update(JSON.stringify({
    q: query, caller: identity.appId ?? `client:${identity.clientId}`,
  })).digest("base64url");
}

export function encodeSearchCursor(query, identity, generation, offset) {
  return Buffer.from(JSON.stringify({
    o: offset, g: generation, f: fingerprint(query, identity),
    e: Date.now() + 3_600_000,
  })).toString("base64url");
}

export function decodeSearchCursor(cursor, query, identity) {
  try {
    if (!cursor || cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw Error();
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) throw Error();
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== "e,f,g,o" ||
        !Number.isSafeInteger(value.o) || value.o < 0 ||
        !uuidPattern.test(value.g) || value.f !== fingerprint(query, identity) ||
        !Number.isSafeInteger(value.e) || value.e < Date.now()) throw Error();
    return { offset: value.o, generation: value.g };
  } catch { throw new HttpError(400, "invalid_cursor"); }
}

function searchQuery(url) {
  const values = new Map();
  for (const [key, value] of url.searchParams) {
    if (!["q", "limit", "cursor"].includes(key) || values.has(key)) throw new HttpError(400, "invalid_query");
    values.set(key, value);
  }
  const q = values.get("q");
  if (q === undefined || q.length < 1 || q.length > 256 || !q.isWellFormed()) throw new HttpError(400, "invalid_query");
  const limit = values.get("limit") ?? "50";
  if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100) throw new HttpError(400, "invalid_query");
  return { q, limit: Number(limit), cursor: values.get("cursor") };
}

export async function handleSearch(request, response, identity, config, url) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    throw new HttpError(405, "method_not_allowed");
  }
  if (!identity.clientId) throw new HttpError(403, "verified_client_required");
  const { q, limit, cursor } = searchQuery(url);
  const page = cursor === undefined
    ? { offset: 0 } : decodeSearchCursor(cursor, q, identity);
  const meili = createMeilisearch(config);
  const { hits } = await meili.search(identity.tenantId, q, limit + 1, page.offset);
  const candidates = hits.map((hit, position) => ({
    kind: hit.kind, id: hit.resourceId, version: hit.version, incarnation: hit.incarnation, position,
  }));
  const { value } = await searchRpc(config, identity, "acl", { candidates });
  // A cursor from another index generation is expired even when it parses.
  if (cursor !== undefined && value.generation !== page.generation) throw new HttpError(400, "invalid_cursor");
  const visible = new Set(value.items.filter(Boolean).map(item => `${item.kind}:${item.id}`));
  const items = hits.filter(hit => visible.has(`${hit.kind}:${hit.resourceId}`)).slice(0, limit)
    .map(hit => hit.kind === "record"
      ? { type: "record", recordRef: { collection: hit.collection, id: hit.resourceId } }
      : { type: "object", objectId: hit.resourceId });
  const nextCursor = hits.length > limit
    ? encodeSearchCursor(q, identity, value.generation, page.offset + limit + 1) : null;
  return json(response, 200, { items, nextCursor });
}

async function workerRpc(config, tenantId, operation, payload) {
  return (await searchRpc(config, { tenantId }, operation, payload, true)).value;
}

async function fetchObjectBytes(config, tenantId, value) {
  try {
    const response = await fetch(`${config.objectsUrl}/junctura-app/${tenantId}/${value.ownerAppId}/${value.id}/${value.version}`,
      { signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (!response.ok) return null;
    return Buffer.from(await response.arrayBuffer());
  } catch { return null; }
}

// Records contribute their declared searchable fields minus the sensitive ones;
// objects contribute extracted text from clean published bytes.
async function renderDocument(config, tenantId, job) {
  const value = (await workerRpc(config, tenantId, "document", { kind: job.kind, id: job.id }))?.value;
  const documentId = `${job.kind}:${job.id}`;
  if (!value) return { documentId, text: null };
  if (job.kind === "record") {
    const sensitive = new Set(value.sensitive ?? []);
    const chunks = [];
    for (const field of value.searchable ?? []) {
      if (sensitive.has(field)) continue;
      const item = value.data?.[field];
      if (typeof item === "string" && item.isWellFormed()) chunks.push(item);
      else if (typeof item === "number" && Number.isFinite(item)) chunks.push(String(item));
    }
    const text = chunks.join("\n").slice(0, maxTextLength);
    return { documentId, text: text.length ? text : null,
      document: { id: documentId, kind: "record", resourceId: value.id, collection: value.collection,
        version: value.version, incarnation: value.incarnation, text } };
  }
  const bytes = await fetchObjectBytes(config, tenantId, value);
  const text = bytes ? extractText(bytes) : null;
  return { documentId, text,
    document: text ? { id: documentId, kind: "object", resourceId: value.id,
      version: value.version, text } : null };
}

async function indexJob(config, meili, job) {
  if (job.reason === "delete") {
    await meili.remove(job.tenant, `${job.kind}:${job.id}`);
    return;
  }
  const { documentId, text, document } = await renderDocument(config, job.tenant, job);
  if (!text) {
    await meili.remove(job.tenant, documentId);
    return;
  }
  await meili.upsert(job.tenant, document);
}

// One worker drains a tenant at a time: the lease stops a slow replica from
// overwriting a newer render with an older one. Jobs for the same resource
// collapse into their newest row, so each document is written once.
async function drainTenant(config, meili, tenantId) {
  const lease = randomUUID();
  const fenced = async (operation, payload = {}) => workerRpc(config, tenantId, operation, { ...payload, lease });
  let acquired;
  try { acquired = (await fenced("acquire")).value?.acquired; }
  catch (error) { if (error instanceof HttpError && error.status === 409) return false; throw error; }
  if (!acquired) return false;
  try {
    for (;;) {
      if (!(await fenced("renew")).value?.renewed) return false;
      const jobs = (await workerRpc(config, tenantId, "jobs", { limit: 32 })).value;
      if (!jobs.length) return true;
      const newest = new Map();
      for (const job of jobs) {
        const key = `${job.kind}:${job.id}`;
        if (!newest.has(key) || newest.get(key).jobId < job.jobId) newest.set(key, job);
      }
      for (const job of newest.values()) {
        try {
          await indexJob(config, meili, job);
        } catch { /* The job stays queued; the lease expires and the next pass retries. */ }
      }
      await workerRpc(config, tenantId, "drop", { jobIds: jobs.map(job => job.jobId) });
    }
  } finally {
    await fenced("release").catch(() => {});
  }
}

// A Meilisearch outage only delays indexing; the durable queue keeps every job
// and the next pass retries. A crashed worker leaves its claimed jobs queued.
export function startSearchIndexer(config, delay = 3_000) {
  if (!config.searchUrl || !config.dataUrl) return undefined;
  const meili = createMeilisearch(config);
  let stopped = false;
  async function sweep() {
    for (;;) {
      if (stopped) return;
      const tenants = await workerRpc(config, undefined, "tenants", {});
      if (!tenants.length) return;
      for (const tenantId of tenants) {
        if (stopped) return;
        try { await drainTenant(config, meili, tenantId); }
        catch { /* The lease expires and the next pass retries the tenant. */ }
      }
      return;
    }
  }
  async function tick() {
    try { await sweep(); }
    catch { /* Retry database or index outages on the next pass. */ }
    if (!stopped) timer = setTimeout(tick, delay).unref();
  }
  let timer = setTimeout(tick, delay).unref();
  return () => { stopped = true; clearTimeout(timer); };
}
