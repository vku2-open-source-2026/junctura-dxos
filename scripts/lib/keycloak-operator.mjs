// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { setTimeout as delay } from "node:timers/promises";

const oauthErrors = new Set(["invalid_grant", "invalid_client", "invalid_request",
  "unauthorized_client", "unsupported_grant_type", "access_denied"]);

export async function keycloakOperatorToken(base, password = process.env.KEYCLOAK_ADMIN_PASSWORD) {
  if (!password) throw new Error("KEYCLOAK_ADMIN_PASSWORD is required for Keycloak operator login");

  return keycloakToken(base, "master", "operator", {
    grant_type: "password", client_id: "admin-cli", username: "junctura-admin", password,
  });
}

export async function keycloakAppSyncToken(base, env = process.env) {
  const secret = env.APP_SYNC_CLIENT_SECRET?.trim();
  if (!secret) throw new Error("APP_SYNC_CLIENT_SECRET is required for Keycloak application sync login");

  return keycloakToken(base, "junctura", "application sync", {
    grant_type: "client_credentials", client_id: env.APP_SYNC_CLIENT_ID || "junctura-app-sync", client_secret: secret,
  });
}

async function keycloakToken(base, realm, account, fields) {
  const endpoint = new URL(`${base}/identity/realms/${realm}/protocol/openid-connect/token`);
  const login = `Keycloak ${account} login at ${endpoint.origin}`;
  const body = new URLSearchParams(fields);
  const deadline = Date.now() + 30_000;
  let failure;
  do {
    const response = await fetch(endpoint, { method: "POST", body, redirect: "manual",
      signal: AbortSignal.timeout(Math.min(5_000, Math.max(1, deadline - Date.now()))) }).catch(() => null);
    if (response?.status === 200) {
      const result = await response.json().catch(() => null);
      if (typeof result?.access_token === "string" && result.access_token) return result.access_token;
      throw new Error(`${login} returned no access token`);
    }
    if (response && response.status < 500) {
      const result = await response.json().catch(() => null);
      const oauthError = oauthErrors.has(result?.error) ? result.error : undefined;
      const code = oauthError ? `, ${oauthError}` : "";
      throw Object.assign(new Error(`${login} failed (HTTP ${response.status}${code})`),
        { status: response.status, oauthError });
    }
    await response?.body?.cancel().catch(() => {});
    failure = response ? `HTTP ${response.status}` : "gateway unreachable";
    await delay(Math.min(500, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw new Error(`${login} did not recover (${failure})`);
}
