// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../services/apiClient";
import {
  OIDC_SESSION_KEY,
  clearOidcError,
  getOidcError,
  handleCallback,
  pkceChallenge,
  signInWithPassword,
} from "../services/oidc";

function tokenResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

describe("OIDC PKCE helpers", () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.history.replaceState(null, "", "/");
    api.setToken(null);
    clearOidcError();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
    api.setToken(null);
    clearOidcError();
  });

  it("matches the RFC 7636 S256 challenge vector", async () => {
    await expect(pkceChallenge(RFC_VERIFIER)).resolves.toBe(RFC_CHALLENGE);
  });

  it("rejects a callback whose state does not match the stored request", async () => {
    sessionStorage.setItem(
      OIDC_SESSION_KEY,
      JSON.stringify({
        verifier: RFC_VERIFIER,
        state: "expected-state",
        nonce: "expected-nonce",
        redirectUri: "http://localhost/",
      })
    );
    window.history.replaceState(
      null,
      "",
      "/?code=authorization-code&state=attacker-state"
    );

    const result = await handleCallback();

    expect(result).toEqual({ status: "error", error: "state_mismatch" });
    expect(getOidcError()).toBe("state_mismatch");
    expect(api.getToken()).toBeNull();
    expect(window.location.search).toBe("");
    expect(sessionStorage.getItem(OIDC_SESSION_KEY)).toBeNull();
  });

  it("signs in with the password grant and stores the access token", async () => {
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit) =>
        Promise.resolve(tokenResponse(200, { access_token: "fixture-token" }))
    );
    vi.stubGlobal("fetch", fetchMock);

    await signInWithPassword("operator", "fixture-secret");

    expect(api.getToken()).toBe("fixture-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      `${window.location.origin}/identity/realms/junctura/protocol/openid-connect/token`
    );
    const body = new URLSearchParams(String((init as RequestInit).body));
    expect(body.get("grant_type")).toBe("password");
    expect(body.get("client_id")).toBe("junctura-console");
    expect(body.get("scope")).toBe("openid");
    expect(body.get("username")).toBe("operator");
    expect(body.get("password")).toBe("fixture-secret");
  });

  it("maps a 401 token response to invalid credentials", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(tokenResponse(401, { error: "invalid_grant" }))
      )
    );

    await expect(
      signInWithPassword("operator", "wrong-fixture")
    ).rejects.toMatchObject({
      code: "invalid_credentials",
    });
    expect(api.getToken()).toBeNull();
  });
});
