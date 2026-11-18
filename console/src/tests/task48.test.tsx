// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import App from "../App";
import { api } from "../services/apiClient";
import { vi as viStrings } from "../locales/vi";
import { en as enStrings } from "../locales/en";
import { installApiFetch, json } from "./apiMock";

function resetState() {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  api.setBaseUrl("/api");
  api.setToken("test-token");
}

function identity(tenantId: string) {
  return {
    subject: "test-operator",
    tenantId,
    roles: ["core-reader"],
  };
}

function statsFixture() {
  return {
    generatedAt: "2026-11-17T10:00:00.000Z",
    totals: {
      applications: 11,
      activeApplications: 9,
      activeLast24h: 7,
      activeLast7d: 8,
      activeConnections: 13,
    },
    applications: [
      {
        id: "app-eco-1",
        name: "Ứng dụng sinh thái",
        state: "active",
        registeredAt: "2026-11-01T00:00:00.000Z",
        lastActivityAt: "2026-11-17T09:30:00.000Z",
        calls: {
          outgoing: { last24h: 101, last7d: 202 },
          incoming: { last24h: 303, last7d: 404 },
        },
        capabilities: { published: 55 },
        connections: { given: 6, received: 4 },
        data: { collections: 3, records: 777 },
        files: { count: 12, bytes: 2048 },
      },
    ],
  };
}

async function renderDashboard() {
  window.history.replaceState(null, "", "/#/dashboard");
  render(<App />);
  await screen.findByRole("heading", {
    level: 1,
    name: viStrings.dashboard.title,
  });
}

async function openEcosystem() {
  await renderDashboard();
  window.location.hash = "#/ecosystem";
  fireEvent(window, new HashChangeEvent("hashchange"));
  await screen.findByRole("heading", {
    level: 1,
    name: viStrings.ecosystem.title,
  });
}

function keysOf(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return [path, ...keysOf(child, path)];
  });
}

describe("Task 48 — environment banner", () => {
  beforeEach(resetState);

  it("shows the demo message for the demo tenant", async () => {
    installApiFetch([
      (url) =>
        url.includes("/v1/identity") ? json(200, identity("demo")) : undefined,
    ]);
    await renderDashboard();
    expect(screen.getByRole("note")).toHaveTextContent(
      viStrings.environment.demo
    );
  });

  it("shows the production message for the production tenant", async () => {
    installApiFetch([
      (url) =>
        url.includes("/v1/identity")
          ? json(200, identity("production"))
          : undefined,
    ]);
    await renderDashboard();
    expect(screen.getByRole("note")).toHaveTextContent(
      viStrings.environment.production
    );
  });

  it("shows only the tenant name for any other tenant", async () => {
    installApiFetch([
      (url) =>
        url.includes("/v1/identity")
          ? json(200, identity("tenant-alpha"))
          : undefined,
    ]);
    await renderDashboard();
    const banner = screen.getByRole("note");
    expect(banner).toHaveTextContent("Tenant: tenant-alpha");
    expect(banner).not.toHaveTextContent("Môi trường");
  });

  it("renders nothing without a signed-in user", async () => {
    api.setToken(null);
    installApiFetch();
    window.history.replaceState(null, "", "/#/dashboard");
    render(<App />);
    expect(screen.queryByRole("note")).toBeNull();
  });
});

describe("Task 48 — ecosystem screen", () => {
  beforeEach(resetState);

  it("renders totals and a row from the API payload", async () => {
    installApiFetch([
      (url) =>
        url.includes("/v1/applications/stats")
          ? json(200, statsFixture())
          : undefined,
    ]);
    await openEcosystem();

    expect(screen.getByText("11")).toBeInTheDocument();
    expect(screen.getByText("13")).toBeInTheDocument();
    const name = screen.getByText("Ứng dụng sinh thái");
    expect(name).toBeInTheDocument();
    const row = name.closest("tr");
    expect(row).not.toBeNull();
    if (row) {
      expect(
        within(row).getByText(viStrings.applications.stateActive)
      ).toBeInTheDocument();
      expect(within(row).getByText("101")).toBeInTheDocument();
      expect(within(row).getByText("404")).toBeInTheDocument();
      expect(within(row).getByText("777")).toBeInTheDocument();
      expect(within(row).getByText(/6 \/ 4/)).toBeInTheDocument();
      expect(within(row).getByText("12 · 2 KB")).toBeInTheDocument();
    }
  });

  it("shows an error state without payload numbers", async () => {
    installApiFetch([
      (url) =>
        url.includes("/v1/applications/stats")
          ? json(503, { error: "application_stats_unavailable" })
          : undefined,
    ]);
    await openEcosystem();

    expect(
      await screen.findByText(viStrings.ecosystem.loadErrorTitle)
    ).toBeInTheDocument();
    expect(screen.queryByText("11")).toBeNull();
    expect(screen.queryByText("101")).toBeNull();
  });

  it("shows an empty state when no application is registered", async () => {
    installApiFetch([
      (url) =>
        url.includes("/v1/applications/stats")
          ? json(200, {
              generatedAt: "2026-11-17T10:00:00.000Z",
              totals: {
                applications: 0,
                activeApplications: 0,
                activeLast24h: 0,
                activeLast7d: 0,
                activeConnections: 0,
              },
              applications: [],
            })
          : undefined,
    ]);
    await openEcosystem();

    expect(
      await screen.findByText(viStrings.ecosystem.emptyTitle)
    ).toBeInTheDocument();
  });

  it("navigates from a row to the existing app detail", async () => {
    installApiFetch([
      (url) =>
        url.includes("/v1/applications/stats")
          ? json(200, statsFixture())
          : undefined,
    ]);
    await openEcosystem();

    const link = screen.getByRole("button", {
      name: viStrings.ecosystem.openApp.replace(
        "{name}",
        "Ứng dụng sinh thái"
      ),
    });
    fireEvent.click(link);
    expect(window.location.hash).toBe("#/apps/app-eco-1");
  });
});

describe("Task 48 — application stats client", () => {
  beforeEach(resetState);

  it("calls the stats route and rejects a malformed payload instead of inventing numbers", async () => {
    const fetchMock = installApiFetch([
      (url) =>
        url.includes("/v1/applications/stats")
          ? json(200, {
              totals: {
                applications: "11",
                activeApplications: 4,
                activeLast24h: null,
              },
              applications: [
                {
                  id: "app-a",
                  name: "App A",
                  state: "active",
                  calls: {
                    outgoing: { last24h: "many", last7d: -2 },
                    incoming: { last24h: 0, last7d: undefined },
                  },
                  capabilities: { published: "3" },
                  files: { count: "4", bytes: 5 },
                },
                null,
                { id: "missing-name" },
              ],
            })
          : undefined,
    ]);

    await expect(api.getApplicationStats()).rejects.toMatchObject({
      status: 503,
      code: "application_stats_unavailable",
    });
    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls.some((url) => url.includes("/v1/applications/stats"))).toBe(
      true
    );
  });

  it("rejects a non-object payload", async () => {
    installApiFetch([
      (url) =>
        url.includes("/v1/applications/stats") ? json(200, null) : undefined,
    ]);
    await expect(api.getApplicationStats()).rejects.toMatchObject({
      status: 503,
    });
  });
});

describe("Task 48 — locale parity", () => {
  it("uses the same keys for the new sections in vi and en", () => {
    for (const section of ["environment", "ecosystem"] as const) {
      expect(keysOf(viStrings[section]).sort()).toEqual(
        keysOf(enStrings[section]).sort()
      );
    }
    expect(keysOf(viStrings.modules.ecosystem).sort()).toEqual(
      keysOf(enStrings.modules.ecosystem).sort()
    );
  });
});
