// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { HttpError, json, jsonObject, logicalRequestDigest, parseRecordJson, readBody, uuidPattern } from "../../../platform/http/http.mjs";
import { applicationToken } from "../../applications/applications.mjs";
import { presentRecordRequest } from "../records.mjs";

const collectionPattern = /^[a-z][a-z0-9_-]{0,62}$/;
const maxImportBytes = 10 * 1024 * 1024;
const maxExportBytes = 64 * 1024 * 1024;

async function archiveCommand(config, identity, operation, payload) {
  if (!identity.clientId) throw new HttpError(403, "verified_client_required");
  if (!config.dataUrl) throw new HttpError(503, "data_unavailable");
  let upstream;
  try {
    upstream = await fetch(`${config.dataUrl}/rpc/record_archive`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${applicationToken(identity, config.dataSecret, "junctura_record_api")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ operation, payload }),
      signal: AbortSignal.timeout(30000),
      redirect: "error",
    });
    if (!upstream.ok) throw new Error();
    const result = await upstream.json();
    if (!Number.isInteger(result?.status) || result.status < 200 || result.status > 499) throw new Error();
    return result;
  } catch {
    throw new HttpError(503, "data_unavailable");
  }
}

function resultValue(result) {
  if (result.error) throw new HttpError(result.status, result.error, result.details);
  return result.value;
}

function waitForDrain(response, isClosed) {
  if (isClosed() || response.destroyed) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => {
      response.off("drain", done);
      response.off("close", done);
      response.off("error", done);
      resolve();
    };
    response.on("drain", done);
    response.on("close", done);
    response.on("error", done);
  });
}

async function endSnapshot(config, identity, snapshotId) {
  try { await archiveCommand(config, identity, "export_end", { snapshotId }); }
  catch { /* The snapshot expires on its own. */ }
}

async function exportRecords(request, response, identity, config, url) {
  const keys = [...url.searchParams.keys()];
  if (keys.some(key => key !== "collection") || url.searchParams.getAll("collection").length > 1) {
    throw new HttpError(400, "invalid_query");
  }
  const collection = url.searchParams.get("collection");
  if (collection !== null && !collectionPattern.test(collection)) throw new HttpError(400, "invalid_query");
  let closed = false;
  const markClosed = () => { closed = true; };
  request.once("aborted", markClosed);
  response.once("close", markClosed);
  response.once("error", markClosed);
  const started = resultValue(await archiveCommand(config, identity, "export_start",
    collection === null ? {} : { collection }));
  const snapshotId = started.snapshotId;
  let page;
  try {
    page = resultValue(await archiveCommand(config, identity, "export_page", { snapshotId }));
  } catch (error) {
    await endSnapshot(config, identity, snapshotId);
    throw error;
  }
  if (closed || response.destroyed) {
    await endSnapshot(config, identity, snapshotId);
    return;
  }
  response.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  let written = 0;
  let released = false;
  try {
    for (;;) {
      for (const line of page.lines) {
        if (closed || response.destroyed) break;
        const text = `${JSON.stringify({ collection: line.collection, id: line.id, data: line.data })}\n`;
        written += Buffer.byteLength(text);
        if (written > maxExportBytes) {
          closed = true;
          response.destroy();
          break;
        }
        if (!response.write(text)) await waitForDrain(response, () => closed || response.destroyed);
      }
      if (closed || response.destroyed) break;
      if (page.nextAfter === null || page.nextAfter === undefined) break;
      page = resultValue(await archiveCommand(config, identity, "export_page", {
        snapshotId,
        afterCollection: page.nextAfter.collection,
        afterId: page.nextAfter.id,
      }));
    }
    if (!closed && !response.destroyed) {
      resultValue(await archiveCommand(config, identity, "export_end", { snapshotId, completed: true }));
      released = true;
      response.end();
    }
  } finally {
    if (!released) await endSnapshot(config, identity, snapshotId);
  }
}

const importIssue = (line, keyword) => new HttpError(400, "invalid_request", {
  issues: [{ path: "", keyword, line }],
});

export function parseImport(source) {
  if (source === "") throw importIssue(1, "type");
  if (source.includes("\r")) throw importIssue(source.slice(0, source.indexOf("\r")).split("\n").length, "type");
  const text = source.endsWith("\n") ? source.slice(0, -1) : source;
  if (text === "") throw importIssue(1, "type");
  const lines = text.split("\n");
  const records = [];
  for (const [index, line] of lines.entries()) {
    if (line === "") throw importIssue(index + 1, "type");
    let item;
    try { item = parseRecordJson(line); }
    catch { throw importIssue(index + 1, "type"); }
    if (!jsonObject(item) || Object.keys(item).length !== 3 ||
        !Object.hasOwn(item, "collection") || !Object.hasOwn(item, "id") || !Object.hasOwn(item, "data") ||
        typeof item.collection !== "string" || !collectionPattern.test(item.collection) ||
        typeof item.id !== "string" || !uuidPattern.test(item.id) || !jsonObject(item.data)) {
      throw importIssue(index + 1, "properties");
    }
    records.push(item);
  }
  return records;
}

async function importRecords(request, response, identity, config, url) {
  if (url.search) throw new HttpError(400, "invalid_query");
  if (request.headers["content-type"]?.split(";", 1)[0].trim() !== "application/x-ndjson") {
    throw new HttpError(415, "unsupported_media_type");
  }
  const requestKey = request.headers["idempotency-key"];
  if (typeof requestKey !== "string" || !uuidPattern.test(requestKey)) throw new HttpError(400, "invalid_request");
  const bytes = await readBody(request, maxImportBytes);
  let source;
  try { source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new HttpError(400, "invalid_request"); }
  const records = parseImport(source);
  const value = resultValue(await archiveCommand(config, identity, "import", {
    records,
    requestKey,
    digest: logicalRequestDigest({ body: records }),
    path: url.pathname,
    method: request.method,
  }));
  return json(response, 200, value);
}

export async function handleRecordArchive(request, response, identity, config, url) {
  return presentRecordRequest(request, response, async () => {
    if (url.pathname === "/v2/data:export") {
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        throw new HttpError(405, "method_not_allowed");
      }
      return exportRecords(request, response, identity, config, url);
    }
    if (url.pathname === "/v2/data:import") {
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        throw new HttpError(405, "method_not_allowed");
      }
      return importRecords(request, response, identity, config, url);
    }
    throw new HttpError(404, "not_found");
  });
}
