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

  it("loads the selected unit's members and deployed applications from the API", async () => {
    installApiFetch([
      url => url.includes("/v1/directory/units?") ? json(200, {
        items: [{ unit: "unit-a", unitType: "team", name: "Đơn vị A" }], nextCursor: null,
      }) : undefined,
      url => url.includes("/v1/directory/units/unit-a/members?") ? json(200, {
        items: [{ subject: "member-a", groups: ["reviewers"] }], nextCursor: null,
      }) : undefined,
      url => url.includes("/v1/applications?") && url.includes("unit=unit-a") ? json(200, {
        items: [{ appId: "app-x", displayName: "App X" }], nextCursor: null,
      }) : undefined,
    ]);
    await openScreen("orgs");
    fireEvent.click(await screen.findByRole("button", { name: "Đơn vị A" }));
    expect(await screen.findByText("member-a")).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "App X" })).toHaveAttribute("href", "#/apps/app-x");
    expect(screen.queryByText(viStrings.orgs.relationsTitle)).toBeNull();
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
                  organization: "Đơn vị xét duyệt",
                  jobTitle: "Quản trị nền tảng",
                  permissions: ["identity.admin"],
                  kind: "admin",
                }),
                principal({
                  subject: "app-1",
                  displayName: null,
                  organization: "Đơn vị đề nghị",
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
      target: { value: "Đơn vị đề nghị" },
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
