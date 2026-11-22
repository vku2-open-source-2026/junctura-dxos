// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Read-only tenant directory: enrolled management principals and the real
// organization/application tree. The database enforces audit.read on the
// verified caller; Core only asserts the private directory role.
//
// Directory management writes (directory.write principals holding the
// core-writer role): unit types, flat units, per-unit groups and unit
// memberships with durable desired state. Coordination lives in PostgreSQL:
// every command takes a per-tenant advisory lock and carries a per-row
// generation, so replicas never need an in-process lock. Each change is
// applied to the identity provider through a dedicated service account and
// only confirmed after a read-back matches the stored generation; a confirm
// that lost a race reports the conflict and a retry of the same desired state
// converges.
import { applicationToken } from "../applications/applications.mjs";
import { createDirectorySync } from "./keycloak.mjs";
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

async function command(config, identity, operation, payload) {
  if (!config.dataUrl) throw new HttpError(503, "directory_unavailable");
  let result;
  try {
    const db = await fetch(`${config.dataUrl}/rpc/directory_command`, {
      method: "POST", redirect: "error",
      headers: { Authorization: `Bearer ${applicationToken(identity, config.dataSecret, "junctura_directory_api")}`,
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

const withProvider = (config, action) => {
  const provider = createDirectorySync(config);
  if (!provider) throw new HttpError(503, "directory_unavailable");
  return action(provider).catch(error => {
    if (error instanceof Error && error.code === "not_found") throw new HttpError(404, "not_found");
    throw new HttpError(503, "directory_unavailable");
  });
};

const KINDS = {
  "unit-type": {
    pattern: /^\/v1\/directory\/unit-types\/([^/]+)$/, keys: ["unitType"], list: "unit_type_list",
    put: "unit_type_put", confirm: "unit_type_confirm", remove: "unit_type_delete",
    removeConfirm: "unit_type_delete_confirm", identityProvider: false,
    parse: body => {
      if (!body || Object.keys(body).sort().join(",") !== "name" || !displayName(body.name)) throw new HttpError(400, "invalid_request");
      return { name: body.name };
    },
    row: (keys, body) => ({ unitType: keys.unitType, name: body.name }),
  },
  "unit": {
    pattern: /^\/v1\/directory\/units\/([^/]+)$/, keys: ["unit"], list: "unit_list",
    put: "unit_put", confirm: "unit_confirm", remove: "unit_delete",
    removeConfirm: "unit_delete_confirm", identityProvider: true,
    parse: body => {
      if (!body || Object.keys(body).sort().join(",") !== "name,unitType" ||
        !keyPattern.test(body.unitType) || !displayName(body.name)) throw new HttpError(400, "invalid_request");
      return { unitType: body.unitType, name: body.name };
    },
    row: (keys, body) => ({ unit: keys.unit, unitType: body.unitType, name: body.name }),
  },
  "group": {
    pattern: /^\/v1\/directory\/units\/([^/]+)\/groups\/([^/]+)$/, keys: ["unit", "group"], list: undefined,
    put: "group_put", confirm: "group_confirm", remove: "group_delete",
    removeConfirm: "group_delete_confirm", identityProvider: true,
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

function matchManagement(request, response, url) {
  const path = url.pathname;
  const collection = path.match(/^\/v1\/directory\/units\/([^/]+)\/(groups|members)$/);
  if (collection) {
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      throw new HttpError(405, "method_not_allowed");
    }
    return { list: collection[2] === "groups" ? "group_list" : "member_list", unit: collection[1] };
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
    // Decode each raw path segment once; encoded valid identifiers such as a
    // colon inside a subject must not fail the shape check.
    const unit = decodeURIComponent(member[1]);
    const subject = decodeURIComponent(member[2]);
    if (!keyPattern.test(unit) || !subjectPattern.test(subject)) throw new HttpError(400, "invalid_request");
    if (request.method !== "PUT" && request.method !== "DELETE") {
      response.setHeader("Allow", "PUT, DELETE");
      throw new HttpError(405, "method_not_allowed");
    }
    return { member: { unit, subject } };
  }
  for (const [kind, spec] of Object.entries(KINDS)) {
    const match = path.match(spec.pattern);
    if (!match) continue;
    const keys = Object.fromEntries(spec.keys.map((name, index) => [name, decodeURIComponent(match[index + 1])]));
    if (Object.values(keys).some(value => !keyPattern.test(value))) throw new HttpError(400, "invalid_request");
    if (request.method !== "PUT" && request.method !== "DELETE") {
      response.setHeader("Allow", "PUT, DELETE");
      throw new HttpError(405, "method_not_allowed");
    }
    return { kind, keys, spec };
  }
  throw new HttpError(404, "not_found");
}

async function listPage(request, response, identity, config, url, list, unit) {
  const { limit, after } = pageQuery(url);
  if (unit !== undefined && !keyPattern.test(unit)) throw new HttpError(400, "invalid_request");
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

// The membership set of one member is a durable desired state like every other
// row: prepare first, apply to the provider only after the subject is verified
// in this tenant, read the provider back, and confirm that generation.
async function writeMember(request, response, identity, config, url, unit, subject) {
  if (url.search) throw new HttpError(400, "invalid_query");
  if (request.method === "DELETE") {
    const prepared = await command(config, identity, "member_delete", { unit, subject });
    if (prepared.generation === undefined) return noContent(response);
    await withProvider(config, provider => provider.removeMember(identity.tenantId, unit, subject));
    await command(config, identity, "member_delete_confirm", { unit, subject, generation: prepared.generation });
    return noContent(response);
  }
  const body = await readManagementBody(request);
  if (Object.keys(body).sort().join(",") !== "groups" || !Array.isArray(body.groups) ||
    body.groups.length > 100 || body.groups.some(group => !keyPattern.test(group)) ||
    new Set(body.groups).size !== body.groups.length) {
    throw new HttpError(400, "invalid_request");
  }
  const groups = [...new Set(body.groups)].sort();
  // Verify the subject belongs to this tenant before any desired state is
  // committed, so a provider 404 can never strand a member row and block the
  // deletion of its unit.
  await withProvider(config, provider => provider.verifySubject(identity.tenantId, subject));
  const prepared = await command(config, identity, "member_put", { unit, subject, groups });
  // Always read the provider back: an identical confirmed desired state
  // verifies the stored state, and a diverging provider heals here.
  await withProvider(config, provider => provider.putMember(identity.tenantId, unit, subject, groups));
  await command(config, identity, "member_confirm", { unit, subject, generation: prepared.generation });
  return json(response, prepared.status, { unit, subject, groups });
}

async function writeRow(request, response, identity, config, url, kind, keys, spec) {
  if (url.search) throw new HttpError(400, "invalid_query");
  if (request.method === "DELETE") {
    const prepared = await command(config, identity, spec.remove, keys);
    if (prepared.generation === undefined) return noContent(response);
    if (spec.identityProvider) {
      await withProvider(config, provider => kind === "unit"
        ? provider.removeUnit(identity.tenantId, keys.unit)
        : provider.removeGroup(identity.tenantId, keys.unit, keys.group));
    }
    await command(config, identity, spec.removeConfirm, { ...keys, generation: prepared.generation });
    return noContent(response);
  }
  const body = await readManagementBody(request);
  const desired = spec.parse(body);
  const prepared = await command(config, identity, spec.put, { ...keys, ...desired });
  // Always read the provider back, including after a prepare that reports the
  // row as already confirmed, so provider drift is repaired on every write.
  if (spec.identityProvider) {
    await withProvider(config, provider => kind === "unit"
      ? provider.putUnit(identity.tenantId, keys.unit)
      : provider.putGroup(identity.tenantId, keys.unit, keys.group));
  }
  await command(config, identity, spec.confirm, { ...keys, generation: prepared.generation });
  return json(response, prepared.status, spec.row(keys, body));
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
  if (match.list) return listPage(request, response, identity, config, url, match.list, match.unit);
  if (match.member) return writeMember(request, response, identity, config, url, match.member.unit, match.member.subject);
  return writeRow(request, response, identity, config, url, match.kind, match.keys, match.spec);
}
