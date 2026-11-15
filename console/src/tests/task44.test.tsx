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
  await screen.findByRole("heading", { level: 1, name: heading });
}

function trafficFixture() {
  const buckets = Array.from({ length: 60 }, (_, index) => ({
    at: new Date(Date.UTC(2026, 10, 10, 0, index)).toISOString(),
    requests: 2 + (index % 4),
    errors4xx: index % 6 === 0 ? 1 : 0,
    errors5xx: 0,
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
      errors5xx: 0,
      avgLatencyMs: 49,
      maxLatencyMs: 99,
    },
  };
}

function featureFixture() {
  const series = Array.from({ length: 60 }, (_, index) => ({
    at: new Date(Date.UTC(2026, 10, 10, 0, index)).toISOString(),
    requests: index % 5,
  }));
  return {
    from: "2026-11-10T00:00:00.000Z",
    to: "2026-11-10T01:00:00.000Z",
    features: [
      {
        feature: "data",
        requests: 120,
        errors4xx: 5,
        errors5xx: 1,
        avgLatencyMs: 42,
        maxLatencyMs: 210,
        series,
      },
      {
        feature: "workflows",
        requests: 80,
        errors4xx: 2,
        errors5xx: 0,
        avgLatencyMs: 68,
        maxLatencyMs: 340,
        series,
      },
      {
        feature: "files",
        requests: 40,
        errors4xx: 0,
        errors5xx: 0,
        avgLatencyMs: 25,
        maxLatencyMs: 90,
        series,
      },
    ],
  };
}

function execution(
  id: string,
  status: "running" | "completed" | "cancelled",
  key: string,
  name: string
) {
  return {
    id,
    definition: { id: `${key}:1:${id}`, key, name, version: 1 },
    status,
    startedAt: "2026-11-10T05:16:57.508Z",
    updatedAt: "2026-11-10T06:16:57.508Z",
    title: "Tiêu đề nội bộ",
    currentStep:
      status === "running"
        ? {
            name: "Bước một",
            assignee: "Chuyên viên A",
            groups: ["nhom-a"],
          }
        : null,
  };
}

function workflowSummaryFixture() {
  return {
    definitions: [
      {
        key: "quy_trinh_a",
        name: "Quy trình A",
        application: { id: "nhom-a", name: "Nhóm A" },
        steps: [
          { name: "Bước một", owner: "Nhóm A" },
          { name: "Bước hai", owner: "Nhóm B" },
        ],
        counts: { running: 1, completed: 2, cancelled: 1 },
        updatedAt: "2026-11-10T06:16:57.508Z",
      },
      {
        key: "quy_trinh_b",
        name: "Quy trình B",
        application: { id: "nhom-b", name: "Nhóm B" },
        steps: [{ name: "Bước gửi", owner: "Nhóm B" }],
        counts: { running: 0, completed: 1, cancelled: 0 },
        updatedAt: "2026-11-10T06:16:57.508Z",
      },
    ],
    totals: { definitions: 2, running: 1, completed: 3, cancelled: 1 },
  };
}

function workflowExecutionsFixture() {
  return {
    items: [
      execution(
        "case-running",
        "running",
        "quy_trinh_a",
        "Quy trình A"
      ),
      execution(
        "case-completed",
        "completed",
        "quy_trinh_b",
        "Quy trình B"
      ),
      execution(
        "case-cancelled",
        "cancelled",
        "quy_trinh_a",
        "Quy trình A"
      ),
    ],
    limit: 100,
  };
}

function workflowRoute(url: string) {
  if (url.includes("/v1/workflows/summary")) {
    return json(200, workflowSummaryFixture());
  }
  if (url.includes("/v1/workflows/executions")) {
    return json(200, workflowExecutionsFixture());
  }
  return undefined;
}

describe("Task 44 — feature traffic table", () => {
  beforeEach(resetState);

  it("lists features from the live fixture in descending order", async () => {
    installApiFetch([
      (url) =>
        url.includes("/v1/metrics/features")
          ? json(200, featureFixture())
          : undefined,
    ]);
    await openScreen("traffic", viStrings.dashboard.trafficTitle);

    const table = await screen.findByRole("table", {
      name: viStrings.dashboard.featureTableTitle,
    });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent(
      viStrings.dashboard.featureNames.data
    );
    expect(rows[1]).toHaveTextContent(
      viStrings.dashboard.featureNames.workflows
    );
    expect(rows[2]).toHaveTextContent(
      viStrings.dashboard.featureNames.files
    );
    expect(rows[0]).toHaveTextContent("120");
    expect(
      within(rows[0]).getByRole("img", {
        name: viStrings.dashboard.featureSparklineAria.replace(
          "{name}",
          viStrings.dashboard.featureNames.data
        ),
      })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /6 giờ|24 giờ/ })
    ).toBeNull();
  });
});

describe("Task 44 — overview stays on the last 60 minutes", () => {
  beforeEach(resetState);

  it("renders the 60-minute chart without longer range controls", async () => {
    installApiFetch([
      (url) =>
        url.includes("/v1/metrics/traffic")
          ? json(200, trafficFixture())
          : undefined,
    ]);
    window.history.replaceState(null, "", "/#/dashboard");
    render(<App />);
    await screen.findByRole("heading", {
      level: 1,
      name: viStrings.dashboard.title,
    });

    await waitFor(() => {
      expect(screen.getAllByTestId("traffic-point")).toHaveLength(60);
    });
    expect(
      screen.queryByRole("group", { name: viStrings.dashboard.rangeLabel })
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /6 giờ|24 giờ/ })).toBeNull();
  });
});

describe("Task 44 — read-only workflow dashboard", () => {
  beforeEach(resetState);

  it("shows summary and case statuses without write actions or case steps", async () => {
    installApiFetch([workflowRoute]);
    await openScreen("workflows", viStrings.workflows.title);

    expect(
      screen.getByText(viStrings.workflows.readOnlyNote)
    ).toBeInTheDocument();
    expect(
      (await screen.findAllByText("Quy trình A")).length
    ).toBeGreaterThan(0);

    expect(
      screen.queryByRole("button", {
        name: /Chạy thử|Hoàn thành bước này|Dừng hồ sơ|Hủy lượt chạy|Duyệt/,
      })
    ).toBeNull();

    const casesTable = screen.getByRole("table", {
      name: viStrings.workflows.casesTitle,
    });
    expect(within(casesTable).getByText("case-running")).toBeInTheDocument();
    expect(within(casesTable).queryByText("case-completed")).toBeNull();
    expect(screen.queryByText("Bước một")).toBeNull();
    expect(screen.queryByText("Chuyên viên A")).toBeNull();
    expect(screen.queryByText("Tiêu đề nội bộ")).toBeNull();

    fireEvent.click(
      screen.getByRole("tab", {
        name: new RegExp(viStrings.workflows.filterCancelled),
      })
    );
    const cancelledTable = screen.getByRole("table", {
      name: viStrings.workflows.casesTitle,
    });
    expect(
      within(cancelledTable).getByText("case-cancelled")
    ).toBeInTheDocument();

    const summaryTable = screen.getByRole("table", {
      name: viStrings.workflows.summaryTitle,
    });
    fireEvent.click(
      within(summaryTable).getByRole("button", {
        name: "Quy trình A",
      })
    );
    const dialog = await screen.findByRole("dialog", {
      name: viStrings.workflows.stepsTitle,
    });
    expect(within(dialog).getByText("Bước một")).toBeInTheDocument();
    expect(within(dialog).getByText("Nhóm B")).toBeInTheDocument();
  });
});
