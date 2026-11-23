// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { signInternalToken } from "../security/internal-token.mjs";
import { HttpError, requestIdFor, uuidPattern } from "../http/http.mjs";

const subjectIdPattern = /^[A-Za-z0-9:_-]{1,128}$/;
const orgPathPattern = /^\/[a-z][a-z0-9-]{1,63}(?:\/[a-z][a-z0-9-]{1,63})?$/;

// Verified organization membership comes from the token's group paths under
// the tenant namespace, e.g. /tenant-a/unit-a/reviewers. Paths outside the
// namespace or deeper than /unit/group never name a unit or a group here.
export function organizationContext(groups, tenantId) {
  const units = new Set();
  const paths = new Set();
  const prefix = `/${tenantId}/`;
  if (!Array.isArray(groups)) return { units: [], groups: [] };
  for (const claim of groups) {
    if (typeof claim !== "string" || !claim.startsWith(prefix)) continue;
    const path = claim.slice(tenantId.length + 1);
    if (!orgPathPattern.test(path)) continue;
    const [unit, group] = path.slice(1).split("/");
    units.add(unit);
    if (group !== undefined) paths.add(path);
  }
  return { units: [...units].sort(), groups: [...paths].sort() };
}

export function validateIdentity(claims, issuer, now = Date.now() / 1000) {
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.active !== true || claims.iss !== issuer || !audiences.includes("junctura-core") ||
      !Number.isFinite(claims.exp) || claims.exp <= now || typeof claims.sub !== "string" || !claims.sub) {
    throw new HttpError(401, "invalid_token");
  }
  // Membership names the tenant's root group by full path, /{tenant}: leaf
  // group names can repeat across tenants, so only the exact root path proves
  // enrollment in this tenant.
  if (typeof claims.tenant_id !== "string" || !/^[a-z][a-z0-9-]{0,62}$/.test(claims.tenant_id) ||
      !Array.isArray(claims.tenant_memberships) ||
      !claims.tenant_memberships.includes(`/${claims.tenant_id}`)) {
    throw new HttpError(403, "tenant_required");
  }
  const roles = claims.realm_access?.roles ?? [];
  if (!Array.isArray(roles) || !roles.includes("core-reader")) throw new HttpError(403, "insufficient_role");
  const preferredUsername = typeof claims.preferred_username === "string" &&
    claims.preferred_username.isWellFormed() && claims.preferred_username.trim().length > 0 &&
    [...claims.preferred_username].length <= 255 && !/[\u0000-\u001f\u007f]/u.test(claims.preferred_username)
    ? claims.preferred_username : undefined;
  const subjectId = typeof claims.subject_id === "string" && subjectIdPattern.test(claims.subject_id)
    ? claims.subject_id : undefined;
  return { subject: claims.sub, tenantId: claims.tenant_id,
    roles: roles.filter((role) => ["core-reader", "core-writer", "regulator"].includes(role)),
    ...organizationContext(claims.groups, claims.tenant_id),
    ...(subjectId ? { subjectId } : {}),
    ...(preferredUsername ? { preferredUsername } : {}) };
}

const scopedRoute = /^\/v2\/(?:data(?:[/:-]|$)|objects(?:\/|$))/;
const consoleRoles = ["admin", "manager", "viewer"];
const consoleRoleTtlMs = 3000;
const consoleRoleCacheLimit = 1024;

function managementAppId(path, method) {
  if (path === "/v1/applications" && method === "GET") return null;
  const match = /^\/v1\/applications\/([^/]+)(?:\/(assignments|oidc-keys)(?:\/([^/]+))?)?$/.exec(path);
  if (!match || !uuidPattern.test(match[1])) return undefined;
  const [, appId, kind, assignmentId] = match;
  if (assignmentId) {
    return kind === "assignments" && method === "DELETE" && uuidPattern.test(assignmentId) ? appId : undefined;
  }
  if (method === "GET" || method === (kind ? "POST" : "PATCH")) return appId;
}

export async function logAccessDenial(config, identity, requestId, code) {
  if (!identity?.clientId) return;
  const response = await fetch(`${config.dataUrl}/rpc/record_app_denial`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(3000),
    headers: { Authorization: `Bearer ${signInternalToken(config.dataSecret, {
      role: "junctura_app_access_api", aud: "junctura-data", exp: Math.floor(Date.now() / 1000) + 15,
      tenant_id: identity.tenantId, iss: identity.issuer, sub: identity.subject, client_id: identity.clientId,
    })}`, "Content-Type": "application/json" },
    body: JSON.stringify({ payload: { requestId, code } }),
  });
  if (!response.ok || (await response.json()).status !== 200) throw new HttpError(503, "app_access_unavailable");
}

async function enforceAccess(config, fetcher, request, identity, claims) {
  const path = request.url?.split("?", 1)[0];
  const checkOnly = path === "/internal/auth";
  const write = Boolean(request.method && !["GET", "HEAD", "OPTIONS"].includes(request.method)) &&
    !(request.method === "POST" && path === "/v1/audit-events/verify");
  const target = /^\/v2\/(?:data\/([^/]+)|objects)\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?:[:/]|$)/.exec(path);
  const resource = target ? { resourceId: target[2], resourceCollection: target[1] } : {};
  const roles = claims.resource_access?.[identity.clientId]?.roles;
  const clientRoles = Array.isArray(roles) ? roles.filter(role => typeof role === "string") : [];
  let consoleRole = identity.clientId === "junctura-console"
    ? consoleRoles.find(role => clientRoles.includes(`console-${role}`)) : undefined;
  if (consoleRole && config.currentConsoleRoles) {
    const current = await config.currentConsoleRoles(identity.subject);
    consoleRole = consoleRoles.find(role =>
      current.includes(`console-${role}`) && clientRoles.includes(`console-${role}`));
  }
  const upstream = await fetcher(`${config.dataUrl}/rpc/app_access_check`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(3000),
    headers: { Authorization: `Bearer ${signInternalToken(config.dataSecret, {
      role: "junctura_app_access_api", aud: "junctura-data", exp: Math.floor(Date.now() / 1000) + 15,
      tenant_id: identity.tenantId, iss: identity.issuer, client_id: identity.clientId, sub: identity.subject,
      app_unit: typeof claims.junctura_unit === "string" ? claims.junctura_unit : undefined,
      units: identity.units, client_roles: clientRoles, console_role: consoleRole,
    })}`, "Content-Type": "application/json" },
    body: JSON.stringify({ payload: { requestId: requestIdFor(request), write: !checkOnly && write, ...resource,
      // The gateway check has no target. The public route checks the specific app.
      managementAppId: checkOnly ? null : managementAppId(path, request.method),
      userRoute: checkOnly || path === "/v1/identity" || path === "/v1/search" || scopedRoute.test(path),
      managerOnly: write && path?.startsWith("/v2/data-schemas/") } }),
  });
  if (!upstream.ok) throw new HttpError(503, "app_access_unavailable");
  const access = await upstream.json();
  if (access.status === 403) throw new HttpError(403, access.error);
  if (access.status !== 200) throw new HttpError(503, "app_access_unavailable");
  if (consoleRole) identity.consoleRole = consoleRole;
  if (access.value) {
    identity.resourceUnit = access.value.unit;
    if (access.value.human) {
      identity.humanAppId = access.value.appId;
      identity.appRoles = access.value.roles;
      identity.roles = access.value.roles.some(role => role === "editor" || role === "manager")
        ? ["core-reader", "core-writer"] : ["core-reader"];
    }
    identity.units = [access.value.unit];
    identity.groups = identity.groups.filter(group => group.startsWith(`/${access.value.unit}/`));
  }
}

export function createAuthorizer(config, fetcher = fetch) {
  if (config.currentConsoleRoles) {
    const lookup = config.currentConsoleRoles;
    const cache = new Map();
    config = {
      ...config,
      async currentConsoleRoles(subject) {
        const now = performance.now();
        const cached = cache.get(subject);
        if (cached?.expiresAt > now) return cached.roles;
        const roles = await lookup(subject);
        // A slow or out-of-order lookup cannot extend an older role decision.
        const expiresAt = now + consoleRoleTtlMs;
        if (expiresAt > performance.now() && !(cache.get(subject)?.expiresAt > expiresAt)) {
          cache.delete(subject);
          if (cache.size >= consoleRoleCacheLimit) cache.delete(cache.keys().next().value);
          cache.set(subject, { expiresAt, roles });
        }
        return roles;
      },
    };
  }
  return async (request, withContext = false) => {
    const authorization = request.headers.authorization;
    if (typeof authorization !== "string" || !/^Bearer [A-Za-z0-9._~-]+$/.test(authorization) || authorization.length > 8192) {
      throw new HttpError(401, "bearer_token_required");
    }
    let response;
    try {
      response = await fetcher(`${config.identityUrl}/protocol/openid-connect/token/introspect`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: "junctura-core", client_secret: config.clientSecret, token: authorization.slice(7) }),
        signal: AbortSignal.timeout(3000),
        redirect: "error",
      });
      if (!response.ok) throw new Error("Introspection unavailable");
      const claims = await response.json();
      const verified = validateIdentity(claims, config.issuer);
      const identity = { ...verified, issuer: config.issuer,
        clientId: typeof claims.client_id === "string" && claims.client_id.length <= 255 ? claims.client_id : undefined,
        credentialExpiresAt: claims.exp * 1000 };
      if (config.enforceAppAccess) {
        if (!identity.clientId) throw new HttpError(403, "verified_client_required");
        await enforceAccess(config, fetcher, request, identity, claims);
      }
      return withContext ? identity : { ...verified, roles: identity.roles, units: identity.units, groups: identity.groups };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, "identity_unavailable");
    }
  };
}
