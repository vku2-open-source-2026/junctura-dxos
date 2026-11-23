// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "../App";
import type { TrustGraph } from "../types";
import { api } from "../services/apiClient";
import {
  clearSessionState,
  getSessionExpired,
  refreshSession,
  removeLegacyRefreshToken,
  signInWithPassword,
} from "../services/oidc";
import { I18nProvider } from "../locales/i18n";
import { TrustGraphView } from "../components/explainers/TrustGraphView";
import { TRUST_GRAPH_STRINGS } from "../components/explainers/trustGraph.i18n";
import { vi as viStrings } from "../locales/vi";
import { installApiFetch, json, TEST_IDENTITY } from "./apiMock";

const READER_IDENTITY = {
  subject: "readonly-viewer",
  tenantId: "tenant-test",
  roles: ["core-reader"],
};

const APP_FIXTURE = {
  appId: "11111111-1111-1111-1111-111111111111",
  tenantId: "tenant-test",
  ownerSubject: "owner-subject",
  displayName: "Ứng dụng đọc",
  oauthClientId: "reading-client",
  providerOrigin: "https://provider.example.com",
  state: "pending",
  revision: 3,
  digest: "digest-1",
  createdAt: "2026-11-10T00:00:00.000Z",
  updatedAt: "2026-11-10T00:00:00.000Z",
};

const PENDING_GRAPH = {
  scope: "tenant" as const,
  nodes: [
    {
      appId: APP_FIXTURE.appId,
      displayName: APP_FIXTURE.displayName,
      state: "pending",
      owned: false,
    },
  ],
  edges: [],
  truncated: false,
  generatedAt: "2026-11-10T00:00:00.000Z",
};

const READONLY_GRAPH: TrustGraph = {
  scope: "tenant",
  nodes: [
    { appId: "app-a", displayName: "Nhà cung cấp", state: "active", owned: false },
    { appId: "app-b", displayName: "Bên nhận", state: "active", owned: false },
  ],
  edges: [
    {
      grantId: "grant-1",
      providerAppId: "app-a",
      consumerAppId: "app-b",
      capabilityId: "cap-1",
      version: "1.0.0",
      title: "Tra cứu",
      operations: ["invoke"],
      revision: 1,
      state: "active",
      createdAt: "2026-11-01T00:00:00.000Z",
      activatedAt: "2026-11-02T00:00:00.000Z",
      revokedAt: null,
      expiresAt: "2027-11-02T00:00:00.000Z",
    },
  ],
  truncated: false,
  generatedAt: "2026-11-10T00:00:00.000Z",
  readOnly: true,
};

function resetState() {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  api.setBaseUrl("/api");
  api.setToken(null);
}

function tokenResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function openScreen(hash: string, heading: string) {
  window.history.replaceState(null, "", "/#/dashboard");
  render(<App />);
  await screen.findByRole("heading", {
    level: 1,
    name: viStrings.dashboard.title,
  });
  window.location.hash = `#/${hash}`;
  fireEvent(window, new HashChangeEvent("hashchange"));
  await screen.findByRole("heading", { level: 1, name: heading });
}

const REFRESH_KEY = "junctura_oidc_refresh";

function storageContains(storage: Storage, needle: string): boolean {
  for (let index = 0; index < storage.length; index += 1) {
    const value = storage.getItem(storage.key(index) ?? "");
    if (value !== null && value.includes(needle)) return true;
  }
  return false;
}

describe("Task 56b — session renewal", () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearSessionState();
    api.setToken(null);
    sessionStorage.clear();
  });

  async function signInFixture(refreshToken?: string) {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          tokenResponse(200, {
            access_token: "fixture-access",
            ...(refreshToken ? { refresh_token: refreshToken } : {}),
          })
        )
      )
    );
    await signInWithPassword("operator", "fixture-secret");
  }

  it("keeps the refresh token out of web storage after sign-in", async () => {
    await signInFixture("fixture-refresh");

    expect(api.getToken()).toBe("fixture-access");
    expect(sessionStorage.getItem(REFRESH_KEY)).toBeNull();
    expect(localStorage.getItem(REFRESH_KEY)).toBeNull();
    expect(storageContains(sessionStorage, "fixture-refresh")).toBe(false);
    expect(storageContains(localStorage, "fixture-refresh")).toBe(false);
  });

  it("wipes a leftover legacy refresh key on startup", () => {
    sessionStorage.setItem(REFRESH_KEY, "stale-refresh");
    removeLegacyRefreshToken();
    expect(sessionStorage.getItem(REFRESH_KEY)).toBeNull();
  });

  it("renews the access token with the in-memory refresh token", async () => {
    await signInFixture("stored-refresh");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          Promise.resolve(
            tokenResponse(200, {
              access_token: "fresh-access",
              refresh_token: "rotated-refresh",
            })
          ) as Promise<Response>
      )
    );

    await expect(refreshSession()).resolves.toBe(true);

    expect(api.getToken()).toBe("fresh-access");
    expect(storageContains(sessionStorage, "rotated-refresh")).toBe(false);
    expect(storageContains(localStorage, "rotated-refresh")).toBe(false);
    expect(storageContains(sessionStorage, "stored-refresh")).toBe(false);
    const [, init] = vi.mocked(fetch).mock.calls[0];
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("stored-refresh");
  });

  it("renews before the refresh token expires when it outlives the access token less", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve(
            tokenResponse(200, {
              access_token: [
                "eyJhbGciOiJub25lIn0",
                btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))
                  .replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"),
                "sig",
              ].join("."),
              refresh_token: "short-refresh",
              expires_in: 3600,
              refresh_expires_in: 1800,
            })
          )
        )
      );
      await signInWithPassword("operator", "fixture-secret");
      vi.mocked(fetch).mockClear();
      await vi.advanceTimersByTimeAsync(1800 * 1000 - 31_000);
      expect(fetch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(fetch).toHaveBeenCalledTimes(1);
      const [, init] = vi.mocked(fetch).mock.calls[0];
      expect(new URLSearchParams(String(init?.body)).get("grant_type")).toBe("refresh_token");
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces concurrent renewals into a single request", async () => {
    await signInFixture("stored-refresh");
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        calls += 1;
        return new Promise(
          (resolve) =>
            setTimeout(
              () =>
                resolve(
                  tokenResponse(200, {
                    access_token: "fresh-access",
                    refresh_token: "rotated-refresh",
                  })
                ),
              20
            ) as unknown as Promise<Response>
        );
      })
    );

    const results = await Promise.all([
      refreshSession(),
      refreshSession(),
      refreshSession(),
    ]);

    expect(results).toEqual([true, true, true]);
    expect(calls).toBe(1);
  });

  it("ends the session when the refresh token is rejected", async () => {
    await signInFixture("stored-refresh");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(tokenResponse(400, { error: "invalid_grant" })))
    );

    await expect(refreshSession()).resolves.toBe(false);

    expect(api.getToken()).toBeNull();
    expect(getSessionExpired()).toBe(true);
    expect(storageContains(sessionStorage, "stored-refresh")).toBe(false);
    expect(storageContains(localStorage, "stored-refresh")).toBe(false);
  });

  it("retries an API call once after a 401 and renews the token", async () => {
    await signInFixture("stored-refresh");
    let identityCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/identity/realms/junctura/protocol/openid-connect/token")) {
        return tokenResponse(200, { access_token: "fresh-access" });
      }
      if (url.includes("/v1/identity")) {
        identityCalls += 1;
        return identityCalls === 1
          ? json(401, { error: "token_expired" })
          : json(200, TEST_IDENTITY);
      }
      return json(200, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    const identity = await api.getIdentity();

    expect(identity.status).toBe("authenticated");
    expect(api.getToken()).toBe("fresh-access");
    expect(identityCalls).toBe(2);
  });
});

describe("Task 56b — read-only console", () => {
  beforeEach(() => {
    resetState();
    installApiFetch([
      (url) =>
        url.includes("/v1/identity") ? json(200, READER_IDENTITY) : undefined,
      (url) =>
        url.includes("/v1/trust/graph") ? json(200, PENDING_GRAPH) : undefined,
      (url) =>
        url.includes("/v1/applications?") ? json(200, { items: [APP_FIXTURE], nextCursor: null }) : undefined,
      (url) =>
        url.endsWith(`/v1/applications/${APP_FIXTURE.appId}`)
          ? json(200, APP_FIXTURE)
          : undefined,
    ]);
    api.setToken("test-token");
  });

  afterEach(() => {
    resetState();
  });

  it("shows the read-only banner in the app frame", async () => {
    await openScreen("dashboard", viStrings.dashboard.title);
    expect(screen.getByTestId("readonly-banner")).toBeInTheDocument();
    expect(
      screen.getByText(viStrings.session.readOnlyBanner)
    ).toBeInTheDocument();
  });

  it("renders the application detail without any write buttons", async () => {
    await openScreen("apps", viStrings.applications.title);
    fireEvent.click(
      await screen.findByRole("button", { name: APP_FIXTURE.displayName })
    );
    expect(
      await screen.findByText(viStrings.common.readOnlyAction)
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: viStrings.applications.approveBtn })
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: viStrings.applications.rejectBtn })
    ).toBeNull();

    window.location.hash = `#/apps/${APP_FIXTURE.appId}?tab=settings`;
    fireEvent(window, new HashChangeEvent("hashchange"));
    expect(
      await screen.findByText(viStrings.applications.pendingDesc)
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: viStrings.applications.actionRevoke,
      })
    ).toBeNull();
  });

  it("renders the queue without decision buttons", async () => {
    await openScreen("queue", viStrings.queue.title);
    fireEvent.click(
      await screen.findByRole("button", {
        name: `${viStrings.queue.openDetail}: ${APP_FIXTURE.displayName}`,
      })
    );
    expect(
      await screen.findByText(viStrings.queue.noPermissionTitle)
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: viStrings.queue.approve })
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: viStrings.queue.reject })
    ).toBeNull();
  });

  it("shows the friendly 403 state instead of an error on the ecosystem screen", async () => {
    installApiFetch([
      (url) =>
        url.includes("/v1/identity") ? json(200, READER_IDENTITY) : undefined,
      (url) =>
        url.includes("/v1/applications/stats")
          ? json(403, { error: "forbidden" })
          : undefined,
    ]);
    await openScreen("ecosystem", viStrings.ecosystem.title);
    expect(
      await screen.findByText(viStrings.common.forbiddenView)
    ).toBeInTheDocument();
    expect(screen.queryByText(viStrings.ecosystem.loadErrorTitle)).toBeNull();
  });
});

describe("Task 56b — trust graph readOnly", () => {
  const renderView = (graph: typeof READONLY_GRAPH) =>
    render(
      <I18nProvider>
        <TrustGraphView graph={graph} canRevoke={true} onRevoke={vi.fn()} />
      </I18nProvider>
    );

  it("hides the revoke action when the graph is readOnly", async () => {
    const s = TRUST_GRAPH_STRINGS.vi;
    renderView(READONLY_GRAPH);
    fireEvent.click(await screen.findByTestId("tg-edge-grant-1"));
    await screen.findByText(s.edgeCard);
    expect(screen.queryByRole("button", { name: s.revoke })).toBeNull();
  });

  it("keeps the revoke action when the graph is not readOnly", async () => {
    const s = TRUST_GRAPH_STRINGS.vi;
    const graph = { ...READONLY_GRAPH, readOnly: undefined };
    renderView(graph);
    fireEvent.click(await screen.findByTestId("tg-edge-grant-1"));
    await screen.findByText(s.edgeCard);
    expect(
      await screen.findByRole("button", { name: s.revoke })
    ).toBeInTheDocument();
  });
});
