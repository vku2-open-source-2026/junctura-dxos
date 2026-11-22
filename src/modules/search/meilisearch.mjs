// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Minimal Meilisearch HTTP adapter over Node fetch: no client library, one
// index per tenant with a fixed document key, and every write confirmed
// through the task queue before the caller continues.
import { HttpError } from "../../platform/http/http.mjs";

const indexUid = tenantId => `junctura-search-${tenantId}`;

export function createMeilisearch(config, fetcher = fetch) {
  if (!config.searchUrl || !config.searchKey) throw new HttpError(503, "search_unavailable");
  const ready = new Set();

  async function call(path, options = {}, deadline = 10_000) {
    let response;
    try {
      response = await fetcher(`${config.searchUrl}${path}`, {
        ...options,
        headers: { Authorization: `Bearer ${config.searchKey}`, "Content-Type": "application/json", ...options.headers },
        signal: AbortSignal.timeout(deadline),
        redirect: "error",
      });
    } catch { throw new HttpError(503, "search_unavailable"); }
    if (response.status >= 500) throw new HttpError(503, "search_unavailable");
    let value;
    try { value = await response.json(); }
    catch { throw new HttpError(503, "search_unavailable"); }
    return { status: response.status, value };
  }

  async function waitTask(taskUid) {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const { status, value } = await call(`/tasks/${taskUid}`, {}, 5000);
      if (status !== 200) throw new HttpError(503, "search_unavailable");
      if (value.status === "succeeded") return;
      if (value.status === "failed" || value.status === "canceled" || Date.now() > deadline) {
        throw new HttpError(503, "search_unavailable");
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  async function ensureIndex(tenantId) {
    if (ready.has(tenantId)) return;
    const uid = indexUid(tenantId);
    if ((await call(`/indexes/${uid}`, {}, 5000)).status === 404) {
      const created = await call("/indexes", { method: "POST", body: JSON.stringify({ uid, primaryKey: "id" }) });
      if (created.value.taskUid !== undefined) await waitTask(created.value.taskUid);
      const settings = await call(`/indexes/${uid}/settings`, {
        method: "PATCH", body: JSON.stringify({ searchableAttributes: ["text"] }),
      });
      if (settings.value.taskUid !== undefined) await waitTask(settings.value.taskUid);
    }
    ready.add(tenantId);
  }

  return {
    async search(tenantId, query, limit, offset) {
      const { status, value } = await call(`/indexes/${indexUid(tenantId)}/search`, {
        method: "POST", body: JSON.stringify({ q: query, limit, offset }),
      });
      if (status !== 200) throw new HttpError(503, "search_unavailable");
      return { hits: Array.isArray(value.hits) ? value.hits : [] };
    },
    async upsert(tenantId, document) {
      await ensureIndex(tenantId);
      const { value } = await call(`/indexes/${indexUid(tenantId)}/documents`, {
        method: "POST", body: JSON.stringify([document]),
      });
      if (value.taskUid !== undefined) await waitTask(value.taskUid);
    },
    async remove(tenantId, documentId) {
      await ensureIndex(tenantId);
      const { value } = await call(`/indexes/${indexUid(tenantId)}/documents/${encodeURIComponent(documentId)}`, {
        method: "DELETE",
      });
      if (value.taskUid !== undefined) await waitTask(value.taskUid);
    },
  };
}
