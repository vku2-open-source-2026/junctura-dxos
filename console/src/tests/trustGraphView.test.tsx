// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { I18nProvider } from "../locales/i18n";
import { TrustGraphView } from "../components/explainers/TrustGraphView";
import type { TrustGraph } from "../types";

const now = Date.parse("2026-11-09T00:00:00Z");
const day = 86_400_000;
const graph: TrustGraph = {
  scope: "tenant",
  truncated: false,
  generatedAt: new Date(now).toISOString(),
  nodes: [
    { appId: "a", displayName: "Phòng Đào tạo", state: "active", owned: true },
    { appId: "b", displayName: "Thư viện", state: "active", owned: false },
    { appId: "c", displayName: "Ký túc xá", state: "active", owned: false },
  ],
  edges: [
    { grantId: "g1", providerAppId: "a", consumerAppId: "b", capabilityId: "x", version: "1.0.0", title: "Tra cứu sinh viên",
      operations: ["discover", "invoke"], revision: 1, state: "active", createdAt: new Date(now).toISOString(),
      activatedAt: new Date(now - day).toISOString(), revokedAt: null, expiresAt: new Date(now + 40 * day).toISOString() },
    { grantId: "g2", providerAppId: "a", consumerAppId: "c", capabilityId: "y", version: "2.0.0", title: "Bảng điểm",
      operations: ["invoke"], revision: 1, state: "pending", createdAt: new Date(now).toISOString(),
      activatedAt: null, revokedAt: null, expiresAt: new Date(now + 10 * day).toISOString() },
  ],
};

const renderView = (onRevoke = vi.fn()) =>
  render(<I18nProvider><TrustGraphView graph={graph} now={now} canRevoke onRevoke={onRevoke} /></I18nProvider>);

describe("TrustGraphView", () => {
  it("enlarges the clicked node and shows its info without moving others", () => {
    renderView();
    const node = screen.getByTestId("tg-node-a");
    const before = screen.getByTestId("tg-node-b").innerHTML;
    fireEvent.click(node);
    expect(node.getAttribute("aria-pressed")).toBe("true");
    expect(node.innerHTML).toContain("scale(1.25)");
    expect(screen.getByTestId("tg-node-b").innerHTML).toBe(before);
    const card = screen.getByRole("complementary");
    expect(within(card).getByText("Phòng Đào tạo")).toBeTruthy();
    expect(within(card).getByText(/Cho ứng dụng khác dùng 2 quyền/)).toBeTruthy();
  });

  it("shows edge details in plain words and never exposes ids or versions", () => {
    renderView();
    fireEvent.click(screen.getByTestId("tg-edge-g1"));
    const card = screen.getByRole("complementary");
    expect(within(card).getByText("Tra cứu sinh viên")).toBeTruthy();
    expect(within(card).getByText(/Phòng Đào tạo cho Thư viện dùng/)).toBeTruthy();
    expect(within(card).getByText(/gọi chức năng/)).toBeTruthy();
    expect(card.textContent).not.toContain("1.0.0");
    expect(card.textContent).not.toContain("v1");
  });

  it("revokes only after a reason is given", () => {
    const onRevoke = vi.fn();
    renderView(onRevoke);
    fireEvent.click(screen.getByTestId("tg-edge-g1"));
    fireEvent.click(screen.getByRole("button", { name: "Thu hồi quyền này" }));
    const confirm = screen.getByRole("button", { name: "Xác nhận thu hồi" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Lý do thu hồi"), { target: { value: "hết nhu cầu" } });
    fireEvent.click(confirm);
    expect(onRevoke).toHaveBeenCalledWith(graph.edges[0], "hết nhu cầu");
  });

  it("filters by state and supports the keyboard", () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: /Chờ duyệt · 1/ }));
    expect(screen.queryByTestId("tg-edge-g1")).toBeNull();
    fireEvent.keyDown(screen.getByTestId("tg-edge-g2"), { key: "Enter" });
    expect(within(screen.getByRole("complementary")).getByText("Bảng điểm")).toBeTruthy();
  });
});
