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
        id: "app-health",
        name: "Sổ sức khỏe",
        state: "active",
        collections: [
          {
            name: "benh-nhan",
            records: 40,
            updatedAt: "2026-11-10T00:28:20.543Z",
          },
          {
            name: "don-thuoc",
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
          name: "benh-nhan",
          records: 40,
          updatedAt: "2026-11-10T05:16:58.689Z",
        },
        {
          name: "don-thuoc",
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
        "junctura_chuyen_tuyen",
        "Chuyển tuyến bệnh nhân",
        "Chuyển tuyến BN-0001",
        "Tiếp nhận ở Trạm y tế",
        ["tram-y-te"]
      ),
      execution(
        "exec-completed",
        "completed",
        "junctura_xac_minh_don_thuoc",
        "Xác minh đơn thuốc",
        "Xác minh đơn thuốc DT-0002"
      ),
      execution(
        "exec-cancelled",
        "cancelled",
        "junctura_xac_minh_chi_phi",
        "Xác minh chi phí bảo hiểm",
        "Xác minh chi phí BH-0003"
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
        key: "junctura_chuyen_tuyen",
        name: "Chuyển tuyến bệnh nhân",
        application: { id: "tram-y-te", name: "Trạm y tế" },
        steps: [
          { name: "Tiếp nhận ở Trạm y tế", owner: "Trạm y tế" },
          { name: "Bác sĩ bệnh viện duyệt", owner: "Bệnh viện" },
        ],
        counts: { running: 1, completed: 0, cancelled: 0 },
        updatedAt: "2026-11-10T05:16:57.509Z",
      },
      {
        key: "junctura_xac_minh_don_thuoc",
        name: "Xác minh đơn thuốc",
        application: { id: "nha-thuoc", name: "Nhà thuốc" },
        steps: [{ name: "Nhà thuốc gửi", owner: "Nhà thuốc" }],
        counts: { running: 0, completed: 1, cancelled: 0 },
        updatedAt: "2026-11-10T05:16:57.509Z",
      },
      {
        key: "junctura_xac_minh_chi_phi",
        name: "Xác minh chi phí bảo hiểm",
        application: { id: "bao-hiem", name: "Bảo hiểm" },
        steps: [{ name: "Bảo hiểm gửi", owner: "Bảo hiểm" }],
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

    expect(await screen.findByText("Sổ sức khỏe")).toBeInTheDocument();
    expect(screen.getByText(viStrings.records.privacyNote)).toBeInTheDocument();
    expect(screen.getByText("Bệnh nhân")).toBeInTheDocument();
    expect(screen.getByText("Đơn thuốc")).toBeInTheDocument();
    expect(screen.getByText(viStrings.records.colRecords)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Tạo bản ghi|Create record/ })
    ).toBeNull();
    expect(screen.queryByText("benh-nhan")).toBeNull();
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

    expect(await screen.findByText("Sổ sức khỏe")).toBeInTheDocument();
    expect(screen.getByText(viStrings.files.statFiles)).toBeInTheDocument();
    expect(screen.getByText(viStrings.files.statStorage)).toBeInTheDocument();
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
      (await screen.findAllByText("Chuyển tuyến bệnh nhân")).length
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("Trạm y tế").length).toBeGreaterThan(0);
    expect(
      screen.queryByRole("button", {
        name: /Chạy thử|Hoàn thành bước này|Dừng hồ sơ/,
      })
    ).toBeNull();

    const casesTable = await screen.findByRole("table", {
      name: viStrings.workflows.casesTitle,
    });
    expect(within(casesTable).getByText("exec-running")).toBeInTheDocument();
    expect(within(casesTable).queryByText("exec-completed")).toBeNull();
    expect(screen.queryByText("Tiếp nhận ở Trạm y tế")).toBeNull();
    expect(screen.queryByText("Chuyển tuyến BN-0001")).toBeNull();

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
});
