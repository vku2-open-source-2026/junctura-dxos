// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { signInternalToken } from "../security/internal-token.mjs";
import { HttpError, requestIdFor, uuidPattern } from "../http/http.mjs";
import { coreClient, delegationDenied, delegationTokens, exchangeProviderToken, tokenClaims } from "./delegation.mjs";

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
const consentRequestRoute = /^\/v1\/(?:resource-consent-requests(?:\/[0-9a-f-]+(?:\/cancel)?)?|me\/resource-consent-requests(?:\/[0-9a-f-]+\/(?:accept|decline))?)$/;
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

export async function logAccessDenial(config, identity, requestId, code, fetcher = fetch) {
  if (!identity?.clientId) return;
  const response = await fetcher(`${config.dataUrl}/rpc/record_app_denial`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(3000),
    headers: { Authorization: `Bearer ${signInternalToken(config.dataSecret, {
      role: "junctura_app_access_api", aud: "junctura-data", exp: Math.floor(Date.now() / 1000) + 15,
      tenant_id: identity.tenantId, iss: identity.issuer, sub: identity.subject, client_id: identity.clientId,
      actor_sub: identity.actor?.sub,
    })}`, "Content-Type": "application/json" },
    body: JSON.stringify({ payload: { requestId, code } }),
  });
  if (!response.ok || (await response.json()).status !== 200) throw new HttpError(503, "app_access_unavailable");
}

async function enforceAccess(config, fetcher, request, identity, claims, exchange) {
  const path = request.url?.split("?", 1)[0];
  const checkOnly = path === "/internal/auth";
  const consentRequest = consentRequestRoute.test(path);
  const write = Boolean(request.method && !["GET", "HEAD", "OPTIONS"].includes(request.method)) &&
    !consentRequest && !(request.method === "POST" && path === "/v1/audit-events/verify");
  const target = /^\/v2\/(?:data\/([^/]+)|objects)\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?:[:/]|$)/.exec(path);
  // The exact GET handlers evaluate unit isolation and consent together.
  const consentRead = identity.actor && request.method === "GET" && target && target[0] === path && path.endsWith(target[2]);
  const resource = target && !consentRead ? { resourceId: target[2], resourceCollection: target[1] } : {};
  const roles = claims.resource_access?.[identity.clientId]?.roles;
  const clientRoles = Array.isArray(roles) ? roles.filter(role => typeof role === "string") : [];
  let consoleRole = identity.clientId === "junctura-console"
    ? consoleRoles.find(role => clientRoles.includes(`console-${role}`)) : undefined;
  if (consoleRole && config.currentConsoleRoles) {
    const current = await config.currentConsoleRoles(identity.subject);
    consoleRole = consoleRoles.find(role =>
      current.includes(`console-${role}`) && clientRoles.includes(`console-${role}`));
  }
  const rpc = identity.actor ? "delegation_access_check" : "app_access_check";
  const upstream = await fetcher(`${config.dataUrl}/rpc/${rpc}`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(3000),
    headers: { Authorization: `Bearer ${signInternalToken(config.dataSecret, {
      role: "junctura_app_access_api", aud: "junctura-data", exp: Math.floor(Date.now() / 1000) + 15,
      tenant_id: identity.tenantId, iss: identity.issuer, client_id: identity.clientId, sub: identity.subject,
      app_unit: typeof claims.junctura_unit === "string" ? claims.junctura_unit : undefined,
      units: identity.units, client_roles: clientRoles, console_role: consoleRole,
      actor_sub: identity.actor?.sub, actor_unit: identity.actorUnit, delegated_writer: identity.delegatedWriter,
    })}`, "Content-Type": "application/json" },
    body: JSON.stringify({ payload: { requestId: requestIdFor(request), write: !exchange && !checkOnly && write, ...resource,
      // The gateway check has no target. The public route checks the specific app.
      managementAppId: identity.actor ? undefined : checkOnly ? null : managementAppId(path, request.method),
      userRoute: Boolean(exchange) || checkOnly || path === "/v1/identity" || path === "/v1/search" ||
        path === "/v1/capabilities/catalog" || path === "/v1/trust/access-requests" ||
        path?.startsWith("/v1/trust/access-requests/") || scopedRoute.test(path) || consentRequest,
      managerOnly: write && path?.startsWith("/v2/data-schemas/"),
      sourceClient: exchange ? claims.client_id : undefined,
      delegationEvent: exchange === "issue" ? "exchanged" : identity.actor && !exchange && !checkOnly ? "authorized" : undefined,
    } }),
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
      identity.appRoles = identity.delegatedWriter === false ? ["viewer"] : access.value.roles;
      identity.roles = identity.appRoles.some(role => role === "editor" || role === "manager")
        ? ["core-reader", "core-writer"] : ["core-reader"];
    }
    identity.units = [access.value.unit];
    identity.groups = identity.groups.filter(group => group.startsWith(`/${access.value.unit}/`));
  }
}

const tokenPattern = /^[A-Za-z0-9._~-]+$/;

function bearer(request) {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ") ||
      authorization.length > 8192 || !tokenPattern.test(authorization.slice(7))) {
    throw new HttpError(401, "bearer_token_required");
  }
  return authorization.slice(7);
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
  const tokens = config.enforceAppAccess && config.clientSecret ? delegationTokens(config) : undefined;
  async function introspect(token) {
    const response = await fetcher(`${config.identityUrl}/protocol/openid-connect/token/introspect`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(3000),
      body: new URLSearchParams({ client_id: coreClient, client_secret: config.clientSecret, token }),
    });
    if (!response.ok) throw new HttpError(503, "identity_unavailable");
    return response.json();
  }

  async function deny(request, identity) {
    try { await logAccessDenial(config, identity, requestIdFor(request), delegationDenied, fetcher); }
    catch { throw new HttpError(503, "app_access_unavailable"); }
    throw new HttpError(403, delegationDenied);
  }

  async function providerProof(token, subject) {
    const claims = await introspect(token);
    if (claims.active === true && claims.iss === config.issuer && claims.sub === subject &&
        claims.client_id === coreClient && [claims.aud].flat().includes(coreClient) &&
        Number.isFinite(claims.exp) && claims.exp > Date.now() / 1000) {
      return claims.exp;
    }
  }

  const authorize = async (request, withContext = false) => {
    const token = bearer(request);
    try {
      const delegated = tokens?.read(token);
      if (delegated) {
        const { sub: subject, tenant_id: tenantId, act: actor, unit, groups, writer, proof, app_roles: appRoles } = delegated;
        const identity = { subject, tenantId, actor, clientId: actor.client_id, issuer: config.issuer,
          roles: ["core-reader"], units: [unit], groups, delegatedWriter: writer, actorUnit: delegated.actor_unit,
          credentialExpiresAt: delegated.exp * 1000 };
        if (!await providerProof(proof, subject)) await deny(request, identity);
        await enforceAccess(config, fetcher, request, identity, {
          junctura_unit: unit, resource_access: { [identity.clientId]: { roles: appRoles } },
        });
        return identity;
      }
      const claims = await introspect(token);
      if (claims.client_id === coreClient || Object.hasOwn(claims, "act")) throw new HttpError(401, "invalid_token");
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

  authorize.exchange = async (request, subjectToken) => {
    if (!tokens) throw new HttpError(503, "app_access_unavailable");
    if (typeof subjectToken !== "string" || subjectToken.length > 8185 || !tokenPattern.test(subjectToken)) {
      throw new HttpError(400, "invalid_request");
    }
    const actorToken = bearer(request);
    const [actorClaims, subjectClaims] = await Promise.all([introspect(actorToken), introspect(subjectToken)]);
    const actor = exchangeIdentity(actorClaims, actorToken);
    const acting = { sub: actor.subject, client_id: actor.clientId };
    const actorIdentity = { ...actor, actor: acting };
    let subject;
    try { subject = exchangeIdentity(subjectClaims, subjectToken); }
    catch (error) {
      if (!(error instanceof HttpError)) throw error;
      await deny(request, actorIdentity);
    }
    if (actor.tenantId !== subject.tenantId) await deny(request, actorIdentity);
    const identity = { ...subject, clientId: actor.clientId, actor: acting,
      actorUnit: actor.signed.junctura_unit,
      delegatedWriter: [actor, subject].every(party => party.roles.includes("core-writer")) };
    const clientRoles = party => party.resource_access?.[actor.clientId]?.roles;
    const issuedRoles = clientRoles(subject.signed);
    const currentRoles = clientRoles(subjectClaims);
    const roleIds = Array.isArray(issuedRoles) && Array.isArray(currentRoles) ? issuedRoles.filter(role =>
      typeof role === "string" && role.startsWith("junctura-assignment-") && currentRoles.includes(role)) : [];
    const accessClaims = { client_id: subject.clientId, junctura_unit: subject.signed.junctura_unit,
      resource_access: { [actor.clientId]: { roles: roleIds } } };
    await enforceAccess(config, fetcher, request, identity, accessClaims, "check");
    let proof;
    try { proof = await exchangeProviderToken(config, fetcher, subjectToken); }
    catch (error) {
      if (error.message === delegationDenied) await deny(request, identity);
      throw error;
    }
    const proofExpiry = await providerProof(proof, subject.subject);
    const now = Math.floor(Date.now() / 1000);
    const exp = Math.min(now + 60, subject.expiresAt, actor.expiresAt, proofExpiry ?? 0);
    if (exp <= now) await deny(request, identity);
    const accessToken = tokens.issue({ sub: subject.subject, tenant_id: subject.tenantId, act: identity.actor,
      exp, iat: now, unit: identity.resourceUnit, groups: identity.groups, writer: identity.delegatedWriter,
      actor_unit: identity.actorUnit, app_roles: roleIds, proof });
    if (accessToken.length > 8185) throw new HttpError(503, "identity_unavailable");
    accessClaims.junctura_unit = identity.resourceUnit;
    await enforceAccess(config, fetcher, request, identity, accessClaims, "issue");
    const expiresIn = exp - Math.floor(Date.now() / 1000);
    if (expiresIn <= 0) await deny(request, identity);
    return { access_token: accessToken, token_type: "Bearer", expires_in: expiresIn };
  };

  function exchangeIdentity(claims, token) {
    const current = validateIdentity(claims, config.issuer);
    const signed = tokenClaims(token);
    const issued = validateIdentity({ ...signed, active: true }, config.issuer);
    const clientId = claims.client_id;
    if (!clientId || typeof clientId !== "string" || clientId.length > 255 || clientId === coreClient ||
        clientId !== signed.azp || signed.typ !== "Bearer" || signed.cnf || signed.act || signed.may_act || claims.act ||
        current.subject !== issued.subject || current.tenantId !== issued.tenantId) throw new HttpError(401, "invalid_token");
    return { ...issued, clientId, issuer: config.issuer, signed, expiresAt: Math.min(claims.exp, signed.exp),
      roles: issued.roles.filter(role => current.roles.includes(role)),
      units: issued.units.filter(unit => current.units.includes(unit)),
      groups: issued.groups.filter(group => current.groups.includes(group)) };
  }

  return authorize;
}
