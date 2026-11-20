// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { api } from "./apiClient";

export const OIDC_CLIENT_ID = "junctura-console";
export const OIDC_REALM_PATH = "/identity/realms/junctura/protocol/openid-connect";
export const OIDC_SESSION_KEY = "junctura_oidc_session";
export const OIDC_ERROR_KEY = "junctura_oidc_error";
export const SESSION_EXPIRED_KEY = "junctura_session_expired";

// Renew the access token shortly before it expires so a reader session never
// dies in the middle of a page load.
const RENEW_BEFORE_MS = 30_000;
const DEFAULT_TOKEN_TTL_MS = 5 * 60_000;

export type OidcErrorCode =
  | "state_mismatch"
  | "sso_not_configured"
  | "sso_failed";

export type OidcCallbackResult =
  | { status: "none" }
  | { status: "success" }
  | { status: "error"; error: OidcErrorCode };

export type PasswordSignInErrorCode = "invalid_credentials" | "login_failed";

export class PasswordSignInError extends Error {
  code: PasswordSignInErrorCode;

  constructor(code: PasswordSignInErrorCode) {
    super(code);
    this.name = "PasswordSignInError";
    this.code = code;
  }
}

interface OidcSession {
  verifier: string;
  state: string;
  nonce: string;
  redirectUri: string;
}

let pendingOidcError: OidcErrorCode | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshInFlight: Promise<boolean> | null = null;

// The refresh token outlives the access token, so it must never touch web
// storage: a single XSS bug would otherwise be able to read it. It lives only
// in this module variable and is dropped on reload, which is an accepted
// trade-off — the user signs in again after a page refresh.
let refreshToken: string | null = null;

function storeRefreshToken(value: string | null): void {
  refreshToken = value;
}

// Older builds kept the refresh token in sessionStorage under this key; wipe
// any leftover on startup so data written by a previous version cannot linger.
const LEGACY_REFRESH_KEY = "junctura_oidc_refresh";

export function removeLegacyRefreshToken(): void {
  try {
    sessionStorage.removeItem(LEGACY_REFRESH_KEY);
  } catch {
    // Nothing to clean when storage is unavailable.
  }
}

removeLegacyRefreshToken();

export function getSessionExpired(): boolean {
  try {
    return sessionStorage.getItem(SESSION_EXPIRED_KEY) === "1";
  } catch {
    return false;
  }
}

function setSessionExpired(expired: boolean): void {
  try {
    if (expired) {
      sessionStorage.setItem(SESSION_EXPIRED_KEY, "1");
    } else {
      sessionStorage.removeItem(SESSION_EXPIRED_KEY);
    }
  } catch {
    // Without storage the flag only affects the current page lifecycle.
  }
}

function tokenExpiryMs(token: string): number | null {
  const claims = decodeJwtPayload(token);
  const exp = claims?.exp;
  return typeof exp === "number" && Number.isFinite(exp)
    ? exp * 1000
    : null;
}

function cancelRenewal(): void {
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

// Clears the renewal timer and any stored refresh/expired state. Used on
// sign-out and to keep tests isolated.
export function clearSessionState(): void {
  cancelRenewal();
  refreshInFlight = null;
  storeRefreshToken(null);
  setSessionExpired(false);
}

// Renews before the earlier of the access token's expiry and the refresh token's
// (Keycloak's SSO idle timeout is often shorter than the access token lifetime).
function scheduleRenewal(token: string, refreshExpiresInSeconds?: number): void {
  cancelRenewal();
  let expiry = tokenExpiryMs(token) ?? Date.now() + DEFAULT_TOKEN_TTL_MS;
  if (typeof refreshExpiresInSeconds === "number" && Number.isFinite(refreshExpiresInSeconds) && refreshExpiresInSeconds > 0) {
    expiry = Math.min(expiry, Date.now() + refreshExpiresInSeconds * 1000);
  }
  const delay = Math.max(0, expiry - RENEW_BEFORE_MS - Date.now());
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshSession();
  }, delay);
}

function applyTokenResult(payload: Record<string, unknown>): void {
  const accessToken = payload.access_token;
  if (typeof accessToken !== "string") return;
  if (typeof payload.refresh_token === "string" && payload.refresh_token) {
    storeRefreshToken(payload.refresh_token);
  } else if (!refreshToken) {
    storeRefreshToken(null);
  }
  api.setToken(accessToken);
  const refreshExpiresIn = payload.refresh_expires_in;
  scheduleRenewal(accessToken, typeof refreshExpiresIn === "number" ? refreshExpiresIn : undefined);
}

function finishRefreshFailure(): boolean {
  cancelRenewal();
  storeRefreshToken(null);
  api.setToken(null);
  setSessionExpired(true);
  return false;
}

// Renews the access token with the stored refresh token. Concurrent callers
// share one in-flight request; a failure ends the session and sends the user
// back to the login screen with the "session expired" notice.
export async function refreshSession(): Promise<boolean> {
  if (!refreshToken) return false;
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const stored = refreshToken;
    try {
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        client_id: OIDC_CLIENT_ID,
        refresh_token: stored,
      });
      let response: Response;
      try {
        response = await fetch(`${gatewayOrigin()}${OIDC_REALM_PATH}/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
          signal: AbortSignal.timeout(15000),
        });
      } catch {
        return finishRefreshFailure();
      }
      if (!response.ok) return finishRefreshFailure();
      const payload: unknown = await response.json().catch(() => null);
      if (!isRecord(payload) || typeof payload.access_token !== "string") {
        return finishRefreshFailure();
      }
      setSessionExpired(false);
      applyTokenResult(payload);
      return true;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function randomToken(byteLength = 32): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export function createCodeVerifier(): string {
  return randomToken(32);
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier)
  );
  return base64UrlEncode(new Uint8Array(digest));
}

function gatewayOrigin(): string {
  const base = api.getBaseUrl();
  if (base.startsWith("http://") || base.startsWith("https://")) {
    try {
      return new URL(base).origin;
    } catch {
      return window.location.origin;
    }
  }
  return window.location.origin;
}

function redirectUri(): string {
  return `${window.location.origin}/`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function readSession(): OidcSession | null {
  try {
    const raw = sessionStorage.getItem(OIDC_SESSION_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    const { verifier, state, nonce, redirectUri: storedRedirect } = parsed;
    if (
      typeof verifier !== "string" ||
      typeof state !== "string" ||
      typeof nonce !== "string" ||
      typeof storedRedirect !== "string"
    ) {
      return null;
    }
    return { verifier, state, nonce, redirectUri: storedRedirect };
  } catch {
    return null;
  }
}

function writeSession(session: OidcSession | null): void {
  try {
    if (session) {
      sessionStorage.setItem(OIDC_SESSION_KEY, JSON.stringify(session));
    } else {
      sessionStorage.removeItem(OIDC_SESSION_KEY);
    }
  } catch {
    // sessionStorage can be unavailable in private mode.
  }
}

function clearAuthQuery(): void {
  const url = new URL(window.location.href);
  for (const key of [
    "code",
    "state",
    "session_state",
    "error",
    "error_description",
  ]) {
    url.searchParams.delete(key);
  }
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

export function setOidcError(code: OidcErrorCode | null): void {
  pendingOidcError = code;
  try {
    if (code) {
      sessionStorage.setItem(OIDC_ERROR_KEY, code);
    } else {
      sessionStorage.removeItem(OIDC_ERROR_KEY);
    }
  } catch {
    // The in-memory value still covers the current page lifecycle.
  }
}

export function getOidcError(): OidcErrorCode | null {
  if (pendingOidcError) return pendingOidcError;
  try {
    const raw = sessionStorage.getItem(OIDC_ERROR_KEY);
    if (raw === "state_mismatch" || raw === "sso_not_configured" || raw === "sso_failed") {
      return raw;
    }
  } catch {
    return null;
  }
  return null;
}

export function clearOidcError(): void {
  setOidcError(null);
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "="
  );
  try {
    const parsed: unknown = JSON.parse(atob(padded));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function finishWithError(error: OidcErrorCode): OidcCallbackResult {
  writeSession(null);
  setOidcError(error);
  clearAuthQuery();
  return { status: "error", error };
}

export async function startLogin(loginHint?: string): Promise<void> {
  clearOidcError();
  const verifier = createCodeVerifier();
  const challenge = await pkceChallenge(verifier);
  const state = randomToken(24);
  const nonce = randomToken(24);
  const callback = redirectUri();
  writeSession({ verifier, state, nonce, redirectUri: callback });

  const url = new URL(`${gatewayOrigin()}${OIDC_REALM_PATH}/auth`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", OIDC_CLIENT_ID);
  url.searchParams.set("redirect_uri", callback);
  url.searchParams.set("scope", "openid profile");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (loginHint?.trim()) url.searchParams.set("login_hint", loginHint.trim());
  window.location.assign(url.toString());
}

export async function signInWithPassword(
  username: string,
  password: string
): Promise<void> {
  const body = new URLSearchParams({
    grant_type: "password",
    client_id: OIDC_CLIENT_ID,
    username,
    password,
    scope: "openid",
  });

  let response: Response;
  try {
    response = await fetch(`${gatewayOrigin()}${OIDC_REALM_PATH}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new PasswordSignInError("login_failed");
  }

  if (response.status === 401) {
    throw new PasswordSignInError("invalid_credentials");
  }
  if (!response.ok) {
    throw new PasswordSignInError("login_failed");
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!isRecord(payload) || typeof payload.access_token !== "string") {
    throw new PasswordSignInError("login_failed");
  }

  writeSession(null);
  clearOidcError();
  setSessionExpired(false);
  applyTokenResult(payload);
}

export async function handleCallback(): Promise<OidcCallbackResult> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const returnedState = params.get("state");
  const authError = params.get("error");
  if (!code && !returnedState && !authError) return { status: "none" };

  const session = readSession();
  if (authError) return finishWithError("sso_failed");
  if (!code || !returnedState || !session || session.state !== returnedState) {
    return finishWithError("state_mismatch");
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: session.redirectUri,
    client_id: OIDC_CLIENT_ID,
    code_verifier: session.verifier,
  });

  let response: Response;
  try {
    response = await fetch(`${gatewayOrigin()}${OIDC_REALM_PATH}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return finishWithError("sso_failed");
  }

  if (!response.ok) {
    return finishWithError(
      response.status === 400 || response.status === 401 || response.status === 404
        ? "sso_not_configured"
        : "sso_failed"
    );
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!isRecord(payload) || typeof payload.access_token !== "string") {
    return finishWithError("sso_failed");
  }

  if (typeof payload.id_token === "string") {
    const claims = decodeJwtPayload(payload.id_token);
    if (claims && typeof claims.nonce === "string" && claims.nonce !== session.nonce) {
      return finishWithError("state_mismatch");
    }
  }

  writeSession(null);
  clearOidcError();
  setSessionExpired(false);
  clearAuthQuery();
  applyTokenResult(payload);
  return { status: "success" };
}

export function startLogout(): void {
  const url = new URL(`${gatewayOrigin()}${OIDC_REALM_PATH}/logout`);
  url.searchParams.set("client_id", OIDC_CLIENT_ID);
  url.searchParams.set("post_logout_redirect_uri", redirectUri());
  writeSession(null);
  setOidcError(null);
  setSessionExpired(false);
  clearSessionState();
  window.location.assign(url.toString());
}

api.setRefreshHandler(refreshSession);
