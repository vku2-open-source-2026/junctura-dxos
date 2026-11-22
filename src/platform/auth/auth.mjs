// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { HttpError } from "../http/http.mjs";

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
  if (typeof claims.tenant_id !== "string" || !/^[a-z][a-z0-9-]{0,62}$/.test(claims.tenant_id) ||
      !Array.isArray(claims.tenant_memberships) || !claims.tenant_memberships.includes(claims.tenant_id)) {
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
    roles: roles.filter((role) => ["core-reader", "core-writer"].includes(role)),
    ...organizationContext(claims.groups, claims.tenant_id),
    ...(subjectId ? { subjectId } : {}),
    ...(preferredUsername ? { preferredUsername } : {}) };
}

export function createAuthorizer(config, fetcher = fetch) {
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
      const identity = validateIdentity(claims, config.issuer);
      return withContext ? { ...identity, issuer: config.issuer,
        clientId: typeof claims.client_id === "string" && claims.client_id.length <= 255 ? claims.client_id : undefined,
        credentialExpiresAt: claims.exp * 1000 } : identity;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, "identity_unavailable");
    }
  };
}
