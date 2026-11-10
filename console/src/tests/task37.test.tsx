// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

async function openScreen(hash: string) {
  window.history.replaceState(null, "", "/#/dashboard");
  render(<App />);
  await screen.findByRole("heading", {
    level: 1,
    name: viStrings.dashboard.title,
  });
  window.location.hash = `#/${hash}`;
  fireEvent(window, new HashChangeEvent("hashchange"));
}

function orgFixture() {
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
          name: "Bệnh viện",
          kind: "organization",
          children: [],
        },
        {
          id: "app-3",
          name: "Nhà thuốc",
          kind: "application",
          children: [],
        },
      ],
    },
    relations: [
      { from: "app-1", to: "app-2", label: "Tóm tắt chuyển tuyến" },
      { from: "app-2", to: "app-3", label: "Đơn thuốc" },
    ],
    truncated: false,
  };
}

function principal(overrides: Record<string, unknown>) {
  return {
    subject: "subject",
    issuer: "https://issuer.example",
    managementClient: "console",
    permissions: [],
    enabled: true,
    displayName: null,
    organization: null,
    jobTitle: null,
    kind: "admin",
    ...overrides,
  };
}

describe("Task 37 — organisation tree", () => {
  beforeEach(resetState);

  it("shows the platform summary and highlights a unit's relations", async () => {
    installApiFetch([
      (url) =>
        url.includes("/v1/directory/organizations")
          ? json(200, orgFixture())
          : undefined,
    ]);
    await openScreen("orgs");
    await screen.findByRole("heading", {
      level: 1,
      name: viStrings.orgs.title,
    });

    expect(screen.queryByText(viStrings.orgs.totalUnits)).toBeNull();
    expect(screen.queryByText(viStrings.orgs.noIncoming)).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: viStrings.orgs.platformRootName })
    );
    expect(screen.getByText(viStrings.orgs.totalUnits)).toBeInTheDocument();
    expect(screen.getByText(viStrings.orgs.totalRelations)).toBeInTheDocument();
    expect(
      screen.getByText(viStrings.orgs.totalCapabilities)
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Trạm y tế xã" }));
    expect(
      screen.getAllByText("Tóm tắt chuyển tuyến").length
    ).toBeGreaterThan(0);
    expect(screen.getByText(viStrings.orgs.noIncoming)).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(
      screen.queryByRole("dialog", { name: viStrings.orgs.detailTitle })
    ).toBeNull();
  });

  it("lists every relation between units with both names", async () => {
    installApiFetch([
      (url) =>
        url.includes("/v1/directory/organizations")
          ? json(200, orgFixture())
          : undefined,
    ]);
    await openScreen("orgs");
    await screen.findByText(viStrings.orgs.relationsTitle);
    expect(
      await screen.findByText("Trạm y tế xã → Bệnh viện")
    ).toBeInTheDocument();
    expect(screen.getByText("Bệnh viện → Nhà thuốc")).toBeInTheDocument();
  });
});

describe("Task 37 — users table", () => {
  beforeEach(resetState);

  it("filters by organisation and type and opens the permission drawer", async () => {
    installApiFetch([
      (url) =>
        url.includes("/v1/directory/principals")
          ? json(200, {
              items: [
                principal({
                  subject: "admin-1",
                  displayName: "Nguyễn Văn A",
                  organization: "Bệnh viện",
                  jobTitle: "Quản trị nền tảng",
                  permissions: ["identity.admin"],
                  kind: "admin",
                }),
                principal({
                  subject: "app-1",
                  displayName: null,
                  organization: "Nhà thuốc",
                  permissions: ["trust.approve"],
                  kind: "application",
                }),
              ],
              truncated: false,
            })
          : undefined,
    ]);
    await openScreen("users");
    await screen.findByRole("heading", {
      level: 1,
      name: viStrings.users.title,
    });

    expect(await screen.findByText("Nguyễn Văn A")).toBeInTheDocument();
    expect(screen.getByText(viStrings.users.unnamed)).toBeInTheDocument();
    expect(
      screen.getAllByText(viStrings.users.kindAdmin).length
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(viStrings.users.kindApplication).length
    ).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText(viStrings.users.filterUnit), {
      target: { value: "Nhà thuốc" },
    });
    expect(screen.queryByText("Nguyễn Văn A")).toBeNull();
    expect(screen.getByText(viStrings.users.unnamed)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(viStrings.users.filterUnit), {
      target: { value: "all" },
    });
    fireEvent.change(screen.getByLabelText(viStrings.users.filterKind), {
      target: { value: "admin" },
    });
    expect(screen.getByText("Nguyễn Văn A")).toBeInTheDocument();
    expect(screen.queryByText(viStrings.users.unnamed)).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: viStrings.users.viewPermissions })
    );
    expect(
      await screen.findByText(viStrings.users.permissionNames["identity.admin"])
    ).toBeInTheDocument();
  });
});
