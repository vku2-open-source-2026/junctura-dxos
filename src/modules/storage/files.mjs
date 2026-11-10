// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Directory listing and field-shape views for management principals. Both are
// strictly read-only: bytes, record values, object keys and internal filer paths
// never cross this boundary.
import { HttpError, json, uuidPattern } from "../../platform/http/http.mjs";
import {
  maskFileName,
  extensionOf,
  encodeStoragePath,
  isObjectKeyName,
  isSafeEntryName,
  normalizeStoragePath,
} from "./file-names.mjs";
import { entryName, isDirectory, listDirectory, timestamp } from "./filer.mjs";
import { storageRpc } from "./rpc.mjs";

const fieldTypes = new Set(["string", "number", "boolean", "object", "array", "mixed", "null"]);
const controlPattern = /[\u0000-\u001f\u007f]/u;
const maxFolderDepth = 5;

function queryValues(url) {
  const values = new Map();
  for (const [key, value] of url.searchParams) {
    if (!values.has(key)) values.set(key, []);
    values.get(key).push(value);
  }
  return values;
}

function onlyQuery(url, allowed) {
  const values = queryValues(url);
  for (const [key, list] of values) {
    if (!allowed.includes(key) || list.length !== 1) throw new HttpError(400, "invalid_query");
  }
  return values;
}

function requireGet(request, response) {
  if (request.method === "GET") return;
  response.setHeader("Allow", "GET");
  throw new HttpError(405, "method_not_allowed");
}

function applicationNameFromSummary(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.applications)) {
    throw new HttpError(503, "storage_unavailable");
  }
  return value.applications;
}

async function findApplication(config, identity, appId) {
  const result = await storageRpc(config, identity, "junctura_storage_api", "storage_summary", {});
  if (result?.status !== 200) throw new HttpError(503, "storage_unavailable");
  const applications = applicationNameFromSummary(result.value);
  const match = applications.find((app) => app && app.id === appId &&
    typeof app.name === "string" && app.name.length >= 1 && app.name.length <= 200 &&
    !controlPattern.test(app.name));
  if (!match) throw new HttpError(404, "application_not_found");
  return { id: match.id, name: match.name };
}

function scanStatus(path) {
  if (path.startsWith("/junctura-quarantine/")) return "quarantined";
  if (path.startsWith("/junctura-app/")) return "clean";
  return "unknown";
}

async function folderSummary(config, path, request, depth) {
  const { entries } = await listDirectory(config, path, request);
  let files = 0;
  let bytes = 0;
  let updatedAt = null;
  for (const entry of entries) {
    const name = entryName(entry);
    if (!isSafeEntryName(name) || isObjectKeyName(name)) continue;
    if (isDirectory(entry)) {
      if (depth >= maxFolderDepth) continue;
      const nested = await folderSummary(config, `${path}/${encodeURIComponent(name)}`, request, depth + 1);
      files += nested.files;
      bytes += nested.bytes;
      if (nested.updatedAt && (!updatedAt || nested.updatedAt > updatedAt)) updatedAt = nested.updatedAt;
      continue;
    }
    files++;
    if (Number.isFinite(entry.FileSize) && entry.FileSize > 0) bytes += entry.FileSize;
    const mtime = timestamp(entry.Mtime);
    if (mtime && (!updatedAt || mtime > updatedAt)) updatedAt = mtime;
  }
  return { files, bytes, updatedAt };
}

export async function handleStorageFiles(request, response, identity, config, url, deps = {}) {
  requireGet(request, response);
  if (!identity.clientId) throw new HttpError(403, "verified_client_required");
  const values = onlyQuery(url, ["application", "path"]);
  const appId = values.get("application")?.[0];
  if (!appId || !uuidPattern.test(appId)) throw new HttpError(400, "invalid_query");
  const rawPath = values.get("path")?.[0] ?? "";
  const path = normalizeStoragePath(rawPath);
  if (path === null) throw new HttpError(400, "invalid_path");
  if (!config.objectsUrl) throw new HttpError(503, "storage_unavailable");
  const application = await findApplication(config, identity, appId);
  const requestImpl = deps.request ?? fetch;
  const base = `/junctura-app/${identity.tenantId}/${appId}`;
  const target = path ? `${base}/${encodeStoragePath(path)}` : base;
  const { entries, truncated } = await listDirectory(config, target, requestImpl);
  const folders = [];
  const files = [];
  for (const entry of entries) {
    const name = entryName(entry);
    if (!isSafeEntryName(name) || isObjectKeyName(name)) continue;
    if (isDirectory(entry)) {
      const summary = await folderSummary(config, `${target}/${encodeURIComponent(name)}`, requestImpl, 1);
      folders.push({ name, files: summary.files, bytes: summary.bytes, updatedAt: summary.updatedAt });
      continue;
    }
    files.push({
      name: maskFileName(name),
      extension: extensionOf(name),
      bytes: Number.isFinite(entry.FileSize) && entry.FileSize > 0 ? entry.FileSize : 0,
      status: scanStatus(target),
      updatedAt: timestamp(entry.Mtime),
    });
  }
  folders.sort((left, right) => left.name.localeCompare(right.name, "vi"));
  files.sort((left, right) => left.name.localeCompare(right.name, "vi"));
  response.setHeader("Cache-Control", "no-store");
  return json(response, 200, {
    application,
    path: path ? `/${path}` : "/",
    folders,
    files,
    truncated,
  });
}

function validField(field) {
  return field && typeof field === "object" &&
    typeof field.name === "string" && field.name.length >= 1 && field.name.length <= 128 &&
    !controlPattern.test(field.name) &&
    fieldTypes.has(field.type) &&
    Number.isInteger(field.fillRate) && field.fillRate >= 0 && field.fillRate <= 100;
}

function validCollection(collection) {
  return collection && typeof collection === "object" &&
    typeof collection.name === "string" && /^[a-z][a-z0-9_-]{0,62}$/.test(collection.name) &&
    Number.isSafeInteger(collection.records) && collection.records >= 0 &&
    (collection.updatedAt === null || timestamp(collection.updatedAt) !== null) &&
    Array.isArray(collection.fields) && collection.fields.every(validField);
}

function validCollections(value) {
  return value && typeof value === "object" &&
    value.application && typeof value.application === "object" &&
    typeof value.application.id === "string" && uuidPattern.test(value.application.id) &&
    typeof value.application.name === "string" && value.application.name.length >= 1 && value.application.name.length <= 200 &&
    Array.isArray(value.collections) && value.collections.every(validCollection);
}

function normaliseCollections(value) {
  return {
    application: { id: value.application.id, name: value.application.name },
    collections: value.collections.map((collection) => ({
      name: collection.name,
      records: collection.records,
      updatedAt: timestamp(collection.updatedAt),
      fields: collection.fields.map((field) => ({
        name: field.name,
        type: field.type,
        fillRate: field.fillRate,
      })),
    })),
  };
}

export async function handleStorageCollections(request, response, identity, config, url) {
  requireGet(request, response);
  if (!identity.clientId) throw new HttpError(403, "verified_client_required");
  const values = onlyQuery(url, ["application"]);
  const appId = values.get("application")?.[0];
  if (!appId || !uuidPattern.test(appId)) throw new HttpError(400, "invalid_query");
  const result = await storageRpc(config, identity, "junctura_storage_collections_api",
    "storage_collections", { application: appId });
  if (result?.status !== 200 || !validCollections(result.value)) {
    throw new HttpError(503, "storage_unavailable");
  }
  response.setHeader("Cache-Control", "no-store");
  return json(response, 200, normaliseCollections(result.value));
}
