// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import App from "../App";
import { I18nProvider } from "../locales/i18n";
import { api } from "../services/apiClient";
import { installApiFetch } from "./apiMock";
import { vi as viStrings } from "../locales/vi";
import {
  appLifecycleReducer,
  initialAppLifecycleState,
} from "../components/explainers/appLifecycleModel";
import {
  PANEL_FUNCTION_IDS,
  type PlatformFunctionId,
} from "../constants/platformFunctions";

function resetModes() {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  api.setBaseUrl("/api");
  api.setToken("test-token");
  installApiFetch();
}

function renderAt(hash: string) {
  window.history.replaceState(null, "", `/#/${hash}`);
  return render(<App />);
}

async function openPlatform(id: PlatformFunctionId) {
  const view = renderAt("dashboard");
  await screen.findByRole("heading", {
    level: 1,
    name: viStrings.dashboard.title,
  });
  window.location.hash = `#/platform/${id}`;
  fireEvent(window, new HashChangeEvent("hashchange"));
  await screen.findByRole("heading", {
    level: 1,
    name: viStrings.platform.functions[id].name,
  });
  return view;
}

function explainerIllustration(): HTMLElement {
  const image = screen.queryAllByRole("img")[0];
  if (image) return image;
  return screen.getByRole("list", {
    name: new RegExp(viStrings.workflows.diagrams.labels.scholarshipIntake),
  });
}

describe("Layer 1 function introductions", () => {
  beforeEach(resetModes);

  it("renders an accessible illustration on the functions that have one", async () => {
    for (const id of ["workflows", "app-management"] as const) {
      const view = await openPlatform(id);
      const illustration = explainerIllustration();
      expect(illustration.getAttribute("aria-label")?.length ?? 0).toBeGreaterThan(10);
      view.unmount();
      resetModes();
    }
  });

  it("locks approval for the requester in the application lifecycle", async () => {
    await openPlatform("app-management");
    fireEvent.click(screen.getByRole("button", { name: "Gửi đề xuất" }));
    const approve = screen.getByRole("button", { name: "Duyệt" });
    expect(approve).toBeDisabled();
    expect(screen.getByText(/Nút Duyệt bị khóa/)).toBeInTheDocument();
  });

  it("runs workflow steps and pauses for a person", async () => {
    await openPlatform("workflows");
    fireEvent.click(screen.getByRole("button", { name: "Chạy thử từng bước" }));
    expect(screen.getByRole("button", { name: "Duyệt" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Duyệt" }));
    fireEvent.click(screen.getByRole("button", { name: "Duyệt" }));
    expect(await screen.findByText("Quy trình đã hoàn thành.")).toBeInTheDocument();
  });

  it("hides and restores the introduction from the function page", async () => {
    await openPlatform("workflows");
    expect(explainerIllustration()).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: viStrings.platform.hideExplainer }));
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("list", {
        name: new RegExp(viStrings.workflows.diagrams.labels.scholarshipIntake),
      })
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: viStrings.platform.showExplainer }));
    expect(explainerIllustration()).toBeInTheDocument();
  });
});

describe("Application lifecycle model", () => {
  it("blocks self approval and makes revocation final", () => {
    let state = appLifecycleReducer(initialAppLifecycleState(), { type: "propose" });
    expect(state.status).toBe("pending");
    state = appLifecycleReducer(state, { type: "approve", byRequester: true });
    expect(state.status).toBe("pending");
    expect(state.log[0].kind).toBe("selfApprovalBlocked");
    state = appLifecycleReducer(state, { type: "approve", byRequester: false });
    expect(state.status).toBe("active");
    state = appLifecycleReducer(state, { type: "suspend" });
    expect(state.status).toBe("suspended");
    state = appLifecycleReducer(state, { type: "reactivate" });
    expect(state.status).toBe("active");
    state = appLifecycleReducer(state, { type: "revoke" });
    expect(state.status).toBe("revoked");
    expect(appLifecycleReducer(state, { type: "reactivate" }).status).toBe("revoked");
  });
});

describe("Layer 1 function panel and landing page", () => {
  beforeEach(resetModes);

  it("lists exactly the shared functions in the floating panel", async () => {
    renderAt("dashboard");
    await screen.findByRole("heading", { level: 1, name: viStrings.dashboard.title });
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
    expect(within(panel).queryByText(/OLP/)).toBeNull();
  });

  it("draws the two-layer map on the landing page", async () => {
    api.setToken(null);
    window.history.replaceState(null, "", "/#/welcome");
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: viStrings.landing.layersTitle })
    ).toBeInTheDocument();
    expect(screen.getAllByText(viStrings.landing.layerTier2).length).toBeGreaterThan(0);
    expect(screen.getAllByText(viStrings.landing.layersGateway).length).toBeGreaterThan(0);
  });
});
