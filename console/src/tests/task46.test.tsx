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

function summaryFixture() {
  return {
    applications: [
      {
        id: "app-records",
        name: "Sổ hồ sơ",
        state: "active",
        collections: [
          { name: "nguoi-nop", records: 40, updatedAt: "2026-11-10T00:28:20.543Z" },
          { name: "chung-tu", records: 50, updatedAt: "2026-11-10T00:28:23.476Z" },
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
        state: "active",
        collections: [],
        files: { count: 0, bytes: 0, quarantined: 0, updatedAt: null },
      },
    ],
    totals: {
      collections: [
        { name: "nguoi-nop", records: 40, updatedAt: "2026-11-10T05:16:58.689Z" },
        { name: "chung-tu", records: 50, updatedAt: "2026-11-10T05:17:01.119Z" },
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

function collectionsFixture() {
  return {
    application: { id: "app-records", name: "Sổ hồ sơ" },
    collections: [
      {
        name: "nguoi-nop",
        records: 40,
        updatedAt: "2026-11-10T00:28:20.543Z",
        fields: [
          { name: "ho_ten", type: "string", fillRate: 100 },
          { name: "tuoi", type: "number", fillRate: 75 },
          { name: "da_tiem", type: "boolean", fillRate: 40 },
          { name: "tai_lieu", type: "array", fillRate: 18 },
          { name: "ghi_chu", type: "mixed", fillRate: 0 },
        ],
      },
    ],
  };
}

function filesFixture() {
  const root = {
    application: { id: "app-records", name: "Sổ hồ sơ" },
    path: "/",
    folders: [
      {
        name: "ho-so",
        files: 2,
        bytes: 536,
        updatedAt: "2026-11-10T06:31:06.258Z",
      },
    ],
    files: [
      {
        name: "ba…01.txt",
        extension: "txt",
        bytes: 120,
        status: "clean",
        updatedAt: "2026-11-10T06:31:05.943Z",
      },
    ],
    truncated: false,
  };
  const folder = {
    application: { id: "app-records", name: "Sổ hồ sơ" },
    path: "/ho-so",
    folders: [],
    files: [
      {
        name: "đơn…05.txt",
        extension: "txt",
        bytes: 290,
        status: "clean",
        updatedAt: "2026-11-10T06:31:05.943Z",
      },
      {
        name: "đơn…06.txt",
        extension: "txt",
        bytes: 246,
        status: "quarantined",
        updatedAt: "2026-11-10T06:31:06.258Z",
      },
    ],
    truncated: false,
  };
  return (path: string) => (path === "/ho-so" ? folder : root);
}

function orgFixture() {
  return {
    root: {
      id: "tenant-test",
      name: "tenant-test",
      kind: "platform",
      children: [
        { id: "unit-a", name: "Đơn vị tiếp nhận", kind: "application", children: [] },
        { id: "unit-b", name: "Đơn vị xét duyệt", kind: "organization", children: [] },
        { id: "unit-c", name: "Đơn vị đề nghị", kind: "application", children: [] },
      ],
    },
    relations: [
      { from: "unit-a", to: "unit-b", label: "Tóm tắt hồ sơ" },
      { from: "unit-b", to: "unit-c", label: "Chứng từ" },
    ],
    truncated: false,
  };
}

describe("Task 46 — collection structure", () => {
  beforeEach(resetState);

  it("shows field names, Vietnamese types and fill rates without values", async () => {
    installApiFetch([
      (url) =>
        url.includes("/v1/storage/collections")
          ? json(200, collectionsFixture())
          : url.includes("/v1/storage/summary")
            ? json(200, summaryFixture())
            : undefined,
    ]);
    await openScreen("records", viStrings.records.title);

    fireEvent.click(
      await screen.findByRole("button", {
        name: viStrings.records.viewStructure.replace("{name}", "Người nộp"),
      })
    );

    expect(await screen.findByText("ho_ten")).toBeInTheDocument();
    expect(screen.getByText(viStrings.records.fieldTypes.string)).toBeInTheDocument();
    expect(screen.getByText(viStrings.records.fieldTypes.number)).toBeInTheDocument();
    expect(
      screen.getByText(viStrings.records.fieldTypes.boolean)
    ).toBeInTheDocument();
    expect(
      screen.getByText(viStrings.records.fieldTypes.array)
    ).toBeInTheDocument();
    expect(
      screen.getByText(viStrings.records.fieldTypes.mixed)
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: viStrings.records.fieldFillAria
          .replace("{name}", "tuoi")
          .replace("{percent}", "75"),
      })
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        viStrings.records.structureBelongs.replace("{app}", "Sổ hồ sơ")
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /tạo|sửa|xóa|create|edit|delete/i })
    ).toBeNull();
    expect(screen.queryByText(/Nguyễn Văn/)).toBeNull();
  });

  it("shows a clear structure error and retries", async () => {
    let collectionCalls = 0;
    installApiFetch([
      (url) => {
        if (url.includes("/v1/storage/collections")) {
          collectionCalls += 1;
          if (collectionCalls === 1) {
            return json(503, { error: "storage_collections_unavailable" });
          }
          return json(200, collectionsFixture());
        }
        if (url.includes("/v1/storage/summary")) return json(200, summaryFixture());
        return undefined;
      },
    ]);
    await openScreen("records", viStrings.records.title);
    fireEvent.click(
      await screen.findByRole("button", {
        name: viStrings.records.viewStructure.replace("{name}", "Người nộp"),
      })
    );
    expect(
      await screen.findByText(viStrings.records.structureErrorTitle)
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: viStrings.common.retry })
    );
    expect(await screen.findByText("ho_ten")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: viStrings.records.structureClose })
    ).toBeInTheDocument();
  });
});

describe("Task 46 — folder file manager", () => {
  beforeEach(resetState);

  it("navigates folders, shows breadcrumbs and keeps masked API names", async () => {
    const byPath = filesFixture();
    installApiFetch([
      (url) => {
        if (url.includes("/v1/storage/files")) {
          const parsed = new URL(url, "http://localhost");
          return json(200, byPath(parsed.searchParams.get("path") ?? "/"));
        }
        if (url.includes("/v1/storage/summary")) return json(200, summaryFixture());
        return undefined;
      },
    ]);
    await openScreen("files", viStrings.files.title);

    expect((await screen.findAllByText("Sổ hồ sơ")).length).toBeGreaterThan(
      0
    );
    expect(await screen.findByText("ba…01.txt")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: viStrings.files.openFolder.replace("{name}", "ho-so"),
      })
    );

    const breadcrumb = await screen.findByRole("navigation", {
      name: viStrings.files.breadcrumbLabel,
    });
    expect(within(breadcrumb).getByText("ho-so")).toBeInTheDocument();
    expect(await screen.findByText("đơn…05.txt")).toBeInTheDocument();
    expect(screen.getByText("đơn…06.txt")).toBeInTheDocument();
    expect(screen.getByText(viStrings.files.statusQuarantined)).toBeInTheDocument();

    expect(
      screen.queryByRole("button", {
        name: /tải lên|tải về|xem trước|xóa|upload|download|preview|delete/i,
      })
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: viStrings.files.viewGrid })
    );
    expect(
      screen.getByRole("button", { name: viStrings.files.viewGrid })
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("đơn…05.txt")).toBeInTheDocument();
  });

  it("returns to the root through the breadcrumb", async () => {
    const byPath = filesFixture();
    installApiFetch([
      (url) => {
        if (url.includes("/v1/storage/files")) {
          const parsed = new URL(url, "http://localhost");
          return json(200, byPath(parsed.searchParams.get("path") ?? "/"));
        }
        if (url.includes("/v1/storage/summary")) return json(200, summaryFixture());
        return undefined;
      },
    ]);
    await openScreen("files", viStrings.files.title);
    fireEvent.click(
      await screen.findByRole("button", {
        name: viStrings.files.openFolder.replace("{name}", "ho-so"),
      })
    );
    await screen.findByText("đơn…05.txt");

    const breadcrumb = screen.getByRole("navigation", {
      name: viStrings.files.breadcrumbLabel,
    });
    fireEvent.click(
      within(breadcrumb).getByRole("button", {
        name: viStrings.files.rootCrumb,
      })
    );
    expect(await screen.findByText("ba…01.txt")).toBeInTheDocument();
  });
});

describe("Task 46 — organisation layout and recovery", () => {
  beforeEach(resetState);

  it.each([375, 768, 1440, 1900])(
    "renders the full-width tree and relations without a fixed detail column at %ipx",
    async (width) => {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: width,
      });
      installApiFetch([
        (url) =>
          url.includes("/v1/directory/organizations")
            ? json(200, orgFixture())
            : undefined,
      ]);
      await openScreen("orgs", viStrings.orgs.title);
      expect(screen.getByText(viStrings.orgs.treeTitle)).toBeInTheDocument();
      expect(
        screen.queryByText(viStrings.orgs.detailTitle)
      ).toBeNull();
      expect(
        screen.getByText(viStrings.orgs.relationsTitle)
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Đơn vị tiếp nhận" })
      ).toBeInTheDocument();
      expect(
        screen.getByText("Đơn vị tiếp nhận → Đơn vị xét duyệt")
      ).toBeInTheDocument();
    }
  );

  it("opens a unit note next to the tree and closes it with Escape", async () => {
    installApiFetch([
      (url) =>
        url.includes("/v1/directory/organizations")
          ? json(200, orgFixture())
          : undefined,
    ]);
    await openScreen("orgs", viStrings.orgs.title);

    const unit = screen.getByRole("button", { name: "Đơn vị tiếp nhận" });
    fireEvent.click(unit);

    const note = await screen.findByRole("dialog", {
      name: viStrings.orgs.detailTitle,
    });
    expect(within(note).getByText(viStrings.orgs.kindApplication)).toBeInTheDocument();
    expect(
      within(note).getByText("Đơn vị tiếp nhận → Đơn vị xét duyệt")
    ).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(
      screen.queryByRole("dialog", { name: viStrings.orgs.detailTitle })
    ).toBeNull();
  });

  it("shows the platform summary note when the root is selected", async () => {
    installApiFetch([
      (url) =>
        url.includes("/v1/directory/organizations")
          ? json(200, orgFixture())
          : undefined,
    ]);
    await openScreen("orgs", viStrings.orgs.title);

    fireEvent.click(
      screen.getByRole("button", { name: viStrings.orgs.platformRootName })
    );
    const note = await screen.findByRole("dialog", {
      name: viStrings.orgs.detailTitle,
    });
    expect(within(note).getByText(viStrings.orgs.rootDetailDesc)).toBeInTheDocument();
    expect(within(note).getByText(viStrings.orgs.totalUnits)).toBeInTheDocument();
  });

  it("explains an expired session and retries the directory request", async () => {
    let calls = 0;
    installApiFetch([
      (url) => {
        if (!url.includes("/v1/directory/organizations")) return undefined;
        calls += 1;
        if (calls === 1) return json(401, { error: "token_expired" });
        return json(200, orgFixture());
      },
    ]);
    await openScreen("orgs", viStrings.orgs.title);
    expect(
      await screen.findByText(viStrings.orgs.sessionExpiredTitle)
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: viStrings.common.retry })
    );
    expect(
      await screen.findByText(viStrings.orgs.treeTitle)
    ).toBeInTheDocument();
  });
});
