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

function storageSummary() {
  return {
    applications: [
      {
        id: "app-records",
        name: "Sổ dữ liệu A",
        state: "active",
        collections: [
          {
            name: "bo-du-lieu-a",
            records: 40,
            updatedAt: "2026-11-10T00:28:20.543Z",
          },
          {
            name: "bo-du-lieu-b",
            records: 50,
            updatedAt: "2026-11-10T00:28:23.476Z",
          },
        ],
        files: {
          count: 8,
          bytes: 4760,
          quarantined: 1,
          updatedAt: "2026-11-10T05:17:01.445Z",
        },
      },
      {
        id: "app-empty",
        name: "Phòng khám",
        state: "suspended",
        collections: [],
        files: {
          count: 0,
          bytes: 0,
          quarantined: 0,
          updatedAt: null,
        },
      },
    ],
    totals: {
      collections: [
        {
          name: "bo-du-lieu-a",
          records: 40,
          updatedAt: "2026-11-10T05:16:58.689Z",
        },
        {
          name: "bo-du-lieu-b",
          records: 50,
          updatedAt: "2026-11-10T05:17:01.119Z",
        },
      ],
      files: {
        count: 8,
        bytes: 4760,
        quarantined: 1,
        updatedAt: "2026-11-10T05:17:01.445Z",
      },
    },
  };
}

function execution(
  id: string,
  status: "running" | "completed" | "cancelled",
  key: string,
  name: string,
  title: string,
  stepName?: string,
  groups: string[] = []
) {
  return {
    id,
    definition: {
      id: `${key}:1:${id}`,
      key,
      name,
      version: 1,
    },
    status,
    startedAt: "2026-11-10T05:16:57.508Z",
    updatedAt: "2026-11-10T05:16:57.509Z",
    title,
    currentStep:
      status === "running"
        ? { name: stepName ?? null, assignee: null, groups }
        : null,
  };
}

function workflowExecutions() {
  return {
    items: [
      execution(
        "exec-running",
        "running",
        "quy_trinh_a",
        "Quy trình A",
        "Quy trình A YC-0001",
        "Bước một",
        ["nhom-a"]
      ),
      execution(
        "exec-completed",
        "completed",
        "quy_trinh_b",
        "Quy trình B",
        "Quy trình B HS-0002"
      ),
      execution(
        "exec-cancelled",
        "cancelled",
        "quy_trinh_c",
        "Quy trình C",
        "Quy trình C BH-0003"
      ),
    ],
    limit: 100,
  };
}

function workflowRoute(url: string) {
  if (!url.includes("/v1/workflows/executions")) return undefined;
  const status = new URL(url, "http://localhost").searchParams.get("status");
  const items = workflowExecutions().items.filter(
    (item) => !status || item.status === status
  );
  return json(200, { items, limit: 100 });
}

function workflowSummaryRoute(url: string) {
  if (!url.includes("/v1/workflows/summary")) return undefined;
  return json(200, {
    definitions: [
      {
        key: "quy_trinh_a",
        name: "Quy trình A",
        application: { id: "nhom-a", name: "Nhóm A" },
        steps: [
          { name: "Bước một", owner: "Nhóm A" },
          { name: "Bước hai", owner: "Nhóm B" },
        ],
        counts: { running: 1, completed: 0, cancelled: 0 },
        updatedAt: "2026-11-10T05:16:57.509Z",
      },
      {
        key: "quy_trinh_b",
        name: "Quy trình B",
        application: { id: "nhom-b", name: "Nhóm B" },
        steps: [{ name: "Bước gửi", owner: "Nhóm B" }],
        counts: { running: 0, completed: 1, cancelled: 0 },
        updatedAt: "2026-11-10T05:16:57.509Z",
      },
      {
        key: "quy_trinh_c",
        name: "Quy trình C",
        application: { id: "nhom-c", name: "Nhóm C" },
        steps: [{ name: "Bước xử lý", owner: "Nhóm C" }],
        counts: { running: 0, completed: 0, cancelled: 1 },
        updatedAt: "2026-11-10T05:16:57.509Z",
      },
    ],
    totals: { definitions: 3, running: 1, completed: 1, cancelled: 1 },
  });
}

describe("Task 40 — data and file summaries", () => {
  beforeEach(resetState);

  it("shows aggregate data without record content or admin write actions", async () => {
    installApiFetch([
      (url) =>
        url.includes("/v1/storage/summary")
          ? json(200, storageSummary())
          : undefined,
    ]);
    await openScreen("records");
    await screen.findByRole("heading", {
      level: 1,
      name: viStrings.records.title,
    });

    expect(await screen.findByText("Sổ dữ liệu A")).toBeInTheDocument();
    expect(screen.getByText(viStrings.records.privacyNote)).toBeInTheDocument();
    expect(screen.getByText("bo-du-lieu-a")).toBeInTheDocument();
    expect(screen.getByText("bo-du-lieu-b")).toBeInTheDocument();
    expect(screen.getByText(viStrings.records.colRecords)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Tạo bản ghi|Create record/ })
    ).toBeNull();
  });

  it("shows an unknown collection name exactly as the API returns it", async () => {
    installApiFetch([
      (url) =>
        url.includes("/v1/storage/summary")
          ? json(200, {
              applications: [
                {
                  id: "app-unknown",
                  name: "Sổ dữ liệu B",
                  state: "active",
                  collections: [
                    { name: "Bang_tam-XYZ 2", records: 3, updatedAt: null },
                  ],
                  files: {
                    count: 0,
                    bytes: 0,
                    quarantined: 0,
                    updatedAt: null,
                  },
                },
              ],
              totals: {
                collections: [
                  { name: "Bang_tam-XYZ 2", records: 3, updatedAt: null },
                ],
                files: {
                  count: 0,
                  bytes: 0,
                  quarantined: 0,
                  updatedAt: null,
                },
              },
            })
          : undefined,
    ]);
    await openScreen("records");
    await screen.findByRole("heading", {
      level: 1,
      name: viStrings.records.title,
    });

    expect(await screen.findByText("Bang_tam-XYZ 2")).toBeInTheDocument();
    expect(screen.queryByText("Bang tam XYZ 2")).toBeNull();
  });

  it("shows only aggregate file counts, storage and quarantine", async () => {
    installApiFetch([
      (url) =>
        url.includes("/v1/storage/summary")
          ? json(200, storageSummary())
          : undefined,
    ]);
    await openScreen("files");
    await screen.findByRole("heading", {
      level: 1,
      name: viStrings.files.title,
    });

    expect(
      await screen.findByRole("button", { name: /Sổ dữ liệu A/ })
    ).toBeInTheDocument();
    // Wait for the browser's duplicate storage label before checking the stat.
    expect(
      await screen.findByRole("option", { name: viStrings.files.sortSize })
    ).toBeInTheDocument();
    expect(screen.getByText(viStrings.files.statFiles)).toBeInTheDocument();
    expect(
      screen.getByText(viStrings.files.statStorage, { selector: "span" })
    ).toBeInTheDocument();
    expect(
      screen.getByText(viStrings.files.statQuarantined)
    ).toBeInTheDocument();
    expect(screen.getByText(viStrings.files.needsReview)).toBeInTheDocument();
    expect(screen.queryByText(/eicar|fileName|objectKey/i)).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Tải tệp lên|Upload file/ })
    ).toBeNull();
  });
});

describe("Task 40 — read-only workflow dashboard", () => {
  beforeEach(resetState);

  it("shows the workflow summary and filters cases without write actions", async () => {
    installApiFetch([workflowRoute, workflowSummaryRoute]);
    await openScreen("workflows");
    await screen.findByRole("heading", {
      level: 1,
      name: viStrings.workflows.title,
    });

    expect(
      screen.getByText(viStrings.workflows.readOnlyNote)
    ).toBeInTheDocument();
    expect(
      (await screen.findAllByText("Quy trình A")).length
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("Nhóm A").length).toBeGreaterThan(0);
    expect(
      screen.queryByRole("button", {
        name: /Chạy thử|Hoàn thành bước này|Dừng hồ sơ|Hủy lượt chạy/,
      })
    ).toBeNull();

    const casesTable = await screen.findByRole("table", {
      name: viStrings.workflows.casesTitle,
    });
    expect(within(casesTable).getByText("exec-running")).toBeInTheDocument();
    expect(within(casesTable).queryByText("exec-completed")).toBeNull();
    expect(screen.queryByText("Bước một")).toBeNull();
    expect(screen.queryByText("Quy trình A YC-0001")).toBeNull();

    const completedTab = screen.getByRole("tab", {
      name: new RegExp(viStrings.workflows.filterCompleted),
    });
    expect(completedTab).toHaveTextContent("(1)");
    fireEvent.click(completedTab);
    const completedTable = await screen.findByRole("table", {
      name: viStrings.workflows.casesTitle,
    });
    expect(
      within(completedTable).getByText("exec-completed")
    ).toBeInTheDocument();
    expect(within(completedTable).queryByText("exec-running")).toBeNull();

    fireEvent.click(
      screen.getByRole("tab", {
        name: new RegExp(viStrings.workflows.filterCancelled),
      })
    );
    const cancelledTable = await screen.findByRole("table", {
      name: viStrings.workflows.casesTitle,
    });
    expect(
      within(cancelledTable).getByText("exec-cancelled")
    ).toBeInTheDocument();
  });

  it("uses the API-provided name and owner for an unknown workflow key", async () => {
    installApiFetch([
      workflowRoute,
      (url) =>
        url.includes("/v1/workflows/summary")
          ? json(200, {
              definitions: [
                {
                  key: "quy_trinh_moi",
                  name: "Quy trình mới",
                  application: { id: "nhom-c", name: "Nhóm C" },
                  steps: [{ name: "Bước mới", owner: "Nhóm C" }],
                  counts: { running: 0, completed: 0, cancelled: 0 },
                  updatedAt: "2026-11-10T05:16:57.509Z",
                },
              ],
              totals: {
                definitions: 1,
                running: 0,
                completed: 0,
                cancelled: 0,
              },
            })
          : undefined,
    ]);
    await openScreen("workflows");
    await screen.findByRole("heading", {
      level: 1,
      name: viStrings.workflows.title,
    });

    const summaryTable = await screen.findByRole("table", {
      name: viStrings.workflows.summaryTitle,
    });
    const nameButton = within(summaryTable).getByRole("button", {
      name: "Quy trình mới",
    });
    expect(nameButton).toBeInTheDocument();
    expect(within(summaryTable).getByText("Nhóm C")).toBeInTheDocument();

    fireEvent.click(nameButton);
    const dialog = await screen.findByRole("dialog", {
      name: viStrings.workflows.stepsTitle,
    });
    expect(within(dialog).getByText("Quy trình mới")).toBeInTheDocument();
    expect(within(dialog).getByText("Bước mới")).toBeInTheDocument();
    expect(within(dialog).getByText("Nhóm C")).toBeInTheDocument();
  });

  it("links the overview case card to the waiting workflow filter", async () => {
    installApiFetch([workflowRoute, workflowSummaryRoute]);
    window.history.replaceState(null, "", "/#/dashboard");
    render(<App />);
    await screen.findByRole("heading", {
      level: 1,
      name: viStrings.dashboard.title,
    });

    const view = await screen.findByRole("button", {
      name: viStrings.dashboard.viewPendingCases,
    });
    const waitCount = workflowExecutions().items.filter(
      (item) => item.status === "running"
    ).length;
    expect(
      screen.getByText(
        viStrings.dashboard.pendingCasesDesc.replace(
          "{n}",
          String(waitCount)
        )
      )
    ).toBeInTheDocument();

    fireEvent.click(view);
    await screen.findByRole("heading", {
      level: 1,
      name: viStrings.workflows.title,
    });
    const runningTab = screen.getByRole("tab", {
      name: new RegExp(viStrings.workflows.filterRunning),
    });
    expect(runningTab).toHaveAttribute("aria-selected", "true");
    expect(runningTab).toHaveTextContent(`(${waitCount})`);
  });

  it("explains that applications handle workflow steps and administrators only view", async () => {
    installApiFetch();
    await openScreen("platform/workflows");
    await screen.findByRole("heading", {
      level: 1,
      name: viStrings.platform.functions.workflows.name,
    });

    expect(
      screen.getByText(viStrings.platform.functions.workflows.care)
    ).toBeInTheDocument();

    const forbidden = /hoàn thành bước|hủy|complete the waiting step|cancel/i;
    for (const strings of [viStrings, enStrings]) {
      const workflows = strings.platform.functions.workflows;
      for (const text of [workflows.care, workflows.short, workflows.what]) {
        expect(text).not.toMatch(forbidden);
      }
    }
  });
});
