// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, isApprovedBaseUrl } from "../services/apiClient";
import type { TrustGraphEdge } from "../types";

function jsonResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const IDENTITY = {
  subject: "operator-live",
  tenantId: "tenant-live",
  roles: ["core-reader"],
};

function grantEdge(overrides: Partial<TrustGraphEdge> = {}): TrustGraphEdge {
  return {
    grantId: "grant-1",
    providerAppId: "app-provider",
    consumerAppId: "app-consumer",
    capabilityId: "cap-1",
    version: "1.0.0",
    title: "Chia sẻ dữ liệu",
    operations: ["invoke"],
    revision: 3,
    state: "active",
    createdAt: "2026-11-01T00:00:00.000Z",
    activatedAt: "2026-11-01T00:00:00.000Z",
    revokedAt: null,
    expiresAt: "2027-11-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("ApiClient session boundaries", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("does not restore or persist bearer tokens", () => {
    localStorage.setItem("junctura_token", "legacy-secret");
    const client = new ApiClient();

    expect(client.getToken()).toBeNull();
    expect(localStorage.getItem("junctura_token")).toBeNull();

    client.setToken("memory-secret");
    expect(client.getToken()).toBe("memory-secret");
    expect(localStorage.getItem("junctura_token")).toBeNull();

    client.setToken(null);
    expect(client.getToken()).toBeNull();
    expect(localStorage.getItem("junctura_token")).toBeNull();
  });

  it("rejects stored gateway origins that are neither same-origin nor loopback", () => {
    localStorage.setItem("junctura_gateway_url", "https://evil.example");
    const client = new ApiClient();

    expect(client.getBaseUrl()).toBe("/api");
    expect(localStorage.getItem("junctura_gateway_url")).toBeNull();
    expect(() => client.setBaseUrl("https://evil.example")).toThrow(
      "gateway_origin_not_approved"
    );
    expect(isApprovedBaseUrl("/api")).toBe(true);
    expect(isApprovedBaseUrl("http://127.0.0.1:8080")).toBe(true);
    expect(isApprovedBaseUrl("http://localhost:8080/")).toBe(true);
    expect(isApprovedBaseUrl("//evil.example")).toBe(false);
    expect(isApprovedBaseUrl("https://evil.example")).toBe(false);
  });

  it("never sends Authorization to an unapproved origin", async () => {
    const client = new ApiClient();
    client.setToken("memory-secret");
    (client as unknown as { baseUrl: string }).baseUrl = "https://evil.example";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await client.getIdentity();

    expect(result.status).toBe("unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("distinguishes missing, rejected, forbidden, unavailable and timed-out identity", async () => {
    const missingToken = new ApiClient();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(missingToken.getIdentity()).resolves.toMatchObject({
      status: "missing",
    });
    expect(fetchMock).not.toHaveBeenCalled();

    const rejected = new ApiClient();
    rejected.setToken("token");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401)));
    await expect(rejected.getIdentity()).resolves.toMatchObject({
      status: "rejected",
    });

    const forbidden = new ApiClient();
    forbidden.setToken("token");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(403)));
    await expect(forbidden.getIdentity()).resolves.toMatchObject({
      status: "forbidden",
    });

    const unavailable = new ApiClient();
    unavailable.setToken("token");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(503)));
    await expect(unavailable.getIdentity()).resolves.toMatchObject({
      status: "unavailable",
    });

    const timedOut = new ApiClient();
    timedOut.setToken("token");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(
        Object.assign(new Error("timed out"), { name: "TimeoutError" })
      )
    );
    await expect(timedOut.getIdentity()).resolves.toMatchObject({
      status: "timeout",
    });
  });

  it("returns only validated identity without substitution", async () => {
    const client = new ApiClient();
    client.setToken("token");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, IDENTITY))
    );

    await expect(client.getIdentity()).resolves.toEqual({
      status: "authenticated",
      identity: IDENTITY,
    });

    const invalidClient = new ApiClient();
    invalidClient.setToken("token");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { subject: "incomplete" }))
    );
    await expect(invalidClient.getIdentity()).resolves.toMatchObject({
      status: "unavailable",
      message: "invalid_identity_response",
    });
  });

  it("reports a failed workflow summary request instead of falling back", async () => {
    const client = new ApiClient();
    client.setToken("token");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(500)));

    await expect(client.getWorkflowSummary()).rejects.toThrow(
      "workflow_summary_unavailable"
    );
  });

  it("verifies the audit chain through the approved gateway", async () => {
    const result = {
      verified: false,
      entries: 1,
      newlySealed: 0,
      headHash: null,
      verifiedAt: "2026-11-04T00:00:00.000Z",
      firstBreak: {
        chainSeq: 2,
        eventId: "11111111-1111-4111-8111-111111111111",
        reason: "content_modified",
      },
    };
    const fetchMock = vi.fn(async () => jsonResponse(200, result));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient();
    client.setToken("auditor-token");
    await expect(client.verifyAuditChain()).resolves.toEqual(result);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/v1/audit-events/verify");
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}");
    expect(new Headers(init.headers).get("Authorization")).toBe(
      "Bearer auditor-token"
    );
  });

  it("reports missing audit permission without inventing a result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(403, { error: "audit_permission_required" }))
    );
    const client = new ApiClient();
    await expect(client.verifyAuditChain()).rejects.toThrow(
      "audit_permission_required"
    );
  });

  it("reads the trust graph from the gateway", async () => {
    const graph = {
      scope: "owned",
      nodes: [],
      edges: [],
      truncated: false,
      generatedAt: "2026-11-04T00:00:00.000Z",
    };
    const fetchMock = vi.fn(async () => jsonResponse(200, graph));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient();
    client.setToken("trust-token");
    await expect(client.getTrustGraph()).resolves.toEqual(graph);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/v1/trust/graph");
    expect(init.method).toBeUndefined();
    expect(new Headers(init.headers).get("Authorization")).toBe(
      "Bearer trust-token"
    );
  });

  it("revokes a grant with the exact revision and a reason", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { state: "revoked" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient();
    const edge = grantEdge();
    await client.revokeTrustGrant(edge, "  hết hợp tác  ");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`/api/v1/trust/grants/${edge.grantId}/revoke`);
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("If-Match")).toBe(
      `"grant-${edge.grantId}-${edge.revision}"`
    );
    expect(JSON.parse(init.body as string)).toEqual({ reason: "hết hợp tác" });
    await expect(client.revokeTrustGrant(edge, "   ")).rejects.toThrow(
      "reason_required"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("parses capability and audit list envelopes", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/capabilities")) {
        return jsonResponse(200, { items: [{ state: "published" }] });
      }
      return jsonResponse(200, { items: [], nextCursor: "cursor-2" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient();
    await expect(client.getCapabilities()).resolves.toHaveLength(1);
    await expect(client.getAuditEvents({ limit: 5 })).resolves.toEqual({
      items: [],
      nextCursor: "cursor-2",
    });
  });
});
