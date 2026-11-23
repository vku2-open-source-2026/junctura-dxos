// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { randomBytes, randomUUID } from "node:crypto";
import { HttpError, json, jsonObject, readRecordJson, uuidPattern } from "../../platform/http/http.mjs";
import { bao } from "../secrets/secrets.mjs";
import { createApplicationProvider } from "./keycloak.mjs";

const unitPattern = /^[a-z][a-z0-9-]{1,63}$/;
const subjectPattern = /^[A-Za-z0-9:_-]{1,128}$/;
const states = ["pending", "active", "suspended", "revoked"];
const roles = ["viewer", "editor", "manager"];
const validText = (value, limit) => typeof value === "string" && value.trim() && value.isWellFormed() &&
  [...value].length <= limit && !/[\p{Cc}]/u.test(value);
const validUnit = value => typeof value === "string" && unitPattern.test(value);
const invalid = () => { throw new HttpError(400, "invalid_application_body"); };

export function parseAppList(url) {
  const query = url.searchParams;
  const keys = [...query.keys()];
  const limit = query.get("limit") ?? "50";
  const after = query.get("cursor");
  const state = query.get("state");
  const unit = query.get("unit");
  const q = query.get("q");
  if (keys.length !== new Set(keys).size || keys.some(key => !["limit", "cursor", "state", "unit", "q"].includes(key)) ||
      !/^(?:[1-9][0-9]?|100)$/.test(limit) || (after !== null && !uuidPattern.test(after)) ||
      (state !== null && !states.includes(state)) || (unit !== null && !validUnit(unit)) ||
      (q !== null && !validText(q, 120))) throw new HttpError(400, "invalid_query");
  return { limit: Number(limit), after: after ?? undefined, state: state ?? undefined,
    unit: unit ?? undefined, q: q ?? undefined };
}

export function validateAppMetadata(body) {
  const keys = Object.keys(body);
  if (!keys.length || keys.some(key => !["displayName", "ownerUnit", "deploymentUnits"].includes(key)) ||
      (Object.hasOwn(body, "displayName") && !validText(body.displayName, 120)) ||
      (body.ownerUnit !== undefined && body.ownerUnit !== null && !validUnit(body.ownerUnit)) ||
      (body.deploymentUnits !== undefined && (!Array.isArray(body.deploymentUnits) || body.deploymentUnits.length > 100 ||
        !body.deploymentUnits.every(validUnit) || new Set(body.deploymentUnits).size !== body.deploymentUnits.length))) invalid();
  return body;
}

export function validateAssignment(body) {
  if (Object.keys(body).length !== 4 || !validUnit(body.unit) || !roles.includes(body.role) ||
      typeof body.target !== "string" ||
      !(body.targetType === "unit" && body.target === body.unit ||
        body.targetType === "group" && unitPattern.test(body.target) ||
        body.targetType === "subject" && subjectPattern.test(body.target))) invalid();
  return body;
}

async function readObject(request) {
  const body = await readRecordJson(request, 16_384);
  if (!jsonObject(body)) invalid();
  return body;
}

export async function withProvider(config, command, appId, run) {
  const lease = randomUUID();
  const fenced = (operation, payload = {}) => command(operation, { appId, lease, ...payload });
  const renew = async () => (await fenced("lease")).value;
  const provider = createApplicationProvider(config, renew);
  if (!provider) throw new HttpError(503, "app_provider_unavailable");
  const target = await renew();
  try { return await run(fenced, provider, target.oauthClientId, target.providerReady); }
  catch (error) {
    if (error instanceof HttpError) throw error;
    if (error.message === "oidc_secret_unsupported") throw new HttpError(409, error.message);
    throw new HttpError(503, "app_provider_unavailable");
  } finally { await fenced("release").catch(() => {}); }
}

async function stageKey(config, tenant, appId, rotationId) {
  const path = `${config.secretsMount || "secret"}/data/tenants/${tenant}/oidc-clients/${appId}/${rotationId}`;
  const read = async () => {
    const secret = (await bao(config, "GET", path))?.data?.data?.clientSecret;
    if (typeof secret !== "string" || !/^[A-Za-z0-9_-]{64}$/.test(secret)) throw new HttpError(503, "secrets_unavailable");
    return secret;
  };
  try { return await read(); }
  catch (error) { if (error.status !== 404) throw error; }
  const clientSecret = randomBytes(48).toString("base64url");
  try {
    await bao(config, "POST", path, { options: { cas: 0 }, data: { clientSecret } });
    return clientSecret;
  } catch (error) {
    // A timeout may follow a committed write. Reuse the staged value.
    try { return await read(); } catch { throw error; }
  }
}

export async function handleApplicationManagement(request, response, identity, config, url, command) {
  const { method } = request;
  if (url.pathname === "/v1/applications" && method === "GET") {
    return json(response, 200, (await command("list", parseAppList(url))).value);
  }
  const match = /^\/v1\/applications\/([^/]+)(?:\/(assignments|oidc-keys)(?:\/([^/]+))?)?$/.exec(url.pathname);
  if (!match) return undefined;
  const [, appId, kind, assignmentId] = match;
  if (!uuidPattern.test(appId) || (assignmentId && (!uuidPattern.test(assignmentId) || kind !== "assignments"))) {
    throw new HttpError(400, "invalid_application_path");
  }
  if (url.search) throw new HttpError(400, "invalid_query");
  if (!kind && (method === "GET" || method === "PATCH")) {
    const fields = method === "PATCH" ? validateAppMetadata(await readObject(request)) : {};
    const { value } = await command(method === "GET" ? "get" : "update", { appId, ...fields, etag: request.headers["if-match"] });
    response.setHeader("ETag", `"application-${appId}-${value.revision}"`);
    return json(response, 200, value);
  }
  if (!kind) return undefined;
  if (kind === "assignments") {
    if (!assignmentId && method === "GET") return json(response, 200, (await command("assignments", { appId })).value);
    if ((!assignmentId && method === "POST") || (assignmentId && method === "DELETE")) {
      const body = method === "POST" ? validateAssignment(await readObject(request)) : { assignmentId };
      const result = await withProvider(config, command, appId, async (fenced, provider, clientId) => {
        const { value } = await fenced(method === "POST" ? "assignment_put" : "assignment_delete", body);
        if (value.synchronized) return value;
        await provider.applyAssignment(identity.tenantId, clientId, appId, value);
        await fenced("provider_confirm");
        return (await fenced("assignment_confirm", { assignmentId: value.assignmentId, enabled: value.enabled })).value;
      });
      if (method === "POST") return json(response, 200, result);
      response.writeHead(204, { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      return response.end();
    }
  } else if (method === "GET" || method === "POST") {
    if (method === "POST") {
      const rotationId = request.headers["idempotency-key"];
      if (typeof rotationId !== "string" || !uuidPattern.test(rotationId)) throw new HttpError(400, "invalid_idempotency_key");
      if (Object.keys(await readObject(request)).length) invalid();
      await withProvider(config, command, appId, async (fenced, provider, clientId) => {
        const replaceSecret = await provider.prepareRotation(clientId);
        if ((await fenced("rotation_start", { rotationId })).value.applied) return;
        const secret = await stageKey(config, identity.tenantId, appId, rotationId);
        await replaceSecret(secret);
        await fenced("rotation_confirm", { rotationId });
      });
    }
    return json(response, 200, (await command("rotation_history", { appId })).value);
  }
  throw new HttpError(405, "method_not_allowed");
}
