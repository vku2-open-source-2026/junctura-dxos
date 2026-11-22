// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Tenant directory and durable management writes.
import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { applicationToken } from "../applications/applications.mjs";
import { createDirectorySync } from "./keycloak.mjs";
import { signInternalToken } from "../../platform/security/internal-token.mjs";
import { HttpError, json, readBody, requireWriter } from "../../platform/http/http.mjs";
import { parseStrictJson } from "../capability/compatibility/compatibility.mjs";

export const DIRECTORY_PRINCIPALS_PATH = "/v1/directory/principals";
export const DIRECTORY_ORGANIZATIONS_PATH = "/v1/directory/organizations";
export const DIRECTORY_MANAGEMENT_PATH = "/v1/directory/";

const RPC = {
  [DIRECTORY_PRINCIPALS_PATH]: "directory_principals",
  [DIRECTORY_ORGANIZATIONS_PATH]: "directory_organizations",
};

const keyPattern = /^[a-z][a-z0-9-]{1,63}$/;
const subjectPattern = /^[A-Za-z0-9:_-]{1,128}$/;

// The cursor key is per collection: each list orders by a different column.
const CURSOR_KEYS = { unit_type_list: "unitType", unit_list: "unit", group_list: "group", member_list: "subject" };

const profileText = (value) => value === null ||
  (typeof value === "string" && value.length >= 1 && value.length <= 200 &&
    !/[\u0000-\u001f\u007f]/u.test(value));

function validPrincipals(value) {
  return Array.isArray(value?.items) && typeof value.truncated === "boolean" &&
    value.items.every((item) => item && typeof item === "object" &&
      typeof item.subject === "string" && typeof item.issuer === "string" &&
      typeof item.managementClient === "string" && Array.isArray(item.permissions) &&
      item.permissions.every((permission) => typeof permission === "string") &&
      typeof item.enabled === "boolean" &&
      Object.hasOwn(item, "displayName") && profileText(item.displayName) &&
      Object.hasOwn(item, "organization") && profileText(item.organization) &&
      Object.hasOwn(item, "jobTitle") && profileText(item.jobTitle) &&
      Object.hasOwn(item, "kind") && (item.kind === null || item.kind === "admin" || item.kind === "application"));
}

function validOrganizations(value) {
  const root = value?.root;
  return root && typeof root === "object" && typeof root.id === "string" &&
    typeof root.name === "string" && root.kind === "platform" &&
    Array.isArray(root.children) && root.children.every((child) =>
      child && typeof child === "object" && typeof child.id === "string" &&
      typeof child.name === "string" &&
      (child.kind === "organization" || child.kind === "application") &&
      Array.isArray(child.children)) &&
    Array.isArray(value.relations) && value.relations.every((relation) =>
      relation && typeof relation.from === "string" && typeof relation.to === "string" &&
      typeof relation.label === "string") &&
    typeof value.truncated === "boolean";
}

const displayName = (value) => typeof value === "string" && value.isWellFormed() &&
  [...value].length >= 1 && [...value].length <= 120 && !/[\u0000-\u001f\u007f]/u.test(value);

const encodeCursor = key => Buffer.from(JSON.stringify({ k: key })).toString("base64url");

const noContent = response => {
  response.writeHead(204, { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end();
};

function decodeCursor(cursor) {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (value && typeof value === "object" && !Array.isArray(value) && typeof value.k === "string" && value.k) return value.k;
  } catch { /* fall through to the shared rejection */ }
  throw new HttpError(400, "invalid_cursor");
}

function pageQuery(url) {
  if (![...url.searchParams.keys()].every(key => key === "limit" || key === "cursor")) {
    throw new HttpError(400, "invalid_query");
  }
  const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, "invalid_query");
  return { limit, after: url.searchParams.has("cursor") ? decodeCursor(url.searchParams.get("cursor")) : undefined };
}

async function readManagementBody(request) {
  if (request.headers["content-type"]?.split(";", 1)[0].trim() !== "application/json") throw new HttpError(415, "json_required");
  const bytes = await readBody(request, 16384);
  let value;
  try { value = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new HttpError(400, "invalid_request"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid_request");
  return value;
}

async function command(config, identity, operation, payload, worker = false) {
  if (!config.dataUrl) throw new HttpError(503, "directory_unavailable");
  let result;
  try {
    const token = worker
      ? signInternalToken(config.dataSecret, { role: "junctura_directory_worker", tenant_id: identity.tenantId,
        aud: "junctura-data", exp: Math.floor(Date.now() / 1000) + 30 })
      : applicationToken(identity, config.dataSecret, "junctura_directory_api");
    const db = await fetch(`${config.dataUrl}/rpc/directory_command`, {
      method: "POST", redirect: "error",
      headers: { Authorization: `Bearer ${token}`,
        "Content-Type": "application/json" },
      body: JSON.stringify({ operation, payload }),
      signal: AbortSignal.timeout(5000),
    });
    if (!db.ok) throw Error();
    result = await db.json();
  } catch { throw new HttpError(503, "directory_unavailable"); }
  if (result?.error) throw new HttpError(result.status, result.error);
  if (![200, 201, 204].includes(result?.status)) throw new HttpError(503, "directory_unavailable");
  return result;
}

async function withLease(config, rpc, run, waitForLease = true) {
  const lease = randomUUID();
  const fenced = (operation, payload = {}) => rpc(operation, { ...payload, lease });
  const provider = createDirectorySync(config, fetch, () => fenced("sync_renew"));
  if (!provider) throw new HttpError(503, "directory_unavailable");
  const deadline = Date.now() + 750;
  for (;;) {
    try { await fenced("sync_acquire"); break; }
    catch (error) {
      if (error.status !== 409 || !waitForLease || Date.now() >= deadline) throw error;
      await wait(50);
    }
  }
  try {
    return await run(fenced, provider);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error?.code === "not_found") throw new HttpError(404, "not_found");
    throw new HttpError(503, "directory_unavailable");
  } finally {
    // A lost release is recovered by lease expiry.
    await fenced("sync_release").catch(() => {});
  }
}

const PROVIDER_METHODS = { unit: ["putUnit", "removeUnit"], group: ["putGroup", "removeGroup"],
  member: ["putMember", "removeMember"] };

async function applyJob(tenant, rpc, provider, { kind, remove, keys, groups, generation }) {
  if (generation === undefined) return;
  const args = kind === "unit" ? [keys.unit] : kind === "group" ? [keys.unit, keys.group] : [keys.unit, keys.subject];
  if (kind === "member" && !remove) args.push(groups);
  await provider[PROVIDER_METHODS[kind][Number(remove)]](tenant, ...args);
  await rpc(`${kind}${remove ? "_delete" : ""}_confirm`, { ...keys, generation });
}

// Each pass also checks confirmed rows and tombstones for late provider writes.
export function startDirectoryReconciler(config, delay = 30_000) {
  if (!config.dataUrl || !createDirectorySync(config)) return undefined;
  let stopped = false;
  async function sweep() {
    let after;
    do {
      const { value: tenants } = await command(config, {}, "sync_tenants", { after }, true);
      if (!tenants.length) break;
      for (const tenantId of tenants) {
        const rpc = (operation, payload) => command(config, { tenantId }, operation, payload, true);
        let cursor;
        while (!stopped) {
          let job;
          try {
            await withLease(config, rpc, async (fenced, provider) => {
              ({ value: job } = await fenced("sync_next", { after: cursor }));
              if (job && !stopped) await applyJob(tenantId, fenced, provider, job);
            }, false);
          } catch { /* An unavailable row is retried on the next pass. */ }
          if (!job) break;
          cursor = job.cursor;
        }
      }
      after = tenants.at(-1);
    } while (!stopped);
  }
  async function tick() {
    try { await sweep(); }
    catch { /* Retry database outages on the next pass. */ }
    if (!stopped) timer = setTimeout(tick, delay).unref();
  }
  let timer = setTimeout(tick, delay).unref();
  return () => { stopped = true; clearTimeout(timer); };
}

const KINDS = {
  "unit-type": {
    pattern: /^\/v1\/directory\/unit-types\/([^/]+)$/, keys: ["unitType"], list: "unit_type_list",
    put: "unit_type_put", remove: "unit_type_delete", identityProvider: false,
    parse: body => {
      if (!body || Object.keys(body).sort().join(",") !== "name" || !displayName(body.name)) throw new HttpError(400, "invalid_request");
      return { name: body.name };
    },
    row: (keys, body) => ({ unitType: keys.unitType, name: body.name }),
  },
  "unit": {
    pattern: /^\/v1\/directory\/units\/([^/]+)$/, keys: ["unit"], list: "unit_list",
    put: "unit_put", remove: "unit_delete", identityProvider: true,
    parse: body => {
      if (!body || Object.keys(body).sort().join(",") !== "name,unitType" ||
        (typeof body.unitType !== "string" || !keyPattern.test(body.unitType)) || !displayName(body.name)) throw new HttpError(400, "invalid_request");
      return { unitType: body.unitType, name: body.name };
    },
    row: (keys, body) => ({ unit: keys.unit, unitType: body.unitType, name: body.name }),
  },
  "group": {
    pattern: /^\/v1\/directory\/units\/([^/]+)\/groups\/([^/]+)$/, keys: ["unit", "group"], list: undefined,
    put: "group_put", remove: "group_delete", identityProvider: true,
    parse: body => {
      if (!body || Object.keys(body).sort().join(",") !== "name" || !displayName(body.name)) throw new HttpError(400, "invalid_request");
      return { name: body.name };
    },
    row: (keys, body) => ({ unit: keys.unit, group: keys.group, name: body.name }),
  },
};

const LIST_ROUTES = new Map([
  ["/v1/directory/unit-types", { list: "unit_type_list" }],
  ["/v1/directory/units", { list: "unit_list" }],
]);

function segment(raw, pattern = keyPattern) {
  let value;
  try { value = decodeURIComponent(raw); }
  catch { throw new HttpError(400, "invalid_request"); }
  if (!pattern.test(value)) throw new HttpError(400, "invalid_request");
  return value;
}

function matchManagement(request, response, url) {
  const path = url.pathname;
  const collection = path.match(/^\/v1\/directory\/units\/([^/]+)\/(groups|members)$/);
  if (collection) {
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      throw new HttpError(405, "method_not_allowed");
    }
    return { list: collection[2] === "groups" ? "group_list" : "member_list", unit: segment(collection[1]) };
  }
  if (LIST_ROUTES.has(path)) {
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      throw new HttpError(405, "method_not_allowed");
    }
    return { list: LIST_ROUTES.get(path).list };
  }
  const member = path.match(/^\/v1\/directory\/units\/([^/]+)\/members\/([^/]+)$/);
  if (member) {
    const unit = segment(member[1]);
    const subject = segment(member[2], subjectPattern);
    if (request.method !== "PUT" && request.method !== "DELETE") {
      response.setHeader("Allow", "PUT, DELETE");
      throw new HttpError(405, "method_not_allowed");
    }
    return { member: { unit, subject } };
  }
  for (const [kind, spec] of Object.entries(KINDS)) {
    const match = path.match(spec.pattern);
    if (!match) continue;
    const keys = Object.fromEntries(spec.keys.map((name, index) => [name, segment(match[index + 1])]));
    if (request.method !== "PUT" && request.method !== "DELETE") {
      response.setHeader("Allow", "PUT, DELETE");
      throw new HttpError(405, "method_not_allowed");
    }
    return { kind, keys, spec };
  }
  throw new HttpError(404, "not_found");
}

async function listPage(response, identity, config, url, list, unit) {
  const { limit, after } = pageQuery(url);
  const result = await command(config, identity, list,
    { limit, ...(after !== undefined ? { after } : {}), ...(unit !== undefined ? { unit } : {}) });
  const value = result.value;
  if (!value || !Array.isArray(value.items) || !Number.isInteger(value.total) ||
    value.items.some(item => !item || typeof item !== "object")) {
    throw new HttpError(503, "directory_unavailable");
  }
  const last = value.items.at(-1);
  const cursorKey = CURSOR_KEYS[list];
  return json(response, 200, { items: value.items,
    nextCursor: value.items.length < value.total && last && cursorKey && last[cursorKey] !== undefined
      ? encodeCursor(String(last[cursorKey])) : null });
}

async function writeMember(request, response, identity, config, url, keys) {
  if (url.search) throw new HttpError(400, "invalid_query");
  const remove = request.method === "DELETE";
  let groups;
  if (!remove) {
    const body = await readManagementBody(request);
    if (Object.keys(body).join(",") !== "groups" || !Array.isArray(body.groups) ||
      body.groups.length > 100 || body.groups.some(group => typeof group !== "string" || !keyPattern.test(group)) ||
      new Set(body.groups).size !== body.groups.length) {
      throw new HttpError(400, "invalid_request");
    }
    groups = body.groups.sort();
  }
  const rpc = (operation, payload) => command(config, identity, operation, payload);
  const prepared = await withLease(config, rpc, async (fenced, provider) => {
    if (!remove) await provider.verifySubject(identity.tenantId, keys.subject);
    const result = await fenced(remove ? "member_delete" : "member_put", { ...keys, groups });
    await applyJob(identity.tenantId, fenced, provider, { kind: "member", remove, keys, groups, generation: result.generation });
    return result;
  });
  return remove ? noContent(response) : json(response, prepared.status, { ...keys, groups });
}

async function writeRow(request, response, identity, config, url, kind, keys, spec) {
  if (url.search) throw new HttpError(400, "invalid_query");
  const remove = request.method === "DELETE";
  const desired = remove ? undefined : spec.parse(await readManagementBody(request));
  const rpc = (operation, payload) => command(config, identity, operation, payload);
  const operation = remove ? spec.remove : spec.put;
  const payload = { ...keys, ...desired };
  const prepared = spec.identityProvider
    ? await withLease(config, rpc, async (fenced, provider) => {
      const result = await fenced(operation, payload);
      await applyJob(identity.tenantId, fenced, provider, { kind, remove, keys, generation: result.generation });
      return result;
    })
    : await rpc(operation, payload);
  return remove ? noContent(response) : json(response, prepared.status, spec.row(keys, desired));
}

async function readView(request, response, identity, config, url, rpc) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    throw new HttpError(405, "method_not_allowed");
  }
  if (url.search) throw new HttpError(400, "invalid_query");
  if (!config.dataUrl) throw new HttpError(503, "directory_unavailable");
  if (!identity.clientId) throw new HttpError(403, "verified_client_required");
  let result;
  try {
    const db = await fetch(`${config.dataUrl}/rpc/${rpc}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${applicationToken(identity, config.dataSecret, "junctura_directory_api")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ payload: {} }),
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    if (!db.ok) throw Error();
    result = await db.json();
  } catch { throw new HttpError(503, "directory_unavailable"); }
  if (result?.error) throw new HttpError(result.status, result.error);
  if (result?.status !== 200) throw new HttpError(503, "directory_unavailable");
  if (rpc === "directory_principals" ? !validPrincipals(result.value) : !validOrganizations(result.value)) {
    throw new HttpError(503, "directory_unavailable");
  }
  response.setHeader("Cache-Control", "no-store");
  return json(response, 200, result.value);
}

export async function handleDirectory(request, response, identity, config, url) {
  const rpc = RPC[url.pathname];
  if (rpc) return readView(request, response, identity, config, url, rpc);
  if (!url.pathname.startsWith(DIRECTORY_MANAGEMENT_PATH)) throw new HttpError(404, "not_found");
  if (!identity.clientId) throw new HttpError(403, "verified_client_required");
  const match = matchManagement(request, response, url);
  // Mutations need the core-writer role in addition to directory.write; the
  // database re-checks both through the internal token.
  if (!match.list) requireWriter(identity);
  response.setHeader("Cache-Control", "no-store");
  if (match.list) return listPage(response, identity, config, url, match.list, match.unit);
  if (match.member) return writeMember(request, response, identity, config, url, match.member);
  return writeRow(request, response, identity, config, url, match.kind, match.keys, match.spec);
}
