// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Minimal Meilisearch HTTP adapter over Node fetch: no client library, one
// index per tenant generation with a fixed document key, and every write
// confirmed through the task queue before the caller continues. A write
// response without a task id, a failed task or an unusable filter all count as
// an unavailable index so the durable queue keeps the job for a later retry.
import { HttpError } from "../../platform/http/http.mjs";

export const maxTotalHits = 10_000;
const indexSettings = {
  searchableAttributes: ["text"],
  filterableAttributes: ["kind", "resourceId", "incarnation", "version", "schemaRevision", "projection", "generation"],
  sortableAttributes: ["id"],
  rankingRules: ["words", "typo", "proximity", "attribute", "sort", "exactness"],
  pagination: { maxTotalHits },
};

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

  function taskUid(value) {
    if (typeof value?.taskUid !== "number") throw new HttpError(503, "search_unavailable");
    return value.taskUid;
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

  async function ensureIndex(indexUid) {
    if (ready.has(indexUid)) return;
    if ((await call(`/indexes/${indexUid}`, {}, 5000)).status !== 200) {
      await waitTask(taskUid((await call("/indexes", {
        method: "POST", body: JSON.stringify({ uid: indexUid, primaryKey: "id" }),
      })).value));
    }
    await waitTask(taskUid((await call(`/indexes/${indexUid}/settings`, {
      method: "PATCH", body: JSON.stringify(indexSettings),
    })).value));
    ready.add(indexUid);
  }

  // Index writes accept only an accepted task; the caller never drops a job
  // before its index task succeeded. A vanished index (a rebuilt instance) is
  // recreated once and the write retried.
  async function write(indexUid, path, options) {
    await ensureIndex(indexUid);
    let result = await call(`/indexes/${indexUid}${path}`, options);
    if (result.status === 404) {
      ready.delete(indexUid);
      await ensureIndex(indexUid);
      result = await call(`/indexes/${indexUid}${path}`, options);
    }
    if (result.status !== 202) throw new HttpError(503, "search_unavailable");
    return result;
  }

  return {
    async search(indexUid, query, limit, offset) {
      const { status, value } = await call(`/indexes/${indexUid}/search`, {
        method: "POST", body: JSON.stringify({ q: query, limit, offset, sort: ["id:asc"] }),
      });
      // A generation whose index was never built has no hits, not an outage.
      if (status === 404) return { hits: [] };
      if (status !== 200) throw new HttpError(503, "search_unavailable");
      return { hits: Array.isArray(value.hits) ? value.hits : [] };
    },
    // The superseded-document cleanup reads the immutable ids of the
    // documents a resource currently has in its generation index.
    async documents(indexUid, filter) {
      const { status, value } = await call(`/indexes/${indexUid}/search`, {
        method: "POST", body: JSON.stringify({ q: "", filter, limit: 200,
          attributesToRetrieve: ["id"], sort: ["id:asc"] }),
      });
      if (status === 404) return [];
      if (status !== 200) throw new HttpError(503, "search_unavailable");
      return Array.isArray(value.hits) ? value.hits : [];
    },
    async upsert(indexUid, document) {
      await waitTask(taskUid((await write(indexUid, "/documents", {
        method: "POST", body: JSON.stringify([document]),
      })).value));
    },
    async purge(indexUid, filter) {
      await waitTask(taskUid((await write(indexUid, "/documents/delete", {
        method: "POST", body: JSON.stringify({ filter }),
      })).value));
    },
    async purgeIds(indexUid, ids) {
      await waitTask(taskUid((await write(indexUid, "/documents/delete-batch", {
        method: "POST", body: JSON.stringify(ids),
      })).value));
    },
    async dropIndex(indexUid) {
      let result = await call(`/indexes/${indexUid}`, { method: "DELETE" }, 5000);
      // A retired generation whose index already vanished is done retiring.
      if (result.status === 404) return;
      if (result.status !== 202) throw new HttpError(503, "search_unavailable");
      await waitTask(taskUid(result.value));
    },
  };
}
