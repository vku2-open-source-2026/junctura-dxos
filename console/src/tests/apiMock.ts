// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { vi } from "vitest";

export const TEST_IDENTITY = {
  subject: "test-operator",
  tenantId: "tenant-test",
  roles: ["core-reader", "core-writer"],
};

export const EMPTY_GRAPH = {
  scope: "tenant" as const,
  nodes: [],
  edges: [],
  truncated: false,
  generatedAt: "2026-11-10T00:00:00.000Z",
};

export function json(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export type ApiRoute = (
  url: string,
  init?: RequestInit
) => Response | Promise<Response> | undefined;

function defaultResponse(url: string): Response {
  if (url.includes("/v1/identity")) return json(200, TEST_IDENTITY);
  if (url.includes("/v1/audit-events/verify")) {
    return json(200, {
      verified: true,
      entries: 0,
      newlySealed: 0,
      headHash: null,
      firstBreak: null,
      verifiedAt: "2026-11-10T00:00:00.000Z",
    });
  }
  if (url.includes("/v1/audit-events")) {
    return json(200, { items: [], nextCursor: null });
  }
  if (url.includes("/v1/trust/graph")) return json(200, EMPTY_GRAPH);
  if (url.includes("/v1/metrics/traffic")) {
    return json(200, {
      from: "2026-11-10T00:00:00.000Z",
      to: "2026-11-10T01:00:00.000Z",
      intervalSeconds: 60,
      buckets: [],
      totals: {
        requests: 0,
        errors4xx: 0,
        errors5xx: 0,
        avgLatencyMs: 0,
        maxLatencyMs: 0,
      },
    });
  }
  if (url.includes("/v1/metrics/features")) {
    return json(200, {
      from: "2026-11-10T00:00:00.000Z",
      to: "2026-11-10T01:00:00.000Z",
      features: [],
    });
  }
  if (url.includes("/v1/metrics/requests")) return json(200, { items: [] });
  if (url.includes("/v1/directory/principals")) {
    return json(200, { items: [], truncated: false });
  }
  if (url.includes("/v1/directory/organizations")) {
    return json(200, {
      root: {
        id: "tenant-test",
        name: "tenant-test",
        kind: "platform",
        children: [],
      },
      relations: [],
      truncated: false,
    });
  }
  if (url.includes("/v1/capabilities")) return json(200, { items: [] });
  if (url.includes("/v1/storage/files")) {
    return json(200, {
      application: { id: "", name: "" },
      path: "/",
      folders: [],
      files: [],
      truncated: false,
    });
  }
  if (url.includes("/v1/storage/collections")) {
    return json(200, {
      application: { id: "", name: "" },
      collections: [],
    });
  }
  if (url.includes("/v1/storage/summary")) {
    return json(200, {
      applications: [],
      totals: { collections: [], files: null },
    });
  }
  if (url.includes("/v1/workflows/summary")) {
    return json(200, {
      definitions: [],
      totals: { definitions: 0, running: 0, completed: 0, cancelled: 0 },
    });
  }
  if (url.includes("/v1/workflows/executions")) {
    return json(200, { items: [], limit: 100 });
  }
  if (url.includes("/v1/me/consents")) return json(200, { consents: [] });
  if (url.includes("/v1/emergency-accesses")) {
    return json(200, { reviews: [] });
  }
  if (url.includes("/v1/data/")) return json(200, { items: [] });
  if (url.includes("/v2/secrets")) return json(404);
  if (url.includes("/login-hints.json")) return json(200, { accounts: [] });
  if (url.includes("/health")) {
    return json(200, { service: "junctura-core", status: "ok" });
  }
  if (url.includes("/ready")) return json(200, { status: "ready" });
  return json(200, {});
}

export function installApiFetch(routes: ApiRoute[] = []) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    for (const route of routes) {
      const response = await route(url, init);
      if (response) return response;
    }
    return defaultResponse(url);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
