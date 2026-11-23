// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { createHmac, timingSafeEqual } from "node:crypto";
import { HttpError } from "../http/http.mjs";

export const coreClient = "junctura-core";
export const tokenExchangePath = "/v1/token-exchange";
export const delegationDenied = "delegation_not_allowed";
const tokenType = "urn:ietf:params:oauth:token-type:access_token";
const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "junctura-delegation+jwt" })).toString("base64url");

export function tokenClaims(token) {
  try { return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")); }
  catch { throw new HttpError(401, "invalid_token"); }
}

export function delegationTokens(config) {
  const key = createHmac("sha256", config.clientSecret).update("junctura-core/delegation/v1").digest();
  const issuer = `${config.issuer}/junctura-core-delegation`;
  const signature = input => createHmac("sha256", key).update(input).digest("base64url");
  return {
    issue(claims) {
      const input = `${header}.${Buffer.from(JSON.stringify({ ...claims, iss: issuer, aud: coreClient })).toString("base64url")}`;
      return `${input}.${signature(input)}`;
    },
    read(token) {
      if (!token.startsWith(`${header}.`)) return;
      const parts = token.split(".");
      const expected = signature(`${parts[0]}.${parts[1]}`);
      if (parts.length !== 3 || parts[2].length !== expected.length ||
          !timingSafeEqual(Buffer.from(expected), Buffer.from(parts[2]))) throw new HttpError(401, "invalid_token");
      const claims = tokenClaims(token);
      if (claims.iss !== issuer || claims.aud !== coreClient || !Number.isFinite(claims.exp) || claims.exp <= Date.now() / 1000) {
        throw new HttpError(401, "invalid_token");
      }
      return claims;
    },
  };
}

export async function exchangeProviderToken(config, fetcher, subjectToken) {
  const result = await fetcher(`${config.identityUrl}/protocol/openid-connect/token`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(3000),
    body: new URLSearchParams({ client_id: coreClient, client_secret: config.clientSecret,
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange", subject_token: subjectToken,
      subject_token_type: tokenType, requested_token_type: tokenType, audience: coreClient }),
  });
  if (result.status === 400 || result.status === 403) throw new HttpError(403, delegationDenied);
  if (!result.ok) throw new HttpError(503, "identity_unavailable");
  const body = await result.json();
  if (body.issued_token_type !== tokenType || typeof body.access_token !== "string" || body.refresh_token) {
    throw new HttpError(503, "identity_unavailable");
  }
  return body.access_token;
}
