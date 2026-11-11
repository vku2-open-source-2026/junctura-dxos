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
import { installApiFetch, json } from "./apiMock";

function resetState() {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  api.setBaseUrl("/api");
  api.setToken("test-token");
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
  return screen.findByRole("heading", { level: 1, name: heading });
}

function edge(
  grantId: string,
  state: "pending" | "active" | "expired" | "revoked",
  overrides: Record<string, unknown> = {}
) {
  return {
    grantId,
    providerAppId: "app-provider",
    consumerAppId: "app-consumer",
    capabilityId: `cap-${grantId}`,
    version: "1.0.0",
    title: `Chia sẻ ${grantId}`,
    operations: ["invoke"],
    revision: 1,
    state,
    createdAt: "2026-11-01T00:00:00.000Z",
    activatedAt:
      state === "active" || state === "expired"
        ? "2026-11-02T00:00:00.000Z"
        : null,
    revokedAt: state === "revoked" ? "2026-11-03T00:00:00.000Z" : null,
    expiresAt:
      state === "expired"
        ? "2026-11-04T00:00:00.000Z"
        : "2027-11-01T00:00:00.000Z",
    ...overrides,
  };
}

function grantGraph() {
  return {
    scope: "tenant",
    nodes: [
      { appId: "app-provider", displayName: "Đơn vị tiếp nhận", state: "active", owned: true },
      { appId: "app-consumer", displayName: "Đơn vị xét duyệt", state: "active", owned: false },
    ],
    edges: [
      edge("g-pending", "pending"),
      edge("g-active", "active"),
      edge("g-rejected", "revoked"),
      edge("g-revoked", "revoked", {
        activatedAt: "2026-11-02T00:00:00.000Z",
      }),
      edge("g-expired", "expired"),
    ],
    truncated: false,
    generatedAt: "2026-11-10T00:00:00.000Z",
  };
}

describe("Task 45 — sharing grants by status", () => {
  beforeEach(resetState);

  it("groups grants from the API fixture into the five lifecycle states", async () => {
    installApiFetch([
      (url) =>
        url.includes("/v1/trust/graph")
          ? json(200, grantGraph())
          : undefined,
    ]);
    await openScreen("grants", viStrings.grants.title);

    const table = await screen.findByRole("table");
    expect(within(table).getByText(viStrings.grants.stateProposed)).toBeTruthy();
    expect(within(table).getAllByText(viStrings.grants.stateActive).length)
      .toBeGreaterThan(0);
    expect(within(table).getAllByText(viStrings.grants.stateRejected).length)
      .toBeGreaterThan(0);
    expect(within(table).getAllByText(viStrings.grants.stateExpired).length)
      .toBeGreaterThan(0);

    fireEvent.click(
      screen.getByRole("tab", {
        name: new RegExp(viStrings.grants.stateRejected),
      })
    );
    fireEvent.click(
      screen.getByRole("tab", {
        name: new RegExp(viStrings.grants.stateActive),
      })
    );
    expect(
      screen.getByRole("tab", {
        name: new RegExp(viStrings.grants.stateActive),
      })
    ).toHaveAttribute("aria-selected", "true");
  });

  it("requires a reason before rejecting or revoking a share", async () => {
    installApiFetch([
      (url) =>
        url.includes("/v1/trust/graph")
          ? json(200, grantGraph())
          : undefined,
    ]);
    await openScreen("grants", viStrings.grants.title);

    fireEvent.click(
      await screen.findByRole("button", {
        name: `${viStrings.grants.actionRevoke}: Chia sẻ g-active`,
      })
    );
    const confirm = screen.getByRole("button", {
      name: viStrings.grants.actionRevoke,
    });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(viStrings.grants.reasonLabel), {
      target: { value: "hết nhu cầu" },
    });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
  });

  it("does not offer creating or proposing grants", async () => {
    installApiFetch([
      (url) =>
        url.includes("/v1/trust/graph")
          ? json(200, grantGraph())
          : undefined,
    ]);
    await openScreen("grants", viStrings.grants.title);
    expect(
      screen.queryByRole("button", {
        name: /tạo quyền|đề xuất quyền|công bố|publish|propose/i,
      })
    ).toBeNull();
  });
});

describe("Task 45 — application detail", () => {
  beforeEach(resetState);

  const application = {
    appId: "app-provider",
    tenantId: "tenant-test",
    ownerSubject: "owner-1",
    displayName: "Đơn vị tiếp nhận",
    oauthClientId: "don-vi-tiep-nhan-client",
    providerOrigin: "https://don-vi-tiep-nhan.example",
    state: "active",
    revision: 3,
    digest: "sha256:abc",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
    lastApprovalId: "approval-1",
  };

  function routes() {
    return [
      (url: string) =>
        url.includes("/v1/applications/app-provider")
          ? json(200, application)
          : undefined,
      (url: string) =>
        url.includes("/v1/trust/graph")
          ? json(200, grantGraph())
          : undefined,
      (url: string) =>
        url.includes("/v1/capabilities")
          ? json(200, {
              items: [
                {
                  manifest: {
                    capabilityId: "cap-1",
                    providerAppId: "app-provider",
                    version: "1.0.0",
                    title: "Tóm tắt hồ sơ",
                  },
                  state: "published",
                  revision: 1,
                  digest: "sha256:cap",
                },
              ],
            })
          : undefined,
      (url: string) =>
        url.includes("/v1/storage/summary")
          ? json(200, {
              applications: [
                {
                  id: "app-provider",
                  name: "Đơn vị tiếp nhận",
                  state: "active",
                  collections: [
                    { name: "nguoi-nop", records: 10, updatedAt: null },
                    { name: "chung-tu", records: 4, updatedAt: null },
                  ],
                  files: {
                    count: 7,
                    bytes: 100,
                    quarantined: 0,
                    updatedAt: null,
                  },
                },
              ],
              totals: { collections: [], files: null },
            })
          : undefined,
      (url: string) =>
        url.includes("/v1/audit-events")
          ? json(200, {
              items: [
                {
                  eventId: "event-1",
                  occurredAt: "2026-10-02T00:00:00.000Z",
                  event: "application.approved",
                  outcome: "success",
                  resourceType: "application",
                  resourceId: "app-provider",
                  subject: "admin-1",
                },
              ],
              nextCursor: null,
            })
          : undefined,
      (url: string) =>
        url.includes("/v1/directory/principals")
          ? json(200, {
              items: [
                {
                  subject: "owner-1",
                  issuer: "issuer",
                  managementClient: "console",
                  permissions: [],
                  enabled: true,
                  displayName: "Chị Hoa",
                  organization: "Đơn vị tiếp nhận",
                  jobTitle: null,
                  kind: "admin",
                },
                {
                  subject: "admin-1",
                  issuer: "issuer",
                  managementClient: "console",
                  permissions: [],
                  enabled: true,
                  displayName: "Anh Minh",
                  organization: null,
                  jobTitle: null,
                  kind: "admin",
                },
              ],
              truncated: false,
            })
          : undefined,
    ];
  }

  it("opens a full detail view and labels the list action as view details", async () => {
    installApiFetch(routes());
    await openScreen("apps", viStrings.applications.title);
    const row = (await screen.findByText("Đơn vị tiếp nhận")).closest("tr");
    if (!row) throw new Error("application row is missing");
    fireEvent.click(
      within(row).getByRole("button", {
        name: viStrings.applications.openApp,
      })
    );

    await screen.findByRole("heading", { level: 1, name: "Đơn vị tiếp nhận" });
    expect(await screen.findByText("Đơn vị tiếp nhận")).toBeInTheDocument();
    expect(screen.getByText("Chị Hoa")).toBeInTheDocument();
    expect(screen.getByText("Anh Minh")).toBeInTheDocument();
    expect(screen.getByText("Tóm tắt hồ sơ")).toBeInTheDocument();
    expect(screen.getByText(viStrings.applications.technicalDetails)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: /đăng ký ứng dụng|register application/i,
      })
    ).toBeNull();
  });
});

describe("Task 45 — read-only oversight pages", () => {
  beforeEach(resetState);

  it("keeps consents and emergency access read-only", async () => {
    installApiFetch();
    await openScreen("consents", viStrings.consents.title);
    expect(screen.getByText(viStrings.consents.readOnlyNote)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /thu hồi đồng ý|withdraw consent/i })
    ).toBeNull();
    cleanup();

    resetState();
    installApiFetch();
    await openScreen("emergency", viStrings.emergency.title);
    expect(
      screen.getByText(viStrings.emergency.readOnlyNote)
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /hậu kiểm|review/i })
    ).toBeNull();
  });

  it("limits the approval queue to applications and grant proposals", async () => {
    installApiFetch([
      (url) =>
        url.includes("/v1/trust/graph")
          ? json(200, {
              ...grantGraph(),
              nodes: [
                {
                  appId: "app-pending",
                  displayName: "Ứng dụng mới",
                  state: "pending",
                  owned: false,
                },
                ...grantGraph().nodes,
              ],
            })
          : undefined,
    ]);
    await openScreen("queue", viStrings.queue.title);
    const filter = screen.getByRole("combobox", {
      name: viStrings.queue.filterLabel,
    });
    const options = within(filter).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      viStrings.queue.filterAll,
      viStrings.queue.filterApplications,
      viStrings.queue.filterGrants,
    ]);
  });
});
