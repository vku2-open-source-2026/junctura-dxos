// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Tenant search over records and clean object text. Meilisearch only ranks
// candidates; PostgreSQL answers the live access check on the current version,
// incarnation and schema revision, so a stale or revoked hit never becomes a
// reference. Each generation has its own index: a rebuild never touches the
// live documents, and a retired generation drops its whole index. Document ids
// are immutable per resource version and projection; superseded documents are
// removed by those immutable ids only, so a slow worker can never delete a
// document of a version it did not render.
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { applicationToken } from "../applications/applications.mjs";
import { signInternalToken } from "../../platform/security/internal-token.mjs";
import { HttpError, json, uuidPattern } from "../../platform/http/http.mjs";
import { extractText } from "./extract.mjs";
import { createMeilisearch, maxTotalHits } from "./meilisearch.mjs";

export const SEARCH_PATH = "/v1/search";
const maxTextLength = 65_536;
const batchSize = 100;
// Confirmations happen in small groups with a lease renewal between them, so
// one slow job cannot cost a whole batch its confirmed work.
const confirmGroup = 8;

const searchIndexUid = (tenantId, generation) => `junctura-search-${tenantId}-${generation}`;

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

async function workerRpc(config, tenantId, operation, payload) {
  return (await searchRpc(config, { tenantId }, operation, payload, true)).value;
}

// The cursor binds to the query, the caller identity and the caller's current
// app/share read scope: a grant added or revoked after it was issued expires
// every outstanding cursor of that caller.
function fingerprint(query, identity, scope) {
  return createHash("sha256").update(JSON.stringify({
    q: query, tenant: identity.tenantId, iss: identity.issuer,
    sub: identity.subject, client: identity.clientId, unit: identity.resourceUnit,
    scope: { management: scope?.management ?? [], shares: scope?.shares ?? [] },
  })).digest("base64url");
}

// The cursor is a signed page key: the payload stays client-visible but its
// offset, generation and expiry cannot be forged without the data secret.
function signCursor(value, secret) {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

function verifyCursor(cursor, secret) {
  const split = cursor.lastIndexOf(".");
  if (split <= 0) throw Error();
  const payload = cursor.slice(0, split);
  const mac = cursor.slice(split + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(mac)) throw Error();
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  if (mac.length !== expected.length ||
      !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) throw Error();
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(payload, "base64url")));
}

export function encodeSearchCursor(query, identity, scope, generation, offset, secret) {
  return signCursor({
    o: offset, g: generation, f: fingerprint(query, identity, scope),
    e: Date.now() + 3_600_000,
  }, secret);
}

export function decodeSearchCursor(cursor, query, identity, scope, secret) {
  try {
    if (!cursor || cursor.length > 1024) throw Error();
    const value = verifyCursor(cursor, secret);
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== "e,f,g,o" ||
        !Number.isSafeInteger(value.o) || value.o < 0 || value.o >= maxTotalHits ||
        !uuidPattern.test(value.g) || value.f !== fingerprint(query, identity, scope) ||
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

// Malformed index documents never become candidates: their rejection happens
// here, before PostgreSQL would fail a cast on a forged field.
function candidateOf(hit, position) {
  if ((hit.kind !== "record" && hit.kind !== "object") || typeof hit.resourceId !== "string" ||
      !uuidPattern.test(hit.resourceId) || typeof hit.ownerAppId !== "string" ||
      !uuidPattern.test(hit.ownerAppId) || (hit.projection !== "full" && hit.projection !== "management")) {
    return null;
  }
  if (hit.kind === "record") {
    if (typeof hit.incarnation !== "string" || !uuidPattern.test(hit.incarnation) ||
        !Number.isSafeInteger(hit.version) || hit.version < 1 ||
        !Number.isSafeInteger(hit.schemaRevision) || hit.schemaRevision < 0) {
      return null;
    }
  } else if (typeof hit.version !== "string" || !uuidPattern.test(hit.version)) {
    return null;
  }
  const candidate = {
    kind: hit.kind, id: hit.resourceId, ownerAppId: hit.ownerAppId,
    version: `${hit.version}`, projection: hit.projection, position,
  };
  if (hit.kind === "record") {
    candidate.incarnation = hit.incarnation;
    candidate.schemaRevision = `${hit.schemaRevision}`;
  }
  return candidate;
}

function itemOf(hit) {
  return hit.kind === "record"
    ? { type: "record", recordRef: { collection: hit.collection, id: hit.resourceId } }
    : { type: "object", objectId: hit.resourceId };
}

// The answer always comes from PostgreSQL at query time: the caller's read
// scope and the live generation are resolved first, so an expired or foreign
// cursor fails closed before the index is touched, then ranked batches are
// scanned, the hits the live ACL accepts keep their exact candidate position,
// and the page continues right after the last returned hit.
export async function handleSearch(request, response, identity, config, url) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    throw new HttpError(405, "method_not_allowed");
  }
  if (!identity.clientId) throw new HttpError(403, "verified_client_required");
  const { q, limit, cursor } = searchQuery(url);
  const { value: scope } = await searchRpc(config, identity, "scope", {});
  if (cursor !== undefined) {
    const page = decodeSearchCursor(cursor, q, identity, scope, config.dataSecret);
    if (page.generation !== scope.generation) throw new HttpError(400, "invalid_cursor");
    return scanSearchPage(request, response, identity, config, q, limit, scope, page.offset);
  }
  if (!uuidPattern.test(scope.generation ?? "")) {
    // A tenant that never built an index has no results yet.
    return json(response, 200, { items: [], nextCursor: null });
  }
  return scanSearchPage(request, response, identity, config, q, limit, scope, 0);
}

async function scanSearchPage(request, response, identity, config, q, limit, scope, scanFrom) {
  const generation = scope.generation;
  const meili = createMeilisearch(config);
  const index = searchIndexUid(identity.tenantId, generation);
  const found = [];
  while (found.length <= limit && scanFrom < maxTotalHits) {
    const size = Math.min(batchSize, maxTotalHits - scanFrom);
    const { hits } = await meili.search(index, q, size, scanFrom);
    if (!hits.length) break;
    const candidates = [];
    for (let position = 0; position < hits.length; position++) {
      const candidate = candidateOf(hits[position], position);
      if (candidate) candidates.push(candidate);
    }
    if (!candidates.length) { scanFrom += hits.length; continue; }
    const { value } = await searchRpc(config, identity, "acl", { candidates });
    const visible = new Map((Array.isArray(value.items) ? value.items : [])
      .filter(entry => entry && entry.item).map(entry => [entry.position, entry.item]));
    for (let position = 0; position < hits.length; position++) {
      if (!visible.has(position)) continue;
      found.push({ hit: hits[position], index: scanFrom + position });
      if (found.length > limit) break;
    }
    if (found.length > limit) break;
    scanFrom += hits.length;
    if (hits.length < size) break;
  }
  const items = found.slice(0, limit).map(({ hit }) => itemOf(hit));
  const nextCursor = found.length > limit
    ? encodeSearchCursor(q, identity, scope, generation, found[limit].index, config.dataSecret) : null;
  return json(response, 200, { items, nextCursor });
}

async function fetchObjectBytes(config, tenantId, value) {
  try {
    const response = await fetch(`${config.objectsUrl}/junctura-app/${tenantId}/${value.ownerAppId}/${value.id}/${value.version}`,
      { signal: AbortSignal.timeout(10_000), redirect: "error" });
    // A missing published version has no text to index; any other answer is a
    // temporary upstream problem and keeps the job queued.
    return response.status === 404 ? null : response.ok ? Buffer.from(await response.arrayBuffer()) : false;
  } catch { return false; }
}

function numberField(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

const fieldText = (value) =>
  typeof value === "string" && value.isWellFormed() ? value :
  typeof value === "number" && Number.isFinite(value) ? String(value) : null;

// Records render one document per projection: the full projection carries
// every searchable field for owner and share readers, while the management
// projection keeps sensitive fields out for grant-based readers. Objects
// contribute extracted text from clean published bytes.
function renderRecord(value, generation) {
  const version = numberField(value.version);
  const revision = numberField(value.schemaRevision);
  if (typeof value.id !== "string" || !uuidPattern.test(value.id) ||
      typeof value.incarnation !== "string" || !uuidPattern.test(value.incarnation) ||
      version === null || revision === null || typeof value.ownerAppId !== "string" ||
      !uuidPattern.test(value.ownerAppId) || typeof value.collection !== "string" ||
      !Array.isArray(value.searchable) || typeof value.data !== "object" || value.data === null) {
    throw new HttpError(503, "search_unavailable");
  }
  const sensitive = new Set(Array.isArray(value.sensitive) ? value.sensitive : []);
  const chunks = includeSensitive => {
    const lines = [];
    for (const field of value.searchable) {
      if (!includeSensitive && sensitive.has(field)) continue;
      const text = fieldText(value.data?.[field]);
      if (text !== null) lines.push(text);
    }
    return lines.join("\n").slice(0, maxTextLength);
  };
  const documents = [];
  const base = { kind: "record", resourceId: value.id, ownerAppId: value.ownerAppId,
    collection: value.collection, incarnation: value.incarnation, version, schemaRevision: revision, generation };
  const full = chunks(true);
  if (full) documents.push({ ...base, id: `record-${value.id}-${value.incarnation}-v${version}-r${revision}-full`,
    projection: "full", text: full });
  const managed = chunks(false);
  if (managed) documents.push({ ...base, id: `record-${value.id}-${value.incarnation}-v${version}-r${revision}-management`,
    projection: "management", text: managed });
  return documents;
}

function renderObject(value, generation) {
  if (typeof value?.id !== "string" || !uuidPattern.test(value.id) ||
      typeof value.version !== "string" || !uuidPattern.test(value.version) ||
      typeof value.ownerAppId !== "string" || !uuidPattern.test(value.ownerAppId)) {
    throw new HttpError(503, "search_unavailable");
  }
  return { id: `object-${value.id}-v${value.version}`, kind: "object", resourceId: value.id,
    ownerAppId: value.ownerAppId, version: value.version, projection: "full", generation };
}

// Superseded documents are cleaned by their immutable ids, never by an
// inequality filter over the resource: the deletion re-checks the row and the
// lease right before it runs, so a worker whose data or lease went stale stops
// instead of deleting a document a newer render just wrote.
async function purgeSuperseded(config, meili, tenantId, job, generation, lease, rendered, currentIds) {
  const key = value => JSON.stringify(value === null ? null : job.kind === "record"
    ? { version: value.version, incarnation: value.incarnation, schemaRevision: value.schemaRevision }
    : { version: value.version });
  const current = (await workerRpc(config, tenantId, "document", { kind: job.kind, id: job.id, lease })) ?? null;
  if (key(current) !== key(rendered)) return; // A newer render owns this resource now.
  const index = searchIndexUid(tenantId, generation);
  const listed = await meili.documents(index, `kind = "${job.kind}" AND resourceId = "${job.id}"`);
  const stale = listed.map(document => document?.id)
    .filter(id => typeof id === "string" && !currentIds.includes(id));
  if (stale.length) await meili.purgeIds(index, stale);
}

// Every write is confirmed through the task queue, and each rendered resource
// drops exactly its superseded documents: other versions, revisions or
// incarnations of the same resource cannot survive the current render, while a
// version published after this render keeps its documents untouched.
async function indexRecord(config, meili, tenantId, job, generation, lease) {
  const value = (await workerRpc(config, tenantId, "document", { kind: "record", id: job.id, lease })) ?? null;
  if (!value || typeof value !== "object") {
    await purgeSuperseded(config, meili, tenantId, job, generation, lease, null, []);
    return;
  }
  const documents = renderRecord(value, generation);
  if (!documents.length) {
    await purgeSuperseded(config, meili, tenantId, job, generation, lease, value, []);
    return;
  }
  const index = searchIndexUid(tenantId, generation);
  for (const document of documents) await meili.upsert(index, document);
  await purgeSuperseded(config, meili, tenantId, job, generation, lease, value, documents.map(({ id }) => id));
}

async function indexObject(config, meili, tenantId, job, generation, lease) {
  const value = (await workerRpc(config, tenantId, "document", { kind: "object", id: job.id, lease })) ?? null;
  if (!value || typeof value !== "object") {
    await purgeSuperseded(config, meili, tenantId, job, generation, lease, null, []);
    return;
  }
  const document = renderObject(value, generation);
  const bytes = await fetchObjectBytes(config, tenantId, value);
  if (bytes === false) {
    throw new HttpError(503, "search_unavailable");
  }
  const text = bytes ? extractText(bytes) : null;
  if (!text) {
    await purgeSuperseded(config, meili, tenantId, job, generation, lease, value, []);
    return;
  }
  await meili.upsert(searchIndexUid(tenantId, generation), { ...document, text: text.slice(0, maxTextLength) });
  await purgeSuperseded(config, meili, tenantId, job, generation, lease, value, [document.id]);
}

// One worker drains a tenant at a time: every queue mutation re-checks the
// lease in PostgreSQL, so a replica that lost its lease stops before it
// confirms a job and a fenced write cannot overwrite a newer document.
// Tenants that never built an index, tenants flagged after a restore and
// workers resuming an interrupted rebuild rebuild from PostgreSQL first and
// retire the old generation afterwards.
export async function drainTenant(config, meili, tenantId) {
  const lease = randomUUID();
  const fenced = async (operation, payload = {}) => workerRpc(config, tenantId, operation, { ...payload, lease });
  const state = await fenced("acquire").catch(error => {
    if (error instanceof HttpError && error.status === 409) return false; throw error;
  });
  if (!state || typeof state !== "object" ||
      (state.generation !== null && !uuidPattern.test(state.generation ?? ""))) return false;
  // A crashed rebuild keeps its building generation: resume it instead of
  // re-enqueueing the whole tenant again.
  let building = state.building_generation ?? null;
  try {
    if (uuidPattern.test(state.retired_generation ?? "")) {
      await meili.dropIndex(searchIndexUid(tenantId, state.retired_generation));
      await fenced("retire", { generation: state.retired_generation });
    }
    if (state.rebuild_requested === true || (state.generation === null && building === null)) {
      building = (await fenced("prepare"))?.building_generation ?? null;
    }
    if (building === null && !uuidPattern.test(state.generation ?? "")) return true;
    const tag = building ?? state.generation;
    for (;;) {
      const jobs = await fenced("jobs");
      if (!Array.isArray(jobs) || !jobs.length) {
        if (!building) break;
        const finished = await fenced("finish");
        if (!finished || typeof finished !== "object") continue;
        building = null;
        if (uuidPattern.test(finished.retired_generation ?? "")) {
          await meili.dropIndex(searchIndexUid(tenantId, finished.retired_generation));
          await fenced("retire", { generation: finished.retired_generation });
        }
        break;
      }
      const newest = new Map();
      for (const job of jobs) {
        if (typeof job?.jobId !== "string" || !/^[0-9]+$/.test(job.jobId) ||
            (job.kind !== "record" && job.kind !== "object") ||
            typeof job.id !== "string" || !uuidPattern.test(job.id)) continue;
        const key = `${job.kind}:${job.id}`;
        if (!newest.has(key) || BigInt(newest.get(key).jobId) < BigInt(job.jobId)) newest.set(key, job);
      }
      if (!newest.size) break; // A malformed queue answer retries on the next pass.
      // Collapsed duplicates of the same resource follow their newest job;
      // unclaimed rows stay queued for the next pass.
      const entries = [...newest.values()];
      for (let start = 0; start < entries.length; start += confirmGroup) {
        const done = [];
        const retry = [];
        for (const job of entries.slice(start, start + confirmGroup)) {
          const key = `${job.kind}:${job.id}`;
          let confirmed = false;
          try {
            if (job.kind === "record") await indexRecord(config, meili, tenantId, job, tag, lease);
            else await indexObject(config, meili, tenantId, job, tag, lease);
            confirmed = true;
          } catch { /* Keep the job queued; the next pass retries it. */ }
          for (const item of jobs) {
            if (`${item.kind}:${item.id}` === key) (confirmed ? done : retry).push(item.jobId);
          }
        }
        // The confirmation is fenced: a lost lease ends this drain here.
        await fenced("drop", { jobIds: done, retryJobIds: retry });
        await fenced("renew");
      }
    }
    return true;
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
    if (stopped) return;
    const tenants = await workerRpc(config, undefined, "tenants", {});
    if (!Array.isArray(tenants)) return;
    for (const tenantId of tenants) {
      if (stopped) return;
      if (typeof tenantId !== "string" || !/^[a-z][a-z0-9-]{0,62}$/.test(tenantId)) continue;
      try { await drainTenant(config, meili, tenantId); }
      catch { /* The lease expires and the next pass retries the tenant. */ }
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
