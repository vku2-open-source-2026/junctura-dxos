// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import App from "../App";
import { api } from "../services/apiClient";
import { vi as viStrings } from "../locales/vi";
import { en as enStrings } from "../locales/en";
import { installApiFetch } from "./apiMock";

function resetState() {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  api.setBaseUrl("/api");
  api.setToken("test-token");
}

async function openDashboard() {
  window.history.replaceState(null, "", "/#/dashboard");
  render(<App />);
  await screen.findByRole("heading", {
    level: 1,
    name: viStrings.dashboard.title,
  });
}

describe("Task 47 — documentation entry point", () => {
  beforeEach(resetState);

  it("opens the guide when the sidebar documentation item is used", async () => {
    installApiFetch();
    await openDashboard();

    fireEvent.click(
      screen.getByRole("button", { name: viStrings.platform.docsApi })
    );

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: viStrings.docs.title,
      })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        level: 2,
        name: viStrings.docs.sections.quickStart.title,
      })
    ).toBeInTheDocument();
    expect(
      screen.queryByText(viStrings.docs.apiDocs.baseUrlTitle)
    ).toBeNull();
  });

  it("still opens API docs for a deep link with an operation", async () => {
    installApiFetch();
    await openDashboard();

    window.location.hash = "#/docs/api?op=createApplication";
    fireEvent(window, new HashChangeEvent("hashchange"));

    expect(
      await screen.findByText(viStrings.docs.apiDocs.baseUrlTitle)
    ).toBeInTheDocument();
  });
});

describe("Task 47 — dataset terminology", () => {
  it("uses dataset wording in Vietnamese and English", () => {
    expect(viStrings.records.statCollections).toBe("Bộ dữ liệu");
    expect(viStrings.records.colCollection).toBe("Bộ dữ liệu");
    expect(viStrings.records.structureTitle).toBe("Cấu trúc bộ dữ liệu");
    expect(enStrings.records.statCollections).toBe("Datasets");
    expect(enStrings.records.colCollection).toBe("Dataset");
    expect(enStrings.records.structureTitle).toBe("Dataset structure");
  });
});
