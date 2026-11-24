// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { HttpError, json } from "../../../platform/http/http.mjs";
import { applicationToken } from "../../applications/applications.mjs";
import { presentRecordRequest } from "../records.mjs";
import { canonicalWhere, parseAggregateQuery, parseListQuery } from "./query.mjs";
import { createQueryCursor } from "./cursor.mjs";

async function queryCommand(config, identity, operation, payload) {
  if (!identity.clientId) throw new HttpError(403, "verified_client_required");
  if (!config.dataUrl) throw new HttpError(503, "data_unavailable");
  let upstream;
  try {
    upstream = await fetch(`${config.dataUrl}/rpc/record_query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${applicationToken(identity, config.dataSecret, "junctura_record_api")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ operation, payload }),
      signal: AbortSignal.timeout(5000),
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

async function metadata(config, identity, collection, ownerAppId) {
  const payload = { collection };
  if (ownerAppId !== null) payload.ownerAppId = ownerAppId;
  return resultValue(await queryCommand(config, identity, "describe", payload));
}

export async function handleRecordQuery(request, response, identity, config, url) {
  return presentRecordRequest(request, response, async () => {
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      throw new HttpError(405, "method_not_allowed");
    }
    const aggregatePath = url.pathname.match(/^\/v2\/data\/([a-z][a-z0-9_-]{0,62})\/aggregate$/);
    if (aggregatePath) {
      const collection = aggregatePath[1];
      const ownerAppId = url.searchParams.get("ownerAppId");
      const details = await metadata(config, identity, collection, ownerAppId);
      const query = parseAggregateQuery(url.searchParams, {
        indexed: details.indexed, sensitive: details.sensitive, types: details.types, management: details.management,
      });
      const value = resultValue(await queryCommand(config, identity, "aggregate", {
        collection,
        ownerAppId: details.ownerAppId,
        filters: canonicalWhere(query.where),
        groupBy: query.groupBy,
      }));
      return json(response, 200, value);
    }
    const listPath = url.pathname.match(/^\/v2\/data\/([a-z][a-z0-9_-]{0,62})$/);
    if (!listPath) throw new HttpError(404, "not_found");
    const collection = listPath[1];
    const ownerAppId = url.searchParams.get("ownerAppId");
    const details = await metadata(config, identity, collection, ownerAppId);
    const query = parseListQuery(url.searchParams, {
      indexed: details.indexed, sensitive: details.sensitive, types: details.types, management: details.management,
    });
    const where = canonicalWhere(query.where);
    const sort = query.sort ? `data.${query.sort.field}.${query.sort.direction}` : `system.created_at.${query.order}`;
    const binding = { ownerAppId: details.ownerAppId, where, sort, schemaRevision: details.schemaRevision };
    let cursorId;
    if (query.cursor !== null) {
      const cursor = createQueryCursor(config.dataSecret);
      cursorId = cursor.decodeState(query.cursor, binding).stateId;
    }
    const value = resultValue(await queryCommand(config, identity, "list", {
      collection,
      ownerAppId: details.ownerAppId,
      limit: query.limit,
      order: query.order,
      sort: query.sort,
      filters: where,
      ...(cursorId === undefined ? {} : { cursorId }),
    }));
    const nextCursor = value.nextCursorId === null || value.nextCursorId === undefined
      ? null
      : createQueryCursor(config.dataSecret).encodeState({
        ...binding,
        schemaRevision: Number.isSafeInteger(value.schemaRevision) ? value.schemaRevision : details.schemaRevision,
      }, value.nextCursorId);
    return json(response, 200, { items: value.items, nextCursor });
  });
}
