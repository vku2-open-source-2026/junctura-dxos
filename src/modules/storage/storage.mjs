// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Read-only storage overview for management principals. The database returns
// aggregate record counts only; object bytes and filer metadata stay private
// and are reduced to counts, sizes and timestamps. No record content, object
// key, object name or file name is ever returned by the summary.
import { HttpError, json } from "../../platform/http/http.mjs";
import { aggregateDirectory, aggregateObjects } from "./filer.mjs";
import { handleStorageCollections, handleStorageFiles } from "./files.mjs";
import { storageRpc } from "./rpc.mjs";

export const STORAGE_SUMMARY_PATH = "/v1/storage/summary";
export const STORAGE_FILES_PATH = "/v1/storage/files";
export const STORAGE_COLLECTIONS_PATH = "/v1/storage/collections";

const collectionPattern = /^[a-z][a-z0-9_-]{0,62}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const states = new Set(["pending", "active", "suspended", "revoked"]);

function timestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

function validCollection(value) {
  return value && typeof value === "object" && typeof value.name === "string" &&
    collectionPattern.test(value.name) && Number.isSafeInteger(value.records) && value.records >= 0 &&
    (value.updatedAt === null || timestamp(value.updatedAt) !== null);
}

function validSummary(value) {
  return value && typeof value === "object" && Array.isArray(value.applications) &&
    value.applications.every((app) => app && typeof app === "object" &&
      typeof app.id === "string" && uuidPattern.test(app.id) &&
      typeof app.name === "string" && app.name.length >= 1 && app.name.length <= 200 &&
      !/[\u0000-\u001f\u007f]/u.test(app.name) && states.has(app.state) &&
      Array.isArray(app.collections) && app.collections.every(validCollection)) &&
    value.totals && typeof value.totals === "object" &&
    Array.isArray(value.totals.collections) && value.totals.collections.every(validCollection);
}

function normaliseSummary(value) {
  const collections = (items) => items.map((item) => ({
    name: item.name,
    records: item.records,
    updatedAt: timestamp(item.updatedAt),
  }));
  return {
    applications: value.applications.map((app) => ({
      id: app.id,
      name: app.name,
      state: app.state,
      collections: collections(app.collections),
    })),
    totals: { collections: collections(value.totals.collections) },
  };
}

async function readSummary(config, identity) {
  const result = await storageRpc(config, identity, "junctura_storage_api", "storage_summary", {});
  if (result?.status !== 200 || !validSummary(result.value)) throw new HttpError(503, "storage_unavailable");
  return normaliseSummary(result.value);
}

async function handleStorageSummary(request, response, identity, config, url, deps = {}) {
  if (url.search) throw new HttpError(400, "invalid_query");
  if (!config.dataUrl) throw new HttpError(503, "storage_unavailable");
  if (!identity.clientId) throw new HttpError(403, "verified_client_required");
  const summary = await readSummary(config, identity);
  const requestImpl = deps.request ?? fetch;
  if (!config.objectsUrl) {
    for (const application of summary.applications) application.files = null;
    summary.totals.files = null;
  } else {
    let totalCount = 0;
    let totalBytes = 0;
    let totalUpdatedAt = null;
    for (const application of summary.applications) {
      const files = await aggregateObjects(config, `/junctura-app/${identity.tenantId}/${application.id}`, requestImpl);
      application.files = { count: files.count, bytes: files.bytes, quarantined: 0, updatedAt: files.updatedAt };
      totalCount += files.count;
      totalBytes += files.bytes;
      if (files.updatedAt && (!totalUpdatedAt || files.updatedAt > totalUpdatedAt)) totalUpdatedAt = files.updatedAt;
    }
    const legacy = await aggregateDirectory(config, `/junctura/${identity.tenantId}`, requestImpl);
    const quarantine = await aggregateObjects(config, `/junctura-quarantine/${identity.tenantId}`, requestImpl);
    totalCount += legacy.count;
    totalBytes += legacy.bytes;
    if (legacy.updatedAt && (!totalUpdatedAt || legacy.updatedAt > totalUpdatedAt)) totalUpdatedAt = legacy.updatedAt;
    summary.totals.files = {
      count: totalCount,
      bytes: totalBytes,
      quarantined: quarantine.count,
      updatedAt: totalUpdatedAt,
    };
  }
  response.setHeader("Cache-Control", "no-store");
  return json(response, 200, summary);
}

export function isStoragePath(path) {
  return path === STORAGE_SUMMARY_PATH || path === STORAGE_FILES_PATH || path === STORAGE_COLLECTIONS_PATH;
}

export async function handleStorage(request, response, identity, config, url, deps = {}) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    throw new HttpError(405, "method_not_allowed");
  }
  if (url.pathname === STORAGE_SUMMARY_PATH) return handleStorageSummary(request, response, identity, config, url, deps);
  if (url.pathname === STORAGE_FILES_PATH) return handleStorageFiles(request, response, identity, config, url, deps);
  if (url.pathname === STORAGE_COLLECTIONS_PATH) return handleStorageCollections(request, response, identity, config, url);
  throw new HttpError(404, "not_found");
}
