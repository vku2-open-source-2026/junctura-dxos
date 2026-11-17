// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { HttpError, json, readJson, requireWriter, uuidPattern } from "../../platform/http/http.mjs";
import { signInternalToken } from "../../platform/security/internal-token.mjs";
import { resourceRequest } from "../resources/resources.mjs";

export function dataToken(tenantId, secret) {
  return signInternalToken(secret, { role: "junctura_api", tenant_id: tenantId,
    aud: "junctura-data", exp: Math.floor(Date.now() / 1000) + 30 });
}

export async function dataRequest(config, tenantId, query, options = {}, resource = "records") {
  let response;
  try {
    response = await fetch(`${config.dataUrl}/${resource}?${query}`, {
      ...options,
      headers: { Authorization: `Bearer ${dataToken(tenantId, config.dataSecret)}`,
        "Content-Type": "application/json", Prefer: "return=representation" },
      signal: AbortSignal.timeout(5000), redirect: "error",
    });
  } catch { throw new HttpError(503, "data_unavailable"); }
  if (response.status === 409) throw new HttpError(409, "conflict");
  if (!response.ok) throw new HttpError(response.status === 400 ? 400 : 503, response.status === 400 ? "invalid_data" : "data_unavailable");
  return response.json();
}

function decodeCursor(value, order) {
  try {
    if (!value || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw Error();
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw Error();
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const cursor = JSON.parse(source);
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor) || Object.keys(cursor).length !== 3 ||
        !["t", "i", "o"].every(key => Object.hasOwn(cursor, key)) ||
        source.match(/"(?:[^"\\]|\\.)*"\s*:/g)?.length !== 3 ||
        typeof cursor.t !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(cursor.t) ||
        !Number.isFinite(Date.parse(cursor.t)) ||
        new Date(`${cursor.t.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== cursor.t.slice(0, 10) ||
        typeof cursor.i !== "string" || !uuidPattern.test(cursor.i) || cursor.o !== order) throw Error();
    return cursor;
  } catch { throw new HttpError(400, "invalid_cursor"); }
}

function cursorFilter({ t, i }, order) {
  const comparison = order === "asc" ? "gt" : "lt";
  // URLSearchParams encodes the quotes required by PostgREST for timestamp punctuation.
  return `(created_at.${comparison}."${t}",and(created_at.eq."${t}",id.${comparison}.${i}))`;
}

export async function handleData(request, response, identity, config, url) {
  const match = url.pathname.match(/^\/v[12]\/data\/([a-z][a-z0-9_-]{0,62})(?:\/([0-9a-f-]+))?$/);
  if (!match || (match[2] && !uuidPattern.test(match[2]))) throw new HttpError(400, "invalid_record_path");
  const [, collection, id] = match;
  const send = (query, options) => identity.appId
    ? resourceRequest(config, identity, "app_records", query, options)
    : dataRequest(config, identity.tenantId, query, options);
  const query = new URLSearchParams({ collection: `eq.${collection}`, select: "id,collection,data,created_at", order: "created_at.asc,id.asc" });
  if (id) query.set("id", `eq.${id}`);
  if (request.method === "GET") {
    const limit = url.searchParams.get("limit") ?? "100";
    const keys = [...url.searchParams.keys()];
    if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100 ||
        keys.some(key => !(id ? ["limit"] : ["limit", "order", "cursor"]).includes(key))) {
      throw new HttpError(400, "invalid_query");
    }
    if (id) {
      query.set("limit", "1");
      const rows = await send(query);
      if (!rows.length) throw new HttpError(404, "not_found");
      return json(response, 200, rows[0]);
    }
    const order = url.searchParams.get("order") ?? "asc";
    if (!["asc", "desc"].includes(order) || new Set(keys).size !== keys.length) throw new HttpError(400, "invalid_query");
    query.set("order", `created_at.${order},id.${order}`);
    query.set("limit", String(Number(limit) + 1));
    if (url.searchParams.has("cursor")) {
      query.set("or", cursorFilter(decodeCursor(url.searchParams.get("cursor"), order), order));
    }
    const rows = await send(query);
    const items = rows.slice(0, Number(limit));
    const last = items.at(-1);
    let hasMore = rows.length > Number(limit);
    // The configured PostgREST row cap is 100, so a full 100-row page needs a separate lookahead.
    if (!hasMore && items.length === 100) {
      query.set("limit", "1");
      query.set("or", cursorFilter({ t: last.created_at, i: last.id }, order));
      hasMore = (await send(query)).length > 0;
    }
    const nextCursor = hasMore
      ? Buffer.from(JSON.stringify({ t: last.created_at, i: last.id, o: order })).toString("base64url") : null;
    return json(response, 200, { items, nextCursor });
  }
  if ((request.method === "POST" && !id) || (request.method === "PATCH" && id)) {
    requireWriter(identity);
    if (url.search) throw new HttpError(400, "invalid_query");
    const body = await readJson(request);
    if (Object.keys(body).length !== 1 || !body.data || typeof body.data !== "object" || Array.isArray(body.data)) throw new HttpError(400, "data_object_required");
    const record = request.method === "POST" ? { id: randomUUID(), collection, data: body.data } : { data: body.data };
    const rows = await send(query, { method: request.method, body: JSON.stringify(record) });
    if (!rows.length) throw new HttpError(404, "not_found");
    return json(response, request.method === "POST" ? 201 : 200, rows[0]);
  }
  if (request.method === "DELETE" && id) {
    requireWriter(identity);
    if (url.search) throw new HttpError(400, "invalid_query");
    const rows = await send(query, { method: "DELETE" });
    if (!rows.length) throw new HttpError(404, "not_found");
    response.writeHead(204);
    return response.end();
  }
  response.setHeader("Allow", id ? "GET, PATCH, DELETE" : "GET, POST");
  throw new HttpError(405, "method_not_allowed");
}
