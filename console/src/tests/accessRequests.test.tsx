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
import type {
  ApiPage,
  CapabilityAccessRequest,
} from "../types";

function resetState() {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  api.setBaseUrl("/api");
  api.setToken("test-token");
}

function accessRequest(
  overrides: Partial<CapabilityAccessRequest> = {}
): CapabilityAccessRequest {
  return {
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
    createdAt: "2026-11-20T00:00:00Z",
    updatedAt: "2026-11-20T00:00:00Z",
    ...overrides,
  };
}

function listRoutes(
  incoming: ApiPage<CapabilityAccessRequest>,
  outgoing: ApiPage<CapabilityAccessRequest> = { items: [], nextCursor: null }
) {
  return [
    (url: string, init?: RequestInit) => {
      if (!url.includes("/v1/trust/access-requests")) return undefined;
      if (init?.method === "POST") return undefined;
      const page = url.includes("direction=outgoing") ? outgoing : incoming;
      return json(200, page);
    },
  ];
}

function pagedIncomingRoutes(
  pages: ApiPage<CapabilityAccessRequest>[]
) {
  let call = 0;
  return [
    (url: string, init?: RequestInit) => {
      if (!url.includes("/v1/trust/access-requests")) return undefined;
      if (init?.method === "POST") return undefined;
      const page = pages[Math.min(call, pages.length - 1)];
      call += 1;
      return json(200, page);
    },
  ];
}

function outgoingRequest(): CapabilityAccessRequest {
  return accessRequest({
    providerAppId: "88888888-8888-4888-8888-888888888888",
    consumerAppId: "99999999-9999-4999-8999-999999999999",
  });
}

async function openAccessRequests() {
  window.history.replaceState(null, "", "/#/dashboard");
  render(<App />);
  await screen.findByRole("heading", {
    level: 1,
    name: viStrings.dashboard.title,
  });
  window.location.hash = "#/access-requests";
  fireEvent(window, new HashChangeEvent("hashchange"));
  await screen.findByRole("heading", {
    level: 1,
    name: viStrings.accessRequests.title,
  });
}

describe("Access requests screen", () => {
  beforeEach(resetState);

  it("fetches incoming requests with the direction filter and renders rows", async () => {
    const fetchMock = installApiFetch(
      listRoutes({
        items: [
          accessRequest(),
          accessRequest({
            requestId: "99999999-9999-4999-8999-999999999999",
            consumerAppId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            purpose: "Đối chiếu số liệu báo cáo định kỳ",
            capabilityId:
              "urn:junctura:capability:44444444-4444-4444-8444-444444444444:sign",
            version: "2.1.0",
            state: "accepted",
            grantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          }),
        ],
        nextCursor: null,
      })
    );

    await openAccessRequests();

    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(
      urls.some((url) =>
        url.includes(
          "/api/v1/trust/access-requests?limit=50&direction=incoming"
        )
      )
    ).toBe(true);
    expect(
      screen.getByText("88888888-8888-4888-8888-888888888888")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Cần dùng để kiểm thử liên ứng")
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "urn:junctura:capability:11111111-1111-4111-8111-111111111111:echo"
      )
    ).toBeInTheDocument();
    expect(screen.getAllByText(viStrings.accessRequests.statePending).length).toBe(
      1
    );
    expect(
      screen.getAllByText(viStrings.accessRequests.stateAccepted).length
    ).toBe(1);
  });

  it("loads the next page of the active tab with the cursor", async () => {
    installApiFetch(
      pagedIncomingRoutes([
        {
          items: [accessRequest()],
          nextCursor: "abc123",
        },
        {
          items: [
            accessRequest({
              requestId: "99999999-9999-4999-8999-999999999999",
              purpose: "Yêu cầu trang kế",
            }),
          ],
          nextCursor: null,
        },
      ])
    );

    await openAccessRequests();

    fireEvent.click(
      screen.getByRole("button", { name: viStrings.accessRequests.nextPage })
    );

    expect(await screen.findByText("Yêu cầu trang kế")).toBeInTheDocument();
  });

  it("accepts a pending incoming request", async () => {
    const posts: { url: string; init: RequestInit }[] = [];
    installApiFetch([
      (url, init) => {
        if (
          url.includes("/v1/trust/access-requests/77777777-7777-4777-8777-777777777777/accept") &&
          init?.method === "POST"
        ) {
          posts.push({ url, init });
          return json(200, accessRequest({ state: "accepted", grantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }));
        }
        return undefined;
      },
      ...listRoutes({ items: [accessRequest()], nextCursor: null }),
    ]);

    await openAccessRequests();

    const row = screen
      .getByText("88888888-8888-4888-8888-888888888888")
      .closest("tr");
    expect(row).not.toBeNull();
    if (!row) return;
    fireEvent.click(
      within(row).getByRole("button", {
        name: viStrings.accessRequests.acceptButton,
      })
    );

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(viStrings.accessRequests.acceptTitle)
    ).toBeInTheDocument();
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: viStrings.accessRequests.acceptButton,
      })
    );

    expect(await screen.findByText(viStrings.accessRequests.acceptDone)).toBeInTheDocument();
    expect(posts.length).toBe(1);
    expect(posts[0].url).toContain(
      "/api/v1/trust/access-requests/77777777-7777-4777-8777-777777777777/accept"
    );
    expect(posts[0].init.method).toBe("POST");
    expect(JSON.parse(String(posts[0].init.body))).toEqual({});

    expect(
      await screen.findByText(viStrings.accessRequests.stateAccepted)
    ).toBeInTheDocument();
  });

  it("declines a pending incoming request with a reason", async () => {
    const posts: { url: string; init: RequestInit }[] = [];
    installApiFetch([
      (url, init) => {
        if (
          url.includes("/v1/trust/access-requests/77777777-7777-4777-8777-777777777777/decline") &&
          init?.method === "POST"
        ) {
          posts.push({ url, init });
          return json(
            200,
            accessRequest({ state: "declined", reason: "Không phù hợp với phạm vi dữ liệu" })
          );
        }
        return undefined;
      },
      ...listRoutes({ items: [accessRequest()], nextCursor: null }),
    ]);

    await openAccessRequests();

    const row = screen
      .getByText("88888888-8888-4888-8888-888888888888")
      .closest("tr");
    expect(row).not.toBeNull();
    if (!row) return;
    fireEvent.click(
      within(row).getByRole("button", {
        name: viStrings.accessRequests.declineButton,
      })
    );

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(viStrings.accessRequests.declineTitle)
    ).toBeInTheDocument();
    const confirm = within(dialog).getByRole("button", {
      name: viStrings.accessRequests.declineButton,
    });
    expect(confirm).toBeDisabled();

    fireEvent.change(
      within(dialog).getByLabelText(viStrings.accessRequests.reasonLabel),
      { target: { value: "  Không phù hợp với phạm vi dữ liệu  " } }
    );
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    expect(await screen.findByText(viStrings.accessRequests.declineDone)).toBeInTheDocument();
    expect(posts.length).toBe(1);
    expect(posts[0].url).toContain(
      "/api/v1/trust/access-requests/77777777-7777-4777-8777-777777777777/decline"
    );
    expect(JSON.parse(String(posts[0].init.body))).toEqual({
      reason: "Không phù hợp với phạm vi dữ liệu",
    });

    expect(
      await screen.findByText(viStrings.accessRequests.stateDeclined)
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        `${viStrings.accessRequests.declineReasonPrefix}Không phù hợp với phạm vi dữ liệu`
      )
    ).toBeInTheDocument();
  });

  it("keeps the decline dialog open with an alert when the decision fails", async () => {
    installApiFetch([
      (url, init) =>
        url.includes("/77777777-7777-4777-8777-777777777777/decline") &&
        init?.method === "POST"
          ? json(409, { error: "request_not_pending" })
          : undefined,
      ...listRoutes({ items: [accessRequest()], nextCursor: null }),
    ]);

    await openAccessRequests();

    fireEvent.click(
      screen.getByRole("button", {
        name: viStrings.accessRequests.declineButton,
      })
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(
      within(dialog).getByLabelText(viStrings.accessRequests.reasonLabel),
      { target: { value: "Không phù hợp với phạm vi dữ liệu" } }
    );
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: viStrings.accessRequests.declineButton,
      })
    );

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      viStrings.accessRequests.actionError
    );
    expect(
      within(dialog).getByText(viStrings.accessRequests.declineTitle)
    ).toBeInTheDocument();
  });

  it("withdraws a pending outgoing request", async () => {
    const posts: { url: string; init: RequestInit }[] = [];
    installApiFetch([
      (url, init) => {
        if (
          url.includes("/v1/trust/access-requests/77777777-7777-4777-8777-777777777777/withdraw") &&
          init?.method === "POST"
        ) {
          posts.push({ url, init });
          return json(200, accessRequest({ state: "withdrawn" }));
        }
        return undefined;
      },
      ...listRoutes(
        { items: [], nextCursor: null },
        { items: [outgoingRequest()], nextCursor: null }
      ),
    ]);

    await openAccessRequests();

    fireEvent.click(
      screen.getByRole("tab", { name: viStrings.accessRequests.tabOutgoing })
    );

    const row = await screen.findByText("88888888-8888-4888-8888-888888888888");
    expect(row).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: viStrings.accessRequests.withdrawButton,
      })
    );

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(viStrings.accessRequests.withdrawTitle)
    ).toBeInTheDocument();
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: viStrings.accessRequests.withdrawButton,
      })
    );

    expect(await screen.findByText(viStrings.accessRequests.withdrawDone)).toBeInTheDocument();
    expect(posts.length).toBe(1);
    expect(posts[0].url).toContain(
      "/api/v1/trust/access-requests/77777777-7777-4777-8777-777777777777/withdraw"
    );
    expect(JSON.parse(String(posts[0].init.body))).toEqual({});

    expect(
      await screen.findByText(viStrings.accessRequests.stateWithdrawn)
    ).toBeInTheDocument();
  });

  it("loads the outgoing list with the direction filter when the tab opens", async () => {
    const fetchMock = installApiFetch(
      listRoutes(
        { items: [], nextCursor: null },
        { items: [outgoingRequest()], nextCursor: null }
      )
    );

    await openAccessRequests();

    fireEvent.click(
      screen.getByRole("tab", { name: viStrings.accessRequests.tabOutgoing })
    );

    expect(
      await screen.findByText("88888888-8888-4888-8888-888888888888")
    ).toBeInTheDocument();
    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(
      urls.some((url) =>
        url.includes("/api/v1/trust/access-requests?limit=50&direction=outgoing")
      )
    ).toBe(true);
    expect(
      screen.getByRole("button", {
        name: viStrings.accessRequests.withdrawButton,
      })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: viStrings.accessRequests.acceptButton,
      })
    ).toBeNull();
  });

  it("shows an error state when the request list cannot load", async () => {
    installApiFetch([
      (url) =>
        url.includes("/v1/trust/access-requests")
          ? json(503, { error: "access_requests_unavailable" })
          : undefined,
    ]);

    await openAccessRequests();

    expect(
      await screen.findByText(viStrings.accessRequests.loadErrorTitle)
    ).toBeInTheDocument();
  });

  it("shows the forbidden notice when the list rejects the reader", async () => {
    installApiFetch([
      (url) =>
        url.includes("/v1/trust/access-requests") ? json(403, {}) : undefined,
    ]);

    await openAccessRequests();

    expect(
      await screen.findByText(viStrings.common.forbiddenView)
    ).toBeInTheDocument();
  });
});
