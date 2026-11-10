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
import { PANEL_FUNCTION_IDS } from "../constants/platformFunctions";
import { installApiFetch } from "./apiMock";

function resetState() {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  api.setBaseUrl("/api");
  api.setToken("test-token");
  installApiFetch();
}

async function openScreen(hash: string, heading: string) {
  resetState();
  window.history.replaceState(null, "", "/#/dashboard");
  render(<App />);
  await screen.findByRole("heading", {
    level: 1,
    name: viStrings.dashboard.title,
  });
  if (hash !== "dashboard") {
    window.location.hash = `#/${hash}`;
    fireEvent(window, new HashChangeEvent("hashchange"));
  }
  await screen.findByRole("heading", { level: 1, name: heading });
}

function sidebar() {
  return screen.getByRole("complementary", {
    name: viStrings.session.navigation,
  });
}

function sidebarNav(): HTMLElement {
  const nav = sidebar().querySelector("nav");
  if (!nav) throw new Error("sidebar navigation is missing");
  return nav;
}

function sidebarLabels(): string[] {
  return within(sidebarNav())
    .getAllByRole("button")
    .map((button) => button.textContent?.trim() ?? "");
}

describe("Task 25 — flat sidebar", () => {
  beforeEach(resetState);

  it("lists one flat level of navigation and a separate system group", async () => {
    await openScreen("dashboard", viStrings.dashboard.title);
    expect(sidebarLabels()).toEqual([
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
    expect(within(sidebar()).queryByText(/OLP|Lõi|Mở rộng/)).toBeNull();
  });

  it("highlights Năng lực while a capability-sharing page is open", async () => {
    await openScreen("grants", viStrings.grants.title);
    expect(
      within(sidebarNav()).getByRole("button", {
        name: viStrings.modules.caps.label,
      })
    ).toHaveAttribute("aria-current", "page");
  });

  it("highlights Nhật ký kiểm toán while a security page is open", async () => {
    await openScreen("consents", viStrings.consents.title);
    expect(
      within(sidebarNav()).getByRole("button", {
        name: viStrings.modules.audit.label,
      })
    ).toHaveAttribute("aria-current", "page");
  });

  it("keeps the same icons accessible when the sidebar is collapsed", async () => {
    await openScreen("dashboard", viStrings.dashboard.title);
    fireEvent.click(
      screen.getByRole("button", { name: viStrings.session.collapseSidebar })
    );
    for (const label of [
      viStrings.modules.dashboard.label,
      viStrings.modules.queue.label,
      viStrings.modules.apps.label,
      viStrings.modules.caps.label,
      viStrings.modules.users.label,
      viStrings.modules.orgs.label,
      viStrings.modules.audit.label,
      viStrings.platform.docsApi,
      viStrings.modules.settings.label,
    ]) {
      expect(
        within(sidebarNav()).getByRole("button", { name: label })
      ).toBeInTheDocument();
    }
  });
});

describe("Task 25 — floating function panel", () => {
  beforeEach(resetState);

  it("lists the shared functions with chips for their existing pages", async () => {
    await openScreen("dashboard", viStrings.dashboard.title);
    fireEvent.click(
      screen.getByRole("button", {
        name: `${viStrings.header.servicesLabel} ${PANEL_FUNCTION_IDS.length}`,
      })
    );
    const panel = await screen.findByRole("complementary", {
      name: viStrings.platform.panelTitle,
    });

    for (const id of PANEL_FUNCTION_IDS) {
      expect(
        within(panel).getAllByText(viStrings.platform.functions[id].name).length
      ).toBeGreaterThan(0);
    }
    for (const label of [
      viStrings.modules["connect-map"].label,
      viStrings.modules.caps.label,
      viStrings.modules.grants.label,
    ]) {
      expect(
        within(panel).getByRole("button", { name: label })
      ).toBeInTheDocument();
    }
    expect(within(panel).queryByText(/OLP|Lõi|Mở rộng/)).toBeNull();
  });

  it("opens a function page from its chip", async () => {
    await openScreen("dashboard", viStrings.dashboard.title);
    fireEvent.click(
      screen.getByRole("button", {
        name: `${viStrings.header.servicesLabel} ${PANEL_FUNCTION_IDS.length}`,
      })
    );
    const panel = await screen.findByRole("complementary", {
      name: viStrings.platform.panelTitle,
    });
    fireEvent.click(
      within(panel).getByRole("button", {
        name: viStrings.modules.grants.label,
      })
    );
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: viStrings.grants.title,
      })
    ).toBeInTheDocument();
    expect(screen.queryByRole("complementary", {
      name: viStrings.platform.panelTitle,
    })).toBeNull();
  });

  it("does not show the identity or gateway cards in the panel", async () => {
    await openScreen("dashboard", viStrings.dashboard.title);
    fireEvent.click(
      screen.getByRole("button", {
        name: `${viStrings.header.servicesLabel} ${PANEL_FUNCTION_IDS.length}`,
      })
    );
    const panel = await screen.findByRole("complementary", {
      name: viStrings.platform.panelTitle,
    });
    expect(
      within(panel).queryByText(viStrings.platform.functions.identity.name)
    ).toBeNull();
    expect(
      within(panel).queryByText(viStrings.platform.functions.gateway.name)
    ).toBeNull();
  });
});

describe("Task 25 — page tabs", () => {
  beforeEach(resetState);

  function pageTabs() {
    return screen.getByRole("navigation", {
      name: viStrings.pageTabs.label,
    });
  }

  it("shows the sibling pages of the current function", async () => {
    await openScreen("grants", viStrings.grants.title);
    expect(
      within(pageTabs())
        .getAllByRole("button")
        .map((button) => button.textContent?.trim())
    ).toEqual([
      viStrings.modules["connect-map"].label,
      viStrings.modules.caps.label,
      viStrings.modules.grants.label,
    ]);
    expect(
      within(pageTabs()).getByRole("button", {
        name: viStrings.modules.grants.label,
      })
    ).toHaveAttribute("aria-current", "page");
  });

  it("does not show a page tab strip when settings is the only system page", async () => {
    await openScreen("settings", viStrings.settings.title);
    expect(
      screen.queryByRole("navigation", { name: viStrings.pageTabs.label })
    ).toBeNull();
  });

  it("keeps the settings page as the current system page", async () => {
    await openScreen("settings", viStrings.settings.title);
    expect(
      within(sidebarNav()).getByRole("button", {
        name: viStrings.modules.settings.label,
      })
    ).toHaveAttribute("aria-current", "page");
  });

  it("shows the three dashboard tabs and navigates between them", async () => {
    await openScreen("dashboard", viStrings.dashboard.title);
    expect(
      within(pageTabs())
        .getAllByRole("button")
        .map((button) => button.textContent?.trim())
    ).toEqual([
      viStrings.modules.dashboard.label,
      viStrings.modules.traffic.label,
      viStrings.modules.requests.label,
    ]);
    expect(
      within(pageTabs()).getByRole("button", {
        name: viStrings.modules.dashboard.label,
      })
    ).toHaveAttribute("aria-current", "page");
    fireEvent.click(
      within(pageTabs()).getByRole("button", {
        name: viStrings.modules.traffic.label,
      })
    );
    await screen.findByRole("heading", {
      level: 1,
      name: viStrings.dashboard.trafficTitle,
    });
    expect(window.location.hash).toBe("#/traffic");
  });
});
