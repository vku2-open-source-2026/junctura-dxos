// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { api } from "./apiClient";

export const OIDC_CLIENT_ID = "junctura-console";
export const OIDC_REALM_PATH = "/identity/realms/junctura/protocol/openid-connect";
export const OIDC_SESSION_KEY = "junctura_oidc_session";
export const OIDC_ERROR_KEY = "junctura_oidc_error";

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
  api.setToken(payload.access_token);
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
  clearAuthQuery();
  api.setToken(payload.access_token);
  return { status: "success" };
}

export function startLogout(): void {
  const url = new URL(`${gatewayOrigin()}${OIDC_REALM_PATH}/logout`);
  url.searchParams.set("client_id", OIDC_CLIENT_ID);
  url.searchParams.set("post_logout_redirect_uri", redirectUri());
  writeSession(null);
  setOidcError(null);
  window.location.assign(url.toString());
}
