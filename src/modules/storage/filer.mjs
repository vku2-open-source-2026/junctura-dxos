// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Read-only helpers over SeaweedFS filer metadata. They never fetch object bytes:
// only directory listings, names, sizes and timestamps are reduced.
import { HttpError } from "../../platform/http/http.mjs";

const directoryBit = 0x80000000;
const pageLimit = 1000;
const maxPages = 50;
const maxDepth = 5;

export function timestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

export function isDirectory(entry) {
  return Number.isInteger(entry?.Mode) && (entry.Mode & directoryBit) !== 0;
}

export function entryName(entry) {
  if (typeof entry?.Name === "string" && entry.Name) return entry.Name;
  if (typeof entry?.FullPath === "string") return entry.FullPath.split("/").at(-1) ?? "";
  return "";
}

export async function listDirectory(config, path, request) {
  const entries = [];
  let truncated = false;
  let lastFileName = "";
  for (let page = 0; page < maxPages; page++) {
    const query = new URLSearchParams({ limit: String(pageLimit) });
    if (lastFileName) query.set("lastFileName", lastFileName);
    let response;
    try {
      response = await request(`${config.objectsUrl}${path}/?${query}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      });
    } catch { throw new HttpError(503, "storage_unavailable"); }
    if (response.status === 404) return { entries, truncated };
    if (!response.ok) throw new HttpError(503, "storage_unavailable");
    let body;
    try { body = await response.json(); } catch { throw new HttpError(503, "storage_unavailable"); }
    const batch = body?.Entries ?? [];
    if (!Array.isArray(batch)) throw new HttpError(503, "storage_unavailable");
    entries.push(...batch);
    if (body.ShouldDisplayLoadMore !== true) return { entries, truncated };
    lastFileName = typeof body.LastFileName === "string" ? body.LastFileName : "";
    if (!lastFileName) return { entries, truncated };
  }
  return { entries, truncated: true };
}

export async function aggregateDirectory(config, path, request, depth = 0) {
  const { entries } = await listDirectory(config, path, request);
  let count = 0;
  let bytes = 0;
  let updatedAt = null;
  for (const entry of entries) {
    if (isDirectory(entry)) {
      const name = entryName(entry);
      if (depth >= maxDepth || !name) continue;
      const nested = await aggregateDirectory(config, `${path}/${encodeURIComponent(name)}`, request, depth + 1);
      count += nested.count;
      bytes += nested.bytes;
      if (nested.updatedAt && (!updatedAt || nested.updatedAt > updatedAt)) updatedAt = nested.updatedAt;
      continue;
    }
    count++;
    if (Number.isFinite(entry.FileSize) && entry.FileSize > 0) bytes += entry.FileSize;
    const mtime = timestamp(entry.Mtime);
    if (mtime && (!updatedAt || mtime > updatedAt)) updatedAt = mtime;
  }
  return { count, bytes, updatedAt };
}

export async function aggregateObjects(config, path, request) {
  const { entries } = await listDirectory(config, path, request);
  let count = 0;
  let bytes = 0;
  let updatedAt = null;
  for (const entry of entries) {
    if (!isDirectory(entry)) {
      count++;
      if (Number.isFinite(entry.FileSize) && entry.FileSize > 0) bytes += entry.FileSize;
      const mtime = timestamp(entry.Mtime);
      if (mtime && (!updatedAt || mtime > updatedAt)) updatedAt = mtime;
      continue;
    }
    const name = entryName(entry);
    if (!name) continue;
    const { entries: versions } = await listDirectory(config, `${path}/${encodeURIComponent(name)}`, request);
    let latest = null;
    for (const version of versions) {
      if (isDirectory(version)) continue;
      const mtime = timestamp(version.Mtime);
      if (!latest || (mtime && (!latest.updatedAt || mtime > latest.updatedAt))) {
        latest = {
          bytes: Number.isFinite(version.FileSize) && version.FileSize > 0 ? version.FileSize : 0,
          updatedAt: mtime,
        };
      }
    }
    if (!latest) continue;
    count++;
    bytes += latest.bytes;
    if (latest.updatedAt && (!updatedAt || latest.updatedAt > updatedAt)) updatedAt = latest.updatedAt;
  }
  return { count, bytes, updatedAt };
}

export { maxDepth };
