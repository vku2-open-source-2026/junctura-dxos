// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import App from "../App";
import { api } from "../services/apiClient";
import { vi as viStrings } from "../locales/vi";
import { installApiFetch, json, TEST_IDENTITY } from "./apiMock";

function resetState() {
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  api.setBaseUrl("/api");
  api.setToken(null);
}

async function renderDashboard() {
  window.history.replaceState(null, "", "/#/dashboard");
  render(<App />);
  await screen.findByRole("heading", {
    level: 1,
    name: viStrings.dashboard.title,
  });
}

async function openScreen(hash: string, heading: string) {
  await renderDashboard();
  window.location.hash = `#/${hash}`;
  fireEvent(window, new HashChangeEvent("hashchange"));
  await screen.findByRole("heading", { level: 1, name: heading });
}

describe("Signed-in screens render from real API data", () => {
  beforeEach(() => {
    resetState();
    installApiFetch();
    api.setToken("test-token");
  });

  afterEach(() => {
    resetState();
  });

  it("shows the dashboard and its live identity", async () => {
    await renderDashboard();
    expect(screen.getByRole("heading", { name: viStrings.dashboard.title }))
      .toBeInTheDocument();
    expect(TEST_IDENTITY.subject.length).toBeGreaterThan(0);
  });

  it.each([
    ["queue", viStrings.queue.title, viStrings.queue.emptyTitle],
    ["apps", viStrings.applications.title, viStrings.applications.listEmptyTitle],
    ["caps", viStrings.capabilities.title, viStrings.capabilities.capsEmptyTitle],
    ["grants", viStrings.grants.title, viStrings.grants.emptyTitle],
    ["connect-map", viStrings.connect.title, undefined],
    ["records", viStrings.records.title, undefined],
    ["workflows", viStrings.workflows.title, viStrings.workflows.summaryEmptyTitle],
    ["users", viStrings.users.title, viStrings.users.emptyTitle],
    ["orgs", viStrings.orgs.title, undefined],
    ["audit", viStrings.audit.title, undefined],
    ["consents", viStrings.consents.title, viStrings.consents.emptyTitle],
    ["emergency", viStrings.emergency.title, viStrings.emergency.emptyTitle],
    ["settings", viStrings.settings.title, undefined],
    ["profile", viStrings.profile.title, undefined],
    ["platform", viStrings.platform.title, undefined],
    ["docs", viStrings.docs.title, undefined],
  ])("opens %s", async (hash, heading, emptyTitle) => {
    await openScreen(hash, heading);
    if (emptyTitle) {
      expect(screen.getAllByText(emptyTitle).length).toBeGreaterThan(0);
    }
  });

  it("shows the API documentation tab from the documentation screen", async () => {
    await renderDashboard();
    window.location.hash = "#/docs/api";
    fireEvent(window, new HashChangeEvent("hashchange"));
    expect(
      await screen.findByText(viStrings.docs.apiDocs.baseUrlTitle)
    ).toBeInTheDocument();
  });

  it("surfaces a friendly error when the trust graph cannot load", async () => {
    installApiFetch([
      (url) =>
        url.includes("/v1/trust/graph") ? json(503, { error: "down" }) : undefined,
    ]);
    await openScreen("grants", viStrings.grants.title);
    expect(
      (await screen.findAllByText(viStrings.grants.loadErrorTitle)).length
    ).toBeGreaterThan(0);
  });
});
