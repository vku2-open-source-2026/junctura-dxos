// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import App from "../App";
import { api } from "../services/apiClient";
import { vi as viStrings } from "../locales/vi";
import { installApiFetch, json, TEST_IDENTITY } from "./apiMock";

function resetState() {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  api.setBaseUrl("/api");
  api.setToken("test-token");
}

function renderAt(hash: string) {
  window.history.replaceState(null, "", `/#/${hash}`);
  return render(<App />);
}

async function openScreen(hash: string) {
  renderAt("dashboard");
  await screen.findByRole("heading", {
    level: 1,
    name: viStrings.dashboard.title,
  });
  window.location.hash = `#/${hash}`;
  fireEvent(window, new HashChangeEvent("hashchange"));
}

function trafficFixture() {
  const buckets = Array.from({ length: 60 }, (_, index) => ({
    at: new Date(Date.UTC(2026, 10, 10, 0, index)).toISOString(),
    requests: index % 5 === 0 ? 4 : 2,
    errors4xx: index % 5 === 0 ? 1 : 0,
    errors5xx: index === 30 ? 1 : 0,
    avgLatencyMs: 20 + index,
    maxLatencyMs: 40 + index,
  }));
  return {
    from: buckets[0].at,
    to: "2026-11-10T01:00:00.000Z",
    intervalSeconds: 60,
    buckets,
    totals: {
      requests: buckets.reduce((sum, bucket) => sum + bucket.requests, 0),
      errors4xx: buckets.reduce((sum, bucket) => sum + bucket.errors4xx, 0),
      errors5xx: 1,
      avgLatencyMs: 49,
      maxLatencyMs: 99,
    },
  };
}

function recentFixture() {
  return {
    items: [
      {
        at: "2026-11-10T00:59:30.000Z",
        method: "GET",
        path: "/v1/applications",
        status: 200,
        durationMs: 12.4,
      },
      {
        at: "2026-11-10T00:59:00.000Z",
        method: "POST",
        path: "/v1/trust/grants",
        status: 403,
        durationMs: 31,
      },
    ],
  };
}

function directoryFixture() {
  return {
    root: {
      id: "tenant-test",
      name: "tenant-test",
      kind: "platform",
      children: [
        {
          id: "app-1",
          name: "Trạm y tế xã",
          kind: "application",
          children: [],
        },
        {
          id: "app-2",
          name: "Nhà thuốc An Khang",
          kind: "application",
          children: [],
        },
      ],
    },
    relations: [
      { from: "app-1", to: "app-2", label: "chuyển tuyến" },
    ],
    truncated: false,
  };
}

function principalsFixture() {
  return {
    items: [
      {
        subject: "test-operator",
        issuer: "https://issuer.example",
        managementClient: "console",
        permissions: ["applications.write", "audit.read"],
        enabled: true,
        displayName: "Nguyễn Văn A",
        organization: "Bệnh viện Đà Nẵng",
        jobTitle: "Quản trị nền tảng",
        kind: "admin",
      },
      {
        subject: "a-very-long-subject-identifier-123456",
        issuer: "https://issuer.example",
        managementClient: "console",
        permissions: ["trust.approve"],
        enabled: false,
        displayName: null,
        organization: "Nhà thuốc An Khang",
        jobTitle: null,
        kind: "application",
      },
    ],
    truncated: false,
  };
}

describe("Task 34 — flat sidebar", () => {
  beforeEach(resetState);

  it("shows exactly seven top-level items and two footer items", async () => {
    installApiFetch();
    renderAt("dashboard");
    await screen.findByRole("heading", {
      level: 1,
      name: viStrings.dashboard.title,
    });
    const sidebar = screen.getByRole("complementary", {
      name: viStrings.session.navigation,
    });
    const nav = sidebar.querySelector("nav");
    expect(nav).not.toBeNull();
    const labels = within(nav as HTMLElement)
      .getAllByRole("button")
      .map((button) => button.textContent?.trim());
    expect(labels).toEqual([
      viStrings.modules.dashboard.label,
      viStrings.modules.queue.label,
      viStrings.modules.apps.label,
      viStrings.modules.caps.label,
      viStrings.modules.users.label,
      viStrings.modules.orgs.label,
      viStrings.modules.audit.label,
      viStrings.platform.docsApi,
      viStrings.modules.settings.label,
    ]);
  });
});

describe("Task 34 — dashboard tabs and traffic chart", () => {
  beforeEach(resetState);

  it("renders 60 chart points from the traffic fixture", async () => {
    installApiFetch([
      (url) =>
        url.includes("/v1/metrics/traffic")
          ? json(200, trafficFixture())
          : undefined,
      (url) =>
        url.includes("/v1/metrics/requests")
          ? json(200, recentFixture())
          : undefined,
    ]);
    renderAt("dashboard");
    await screen.findByRole("heading", {
      level: 1,
      name: viStrings.dashboard.title,
    });
    await waitFor(() => {
      expect(screen.getAllByTestId("traffic-point")).toHaveLength(60);
    });
  });

  it("navigates from the overview to the traffic and request tabs", async () => {
    installApiFetch([
      (url) =>
        url.includes("/v1/metrics/traffic")
          ? json(200, trafficFixture())
          : undefined,
      (url) =>
        url.includes("/v1/metrics/requests")
          ? json(200, recentFixture())
          : undefined,
    ]);
    renderAt("dashboard");
    await screen.findByRole("heading", {
      level: 1,
      name: viStrings.dashboard.title,
    });
    const tabs = await screen.findByRole("navigation", {
      name: viStrings.pageTabs.label,
    });
    fireEvent.click(
      within(tabs).getByRole("button", {
        name: viStrings.modules.traffic.label,
      })
    );
    await screen.findByRole("heading", {
      level: 1,
      name: viStrings.dashboard.trafficTitle,
    });
    fireEvent.click(
      within(tabs).getByRole("button", {
        name: viStrings.modules.requests.label,
      })
    );
    await screen.findByRole("heading", {
      level: 1,
      name: viStrings.dashboard.logsTitle,
    });
  });

  it("shows a friendly empty state when the core has no requests", async () => {
    installApiFetch();
    renderAt("dashboard");
    await screen.findByRole("heading", {
      level: 1,
      name: viStrings.dashboard.title,
    });
    expect(
      (await screen.findAllByText(viStrings.dashboard.noRequestsTitle)).length
    ).toBeGreaterThan(0);
  });
});

describe("Task 34 — users and organisations from the directory API", () => {
  beforeEach(resetState);

  it("shows display names, organisations and permission details in Vietnamese", async () => {
    installApiFetch([
      (url) =>
        url.includes("/v1/identity")
          ? json(200, { ...TEST_IDENTITY, preferredUsername: "nguyen.van.a" })
          : undefined,
      (url) =>
        url.includes("/v1/directory/principals")
          ? json(200, principalsFixture())
          : undefined,
    ]);
    await openScreen("users");
    await screen.findByRole("heading", {
      level: 1,
      name: viStrings.users.title,
    });
    expect(await screen.findByText("Nguyễn Văn A")).toBeInTheDocument();
    expect(screen.getByText(viStrings.users.self)).toBeInTheDocument();
    expect(screen.getByText(viStrings.users.unnamed)).toBeInTheDocument();
    expect(
      screen.getAllByText("Bệnh viện Đà Nẵng").length
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(viStrings.users.kindAdmin).length
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(viStrings.users.kindApplication).length
    ).toBeGreaterThan(0);
    expect(screen.getByText(viStrings.users.statusDisabled)).toBeInTheDocument();

    fireEvent.click(
      screen.getAllByRole("button", {
        name: viStrings.users.viewPermissions,
      })[0]
    );
    expect(
      await screen.findByText(viStrings.users.permissionGroups.applications)
    ).toBeInTheDocument();
    expect(
      screen.getByText(viStrings.users.permissionGroups.audit)
    ).toBeInTheDocument();
    expect(
      screen.getByText(viStrings.users.permissionNames["applications.write"])
    ).toBeInTheDocument();
  });

  it("shows a permission message when the directory returns 403", async () => {
    installApiFetch([
      (url) =>
        url.includes("/v1/directory/principals")
          ? json(403, { error: "forbidden" })
          : undefined,
    ]);
    await openScreen("users");
    expect(
      await screen.findByText(viStrings.users.permissionDeniedTitle)
    ).toBeInTheDocument();
  });

  it("shows a permission message when organisations return 403", async () => {
    installApiFetch([
      (url) =>
        url.includes("/v1/directory/organizations")
          ? json(403, { error: "forbidden" })
          : undefined,
    ]);
    await openScreen("orgs");
    expect(
      await screen.findByText(viStrings.orgs.permissionDeniedTitle)
    ).toBeInTheDocument();
  });

  it("draws the organisation tree and opens a node detail card", async () => {
    installApiFetch([
      (url) =>
        url.includes("/v1/directory/organizations")
          ? json(200, directoryFixture())
          : undefined,
    ]);
    await openScreen("orgs");
    await screen.findByRole("heading", {
      level: 1,
      name: viStrings.orgs.title,
    });
    expect(
      await screen.findByRole("button", { name: "Junctura" })
    ).toBeInTheDocument();
    expect(screen.queryByText("tenant-test")).toBeNull();
    fireEvent.click(
      await screen.findByRole("button", { name: "Trạm y tế xã" })
    );
    expect(
      (await screen.findAllByText("chuyển tuyến")).length
    ).toBeGreaterThan(0);
    expect(screen.queryByText("app-1")).toBeNull();
  });
});
