// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { HttpError, json, readCursorPage, readFlatJsonObject, requireWriter, uuidPattern } from "../../../platform/http/http.mjs";
import { validateApplicationBody } from "../../applications/applications.mjs";
import { trustRpc } from "./trust.mjs";

export const ACCESS_REQUESTS_PATH = "/v1/trust/access-requests";
const PATH = /^\/v1\/trust\/access-requests(?:\/([^/]+)(?:\/(withdraw|decline|accept))?)?$/;
const FILTERS = { direction: ["incoming", "outgoing"], state: ["pending", "withdrawn", "declined", "accepted"] };
const CAPABILITY_ID = /^urn:junctura:capability:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[a-z][a-z0-9-]{0,62}$/;
const VERSION = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;

export async function handleCapabilityAccessRequests(request, response, identity, config, url) {
  const match = PATH.exec(url.pathname);
  if (!match || (match[1] && !uuidPattern.test(match[1]))) throw new HttpError(400, "invalid_access_request_path");
  const [, requestId, action] = match;
  const operation = request.method === "GET" && !action ? (requestId ? "get" : "list")
    : request.method === "POST" ? (requestId ? action : "create") : undefined;
  if (!operation) throw new HttpError(405, "method_not_allowed");
  if (operation !== "list" && url.search) throw new HttpError(400, "invalid_query");
  if (identity.actor) throw new HttpError(403, "access_request_permission_required");
  if (request.method === "POST") requireWriter(identity);

  let payload = { requestId };
  if (operation === "list") {
    payload = readCursorPage(url.searchParams, "invalid_access_request_query", "invalid_access_request_cursor", FILTERS);
  } else if (operation === "create") {
    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || !uuidPattern.test(idempotencyKey)) {
      throw new HttpError(400, "uuid_idempotency_key_required");
    }
    const body = await readFlatJsonObject(request);
    const { capabilityId, version, purpose } = body;
    if (Object.keys(body).length !== 3 || typeof capabilityId !== "string" || !CAPABILITY_ID.test(capabilityId) ||
        typeof version !== "string" || !VERSION.test(version) || typeof purpose !== "string" ||
        !purpose.trim() || [...purpose].length > 512 || /[\u0000-\u001f\u007f]/u.test(purpose)) {
      throw new HttpError(400, "invalid_access_request");
    }
    payload = { capabilityId, version, purpose, idempotencyKey };
  } else if (operation === "decline") {
    const body = await readFlatJsonObject(request);
    validateApplicationBody(body, "approval_revoke");
    payload.reason = body.reason;
  } else if (action && (Number(request.headers["content-length"]) > 0 || request.headers["transfer-encoding"])) {
    if (Object.keys(await readFlatJsonObject(request)).length) throw new HttpError(400, "invalid_access_request");
  }

  const result = await trustRpc(config, identity, "capability_access_request_command", operation, payload);
  if (operation === "create") response.setHeader("Location", `${ACCESS_REQUESTS_PATH}/${result.value.requestId}`);
  response.setHeader("Cache-Control", "no-store");
  return json(response, result.status, result.value);
}
