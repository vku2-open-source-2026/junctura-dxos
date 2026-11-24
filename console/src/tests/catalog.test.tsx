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
import type { CapabilityCatalogItem } from "../types";

function resetState() {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  api.setBaseUrl("/api");
  api.setToken("test-token");
}

function catalogItem(overrides: Partial<CapabilityCatalogItem> = {}): CapabilityCatalogItem {
  return {
    capabilityId: "urn:junctura:capability:11111111-1111-4111-8111-111111111111:echo",
    versionId: "22222222-2222-4222-8222-222222222222",
    providerAppId: "33333333-3333-4333-8333-333333333333",
    version: "1.0.0",
    digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    state: "published",
    visibility: "tenant",
    title: "Kỹ thuật echo",
    description: "Trả lại giá trị được cung cấp.",
    publishedAt: "2026-01-01T00:00:00Z",
    myAccess: "none",
    ...overrides,
  };
}

async function openCatalog() {
  window.history.replaceState(null, "", "/#/dashboard");
  render(<App />);
  await screen.findByRole("heading", {
    level: 1,
    name: viStrings.dashboard.title,
  });
  window.location.hash = "#/catalog";
  fireEvent(window, new HashChangeEvent("hashchange"));
  await screen.findByRole("heading", {
    level: 1,
    name: viStrings.catalog.title,
  });
}

function catalogRoutes(pages: { items: CapabilityCatalogItem[]; nextCursor: string | null }[]) {
  let call = 0;
  return [
    (url: string) => {
      if (!url.includes("/v1/capabilities/catalog")) return undefined;
      const page = pages[Math.min(call, pages.length - 1)];
      call += 1;
      return json(200, page);
    },
  ];
}

describe("Catalog screen", () => {
  beforeEach(resetState);

  it("fetches the catalog with the page limit and renders rows", async () => {
    const fetchMock = installApiFetch(
      catalogRoutes([
        {
          items: [
            catalogItem(),
            catalogItem({
              capabilityId: "urn:junctura:capability:44444444-4444-4444-8444-444444444444:sign",
              version: "2.1.0",
              title: "Ký số",
              providerAppId: "55555555-5555-4555-8555-555555555555",
              visibility: "units",
              myAccess: "granted",
            }),
          ],
          nextCursor: null,
        },
      ])
    );

    await openCatalog();

    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(
      urls.some((url) => url.includes("/api/v1/capabilities/catalog?limit=50"))
    ).toBe(true);
    expect(screen.getByText("Kỹ thuật echo")).toBeInTheDocument();
    expect(screen.getByText("Ký số")).toBeInTheDocument();
    expect(
      screen.getByText("33333333-3333-4333-8333-333333333333")
    ).toBeInTheDocument();
    expect(screen.getAllByText("1.0.0").length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(viStrings.catalog.visibilityTenant).length
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(viStrings.catalog.accessGranted).length
    ).toBeGreaterThan(0);
  });

  it("loads the next page with the cursor and appends rows", async () => {
    const fetchMock = installApiFetch(
      catalogRoutes([
        { items: [catalogItem()], nextCursor: "abc123" },
        {
          items: [
            catalogItem({
              capabilityId: "urn:junctura:capability:44444444-4444-4444-8444-444444444444:sign",
              title: "Ký số",
            }),
          ],
          nextCursor: null,
        },
      ])
    );

    await openCatalog();

    expect(screen.queryByText("Ký số")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: viStrings.catalog.nextPage })
    );

    expect(await screen.findByText("Ký số")).toBeInTheDocument();
    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(
      urls.some((url) =>
        url.includes("/api/v1/capabilities/catalog?limit=50&cursor=abc123")
      )
    ).toBe(true);
    expect(screen.getByText("Kỹ thuật echo")).toBeInTheDocument();
  });

  it("keeps the request action disabled once access exists", async () => {
    installApiFetch(
      catalogRoutes([
        {
          items: [
            catalogItem(),
            catalogItem({
              capabilityId: "urn:junctura:capability:44444444-4444-4444-8444-444444444444:sign",
              title: "Ký số",
              myAccess: "requested",
            }),
            catalogItem({
              capabilityId: "urn:junctura:capability:66666666-6666-4666-8666-666666666666:chart",
              title: "Biểu đồ",
              myAccess: "granted",
            }),
          ],
          nextCursor: null,
        },
      ])
    );

    await openCatalog();

    const buttons = screen.getAllByRole("button", {
      name: viStrings.catalog.requestButton,
    });
    expect(buttons.length).toBe(3);
    const enabled = buttons.filter(
      (button) => button.getAttribute("disabled") === null
    );
    expect(enabled.length).toBe(1);
    const row = screen.getByText("Ký số").closest("tr");
    expect(row).not.toBeNull();
    if (row) {
      expect(
        within(row).getByRole("button", {
          name: viStrings.catalog.requestButton,
        })
      ).toBeDisabled();
      expect(
        within(row).getByText(viStrings.catalog.accessRequested)
      ).toBeInTheDocument();
    }
  });

  it("posts the access request with a trimmed purpose and an idempotency key", async () => {
    const posts: { url: string; init: RequestInit }[] = [];
    installApiFetch([
      (url, init) => {
        if (
          url.includes("/v1/trust/access-requests") &&
          init?.method === "POST"
        ) {
          posts.push({ url, init });
          return json(201, {
            requestId: "77777777-7777-4777-8777-777777777777",
            providerAppId: "33333333-3333-4333-8333-333333333333",
            consumerAppId: "88888888-8888-4888-8888-888888888888",
            capabilityId:
              "urn:junctura:capability:11111111-1111-4111-8111-111111111111:echo",
            version: "1.0.0",
            manifestDigest:
              "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            purpose: "Cần dùng để kiểm thử liên ứng",
            state: "pending",
            reason: null,
            grantId: null,
            createdAt: "2026-11-24T00:00:00Z",
            updatedAt: "2026-11-24T00:00:00Z",
          });
        }
        return undefined;
      },
      ...catalogRoutes([{ items: [catalogItem()], nextCursor: null }]),
    ]);

    await openCatalog();

    fireEvent.click(
      screen.getByRole("button", { name: viStrings.catalog.requestButton })
    );
    expect(
      await screen.findByText(viStrings.catalog.requestTitle)
    ).toBeInTheDocument();

    const confirm = screen.getByRole("button", {
      name: viStrings.catalog.requestConfirm,
    });
    expect(confirm).toBeDisabled();
    fireEvent.change(
      screen.getByLabelText(viStrings.catalog.requestPurposeLabel),
      { target: { value: "  Cần dùng để kiểm thử liên ứng  " } }
    );
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    expect(await screen.findByText(viStrings.catalog.requestDone)).toBeInTheDocument();
    expect(posts.length).toBe(1);
    const headers = posts[0].init.headers as Headers;
    expect(posts[0].url).toContain("/api/v1/trust/access-requests");
    expect(headers.get("Idempotency-Key")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(JSON.parse(String(posts[0].init.body))).toEqual({
      capabilityId:
        "urn:junctura:capability:11111111-1111-4111-8111-111111111111:echo",
      version: "1.0.0",
      purpose: "Cần dùng để kiểm thử liên ứng",
    });

    const row = screen.getByText("Kỹ thuật echo").closest("tr");
    expect(row).not.toBeNull();
    if (row) {
      expect(
        within(row).getByText(viStrings.catalog.accessRequested)
      ).toBeInTheDocument();
      expect(
        within(row).getByRole("button", {
          name: viStrings.catalog.requestButton,
        })
      ).toBeDisabled();
    }
  });

  it("keeps the dialog open with an alert when the request fails", async () => {
    installApiFetch([
      (url, init) =>
        url.includes("/v1/trust/access-requests") && init?.method === "POST"
          ? json(409, { error: "idempotency_key_reused" })
          : undefined,
      ...catalogRoutes([{ items: [catalogItem()], nextCursor: null }]),
    ]);

    await openCatalog();

    fireEvent.click(
      screen.getByRole("button", { name: viStrings.catalog.requestButton })
    );
    fireEvent.change(
      await screen.findByLabelText(viStrings.catalog.requestPurposeLabel),
      { target: { value: "Cần dùng để kiểm thử liên ứng" } }
    );
    fireEvent.click(
      screen.getByRole("button", { name: viStrings.catalog.requestConfirm })
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      viStrings.catalog.requestError
    );
    expect(screen.getByText(viStrings.catalog.requestTitle)).toBeInTheDocument();
  });

  it("shows an error state when the catalog cannot load", async () => {
    installApiFetch([
      (url) =>
        url.includes("/v1/capabilities/catalog")
          ? json(503, { error: "capability_catalog_unavailable" })
          : undefined,
    ]);

    await openCatalog();

    expect(
      await screen.findByText(viStrings.catalog.loadErrorTitle)
    ).toBeInTheDocument();
  });

  it("shows the forbidden notice when the catalog rejects the reader", async () => {
    installApiFetch([
      (url) =>
        url.includes("/v1/capabilities/catalog") ? json(403, {}) : undefined,
    ]);

    await openCatalog();

    expect(
      await screen.findByText(viStrings.common.forbiddenView)
    ).toBeInTheDocument();
  });
});
