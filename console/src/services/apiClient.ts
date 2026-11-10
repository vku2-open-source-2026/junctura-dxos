// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import type {
  HealthStatus,
  ReadyStatus,
  IdentityState,
  UserIdentity,
  Application,
  Approval,
  StorageSummary,
  StorageCollections,
  StorageFileListing,
  WorkflowExecution,
  WorkflowExecutionSummary,
  WorkflowSummary,
  AuditVerification,
  AuditEventPage,
  TrustGraph,
  TrustGraphEdge,
  TrustGraphNode,
  TrustGrant,
  CapabilityVersion,
  SubjectConsent,
  EmergencyAccess,
  TrafficSeries,
  FeatureSeries,
  RecentRequest,
  DirectoryPrincipalsPage,
  DirectoryTree,
} from "../types";

const DEFAULT_BASE_URL = "/api";
const GATEWAY_KEY = "junctura_gateway_url";
const LEGACY_TOKEN_KEY = "junctura_token";

export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_BASE_URL;
  if (trimmed === "/") return "/";
  return trimmed.replace(/\/+$/, "");
}

export function isApprovedBaseUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("//")) return false;
  if (trimmed.startsWith("/")) return true;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return false;
  if (url.pathname !== "/" && url.pathname !== "") return false;
  return !url.search && !url.hash;
}

function isTimeoutError(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

function isUserIdentity(value: unknown): value is UserIdentity {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<UserIdentity>;
  return (
    typeof candidate.subject === "string" &&
    typeof candidate.tenantId === "string" &&
    Array.isArray(candidate.roles) &&
    candidate.roles.every((role) => typeof role === "string")
  );
}

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export class ApiClient {
  private baseUrl: string;
  private token: string | null;
  private currentIdentity: UserIdentity | null;
  private identityRequestId = 0;
  private readonly listeners = new Set<() => void>();

  constructor() {
    localStorage.removeItem(LEGACY_TOKEN_KEY);

    const storedBaseUrl = localStorage.getItem(GATEWAY_KEY);
    this.baseUrl =
      storedBaseUrl && isApprovedBaseUrl(normalizeBaseUrl(storedBaseUrl))
        ? normalizeBaseUrl(storedBaseUrl)
        : DEFAULT_BASE_URL;
    if (storedBaseUrl && !isApprovedBaseUrl(normalizeBaseUrl(storedBaseUrl))) {
      localStorage.removeItem(GATEWAY_KEY);
    }

    this.token = null;
    this.currentIdentity = null;
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private buildUrl(path: string): string {
    const base = this.baseUrl === "/" ? "" : this.baseUrl.replace(/\/+$/, "");
    return `${base}${path}`;
  }

  private async send(
    path: string,
    init: RequestInit = {},
    withAuth = true
  ): Promise<Response> {
    if (!isApprovedBaseUrl(this.baseUrl)) {
      throw new ApiError(0, "gateway_origin_not_approved");
    }
    const headers = new Headers(init.headers);
    if (withAuth && this.token) {
      headers.set("Authorization", `Bearer ${this.token}`);
    }
    return fetch(this.buildUrl(path), { ...init, headers });
  }

  private async fail(res: Response, fallback: string): Promise<never> {
    const body = (await res.json().catch(() => null)) as
      | { error?: unknown }
      | null;
    const code =
      body && typeof body.error === "string" ? body.error : fallback;
    throw new ApiError(res.status, code);
  }

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  public isApprovedGatewayUrl(url: string): boolean {
    return isApprovedBaseUrl(normalizeBaseUrl(url));
  }

  public setBaseUrl(url: string): void {
    const normalized = normalizeBaseUrl(url);
    if (!isApprovedBaseUrl(normalized)) {
      throw new ApiError(0, "gateway_origin_not_approved");
    }
    this.baseUrl = normalized;
    localStorage.setItem(GATEWAY_KEY, normalized);
    this.identityRequestId += 1;
    this.currentIdentity = null;
    this.notify();
  }

  public getToken(): string | null {
    return this.token;
  }

  public setToken(token: string | null): void {
    this.token = token?.trim() || null;
    localStorage.removeItem(LEGACY_TOKEN_KEY);
    this.identityRequestId += 1;
    this.currentIdentity = null;
    this.notify();
  }

  public getIdentity(): Promise<IdentityState> {
    return this.loadIdentity();
  }

  private async loadIdentity(): Promise<IdentityState> {
    const requestId = ++this.identityRequestId;
    if (!this.token) {
      this.currentIdentity = null;
      return { status: "missing" };
    }
    try {
      const res = await this.send("/v1/identity", {
        signal: AbortSignal.timeout(6000),
      });
      if (res.status === 400 || res.status === 401) {
        if (requestId === this.identityRequestId) this.currentIdentity = null;
        return { status: "rejected" };
      }
      if (res.status === 403) {
        if (requestId === this.identityRequestId) this.currentIdentity = null;
        return { status: "forbidden" };
      }
      if (!res.ok) {
        if (requestId === this.identityRequestId) this.currentIdentity = null;
        return { status: "unavailable" };
      }
      const data: unknown = await res.json().catch(() => null);
      if (!isUserIdentity(data)) {
        if (requestId === this.identityRequestId) this.currentIdentity = null;
        return { status: "unavailable", message: "invalid_identity_response" };
      }
      if (requestId === this.identityRequestId) this.currentIdentity = data;
      return { status: "authenticated", identity: data };
    } catch (error) {
      if (requestId === this.identityRequestId) this.currentIdentity = null;
      return {
        status: isTimeoutError(error) ? "timeout" : "unavailable",
      };
    }
  }

  public get currentUser(): UserIdentity | null {
    return this.currentIdentity;
  }

  public async getHealth(): Promise<HealthStatus> {
    const start = performance.now();
    try {
      const res = await this.send(
        "/health",
        { signal: AbortSignal.timeout(4000) },
        false
      );
      const latency = Math.round(performance.now() - start);
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          service?: unknown;
          status?: unknown;
        };
        return {
          service:
            typeof data.service === "string" ? data.service : "junctura-core",
          status: data.status === "ok" ? "ok" : "degraded",
          timestamp: new Date().toISOString(),
          latencyMs: latency,
        };
      }
      return {
        service: "junctura-core",
        status: "degraded",
        latencyMs: latency,
      };
    } catch {
      return {
        service: "junctura-core",
        status: "error",
        latencyMs: Math.round(performance.now() - start),
      };
    }
  }

  public async getReady(): Promise<ReadyStatus> {
    const start = performance.now();
    try {
      const res = await this.send(
        "/ready",
        { signal: AbortSignal.timeout(5000) },
        false
      );
      const latency = Math.round(performance.now() - start);
      if (res.ok) {
        return {
          status: "ready",
          timestamp: new Date().toISOString(),
          latencyMs: latency,
        };
      }
      return { status: "not_ready", latencyMs: latency };
    } catch {
      return {
        status: "unknown",
        latencyMs: Math.round(performance.now() - start),
      };
    }
  }

  public async probeHealth(baseUrl: string): Promise<{
    ok: boolean;
    status: number;
    service?: string;
    healthStatus?: string;
    latencyMs: number;
  }> {
    const normalized = normalizeBaseUrl(baseUrl);
    if (!isApprovedBaseUrl(normalized)) {
      throw new ApiError(0, "gateway_origin_not_approved");
    }
    const start = performance.now();
    const base = normalized === "/" ? "" : normalized.replace(/\/+$/, "");
    const response = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    const latencyMs = Math.round(performance.now() - start);
    if (!response.ok) {
      return { ok: false, status: response.status, latencyMs };
    }
    let body: { service?: unknown; status?: unknown } = {};
    try {
      body = await response.json();
    } catch {
      body = {};
    }
    return {
      ok: true,
      status: response.status,
      service: typeof body.service === "string" ? body.service : undefined,
      healthStatus: typeof body.status === "string" ? body.status : undefined,
      latencyMs,
    };
  }

  public async getTrustGraph(): Promise<TrustGraph> {
    const res = await this.send("/v1/trust/graph", {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) await this.fail(res, "trust_graph_failed");
    return (await res.json()) as TrustGraph;
  }

  public async getApplicationNodes(): Promise<TrustGraphNode[]> {
    const graph = await this.getTrustGraph();
    return graph.nodes;
  }

  public async getApplication(appId: string): Promise<Application | null> {
    const res = await this.send(
      `/v1/applications/${encodeURIComponent(appId)}`,
      { signal: AbortSignal.timeout(6000) }
    );
    if (res.status === 404) return null;
    if (!res.ok) await this.fail(res, "application_lookup_failed");
    return (await res.json()) as Application;
  }

  public async createApproval(payload: {
    resourceType: "application" | "grant";
    resourceId: string;
    resourceDigest: string;
    resourceRevision: number;
    requesterSubject: string;
    requesterAppId: string;
    decision: "approve" | "deny";
    expiresAt: string;
  }): Promise<Approval> {
    const res = await this.send("/v1/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) await this.fail(res, "failed_to_create_approval");
    return (await res.json()) as Approval;
  }

  public async approveApplication(
    appId: string,
    approvalId: string,
    revision?: number
  ): Promise<void> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (revision !== undefined) {
      headers["If-Match"] = `"application-${appId}-${revision}"`;
    }
    const res = await this.send(
      `/v1/applications/${encodeURIComponent(appId)}/approve`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ approvalId }),
      }
    );
    if (!res.ok) await this.fail(res, "failed_to_approve");
  }

  public async transitionApplicationState(
    appId: string,
    action: "suspend" | "reactivate" | "revoke",
    reason: string,
    approvalId?: string,
    revision?: number
  ): Promise<void> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (revision !== undefined) {
      headers["If-Match"] = `"application-${appId}-${revision}"`;
    }
    const body: Record<string, string> = { action, reason };
    if (approvalId) body["approvalId"] = approvalId;
    const res = await this.send(
      `/v1/applications/${encodeURIComponent(appId)}/state`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }
    );
    if (!res.ok) await this.fail(res, "state_transition_failed");
  }

  public async getTrustGrant(grantId: string): Promise<TrustGrant> {
    const res = await this.send(
      `/v1/trust/grants/${encodeURIComponent(grantId)}`,
      { signal: AbortSignal.timeout(6000) }
    );
    if (!res.ok) await this.fail(res, "grant_lookup_failed");
    return (await res.json()) as TrustGrant;
  }

  public async activateTrustGrant(
    grantId: string,
    approvalId: string,
    revision: number
  ): Promise<void> {
    const res = await this.send(
      `/v1/trust/grants/${encodeURIComponent(grantId)}/activate`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "If-Match": `"grant-${grantId}-${revision}"`,
        },
        body: JSON.stringify({ approvalId }),
      }
    );
    if (!res.ok) await this.fail(res, "failed_to_activate_grant");
  }

  public async revokeTrustGrant(
    edge: TrustGraphEdge,
    reason: string
  ): Promise<void> {
    const trimmed = reason.trim();
    if (!trimmed || trimmed.length > 512) {
      throw new ApiError(400, "reason_required");
    }
    const res = await this.send(
      `/v1/trust/grants/${edge.grantId}/revoke`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "If-Match": `"grant-${edge.grantId}-${edge.revision}"`,
        },
        body: JSON.stringify({ reason: trimmed }),
      }
    );
    if (!res.ok) await this.fail(res, "revoke_failed");
  }

  public async getCapabilities(): Promise<CapabilityVersion[]> {
    const res = await this.send("/v1/capabilities?limit=100", {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) await this.fail(res, "capabilities_unavailable");
    const data = (await res.json()) as { items?: CapabilityVersion[] };
    return Array.isArray(data.items) ? data.items : [];
  }

  public async getWorkflowSummary(): Promise<WorkflowSummary> {
    const res = await this.send("/v1/workflows/summary", {
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) await this.fail(res, "workflow_summary_unavailable");
    const data = (await res.json()) as Partial<WorkflowSummary> | null;
    const definitions = Array.isArray(data?.definitions)
      ? data.definitions
      : [];
    const totals = data?.totals ?? {
      definitions: definitions.length,
      running: 0,
      completed: 0,
      cancelled: 0,
    };
    return { definitions, totals };
  }

  public async getWorkflowExecutions(
    options: {
      status?: WorkflowExecution["status"];
      limit?: number;
    } = {}
  ): Promise<WorkflowExecutionSummary[]> {
    const query = new URLSearchParams();
    if (options.status) query.set("status", options.status);
    query.set("limit", String(options.limit ?? 100));
    const res = await this.send(`/v1/workflows/executions?${query.toString()}`, {
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) await this.fail(res, "workflow_executions_unavailable");
    const data = (await res.json()) as {
      items?: WorkflowExecutionSummary[];
    };
    return Array.isArray(data.items) ? data.items : [];
  }

  public async getStorageSummary(): Promise<StorageSummary> {
    const res = await this.send("/v1/storage/summary", {
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) await this.fail(res, "storage_summary_unavailable");
    const data = (await res.json()) as Partial<StorageSummary> | null;
    const files = data?.totals?.files;
    return {
      applications: Array.isArray(data?.applications) ? data.applications : [],
      totals: {
        collections: Array.isArray(data?.totals?.collections)
          ? data.totals.collections
          : [],
        files:
          files &&
          typeof files.count === "number" &&
          typeof files.bytes === "number" &&
          typeof files.quarantined === "number"
            ? files
            : null,
      },
    };
  }

  public async getStorageCollections(
    applicationId: string
  ): Promise<StorageCollections> {
    const query = new URLSearchParams({ application: applicationId });
    const res = await this.send(
      `/v1/storage/collections?${query.toString()}`,
      { signal: AbortSignal.timeout(12000) }
    );
    if (!res.ok) await this.fail(res, "storage_collections_unavailable");
    const data = (await res.json()) as Partial<StorageCollections> | null;
    const application = data?.application;
    return {
      application:
        application &&
        typeof application.id === "string" &&
        typeof application.name === "string"
          ? application
          : { id: applicationId, name: "" },
      collections: Array.isArray(data?.collections) ? data.collections : [],
    };
  }

  public async getStorageFiles(
    applicationId: string,
    path: string
  ): Promise<StorageFileListing> {
    const query = new URLSearchParams({ application: applicationId });
    if (path && path !== "/") query.set("path", path);
    const res = await this.send(`/v1/storage/files?${query.toString()}`, {
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) await this.fail(res, "storage_files_unavailable");
    const data = (await res.json()) as Partial<StorageFileListing> | null;
    const application = data?.application;
    return {
      application:
        application &&
        typeof application.id === "string" &&
        typeof application.name === "string"
          ? application
          : { id: applicationId, name: "" },
      path: typeof data?.path === "string" ? data.path : path || "/",
      folders: Array.isArray(data?.folders) ? data.folders : [],
      files: Array.isArray(data?.files) ? data.files : [],
      truncated: data?.truncated === true,
    };
  }

  public async getAuditEvents(params: {
    since?: string;
    until?: string;
    limit?: number;
    cursor?: string;
  } = {}): Promise<AuditEventPage> {
    const query = new URLSearchParams();
    if (params.since) query.set("since", params.since);
    if (params.until) query.set("until", params.until);
    if (params.limit) query.set("limit", String(params.limit));
    if (params.cursor) query.set("cursor", params.cursor);
    const suffix = query.toString() ? `?${query.toString()}` : "";
    const res = await this.send(`/v1/audit-events${suffix}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) await this.fail(res, "audit_events_unavailable");
    const data = (await res.json()) as AuditEventPage;
    return {
      items: Array.isArray(data.items) ? data.items : [],
      nextCursor: data.nextCursor ?? null,
    };
  }

  public async verifyAuditChain(): Promise<AuditVerification> {
    const res = await this.send("/v1/audit-events/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!res.ok) await this.fail(res, "audit_verification_failed");
    return (await res.json()) as AuditVerification;
  }

  public async getConsents(): Promise<SubjectConsent[]> {
    const res = await this.send("/v1/me/consents", {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) await this.fail(res, "consents_unavailable");
    const data = (await res.json()) as { consents?: SubjectConsent[] };
    return Array.isArray(data.consents) ? data.consents : [];
  }

  public async getEmergencyAccesses(): Promise<EmergencyAccess[]> {
    const res = await this.send("/v1/emergency-accesses", {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) await this.fail(res, "emergency_unavailable");
    const data = (await res.json()) as { reviews?: EmergencyAccess[] };
    return Array.isArray(data.reviews) ? data.reviews : [];
  }

  public async getTrafficSeries(minutes: number): Promise<TrafficSeries> {
    const safeMinutes = Math.min(1440, Math.max(60, Math.round(minutes)));
    const res = await this.send(
      `/v1/metrics/traffic?minutes=${safeMinutes}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) await this.fail(res, "traffic_metrics_unavailable");
    const data = (await res.json()) as Partial<TrafficSeries>;
    return {
      from: typeof data.from === "string" ? data.from : new Date().toISOString(),
      to: typeof data.to === "string" ? data.to : new Date().toISOString(),
      intervalSeconds: 60,
      buckets: Array.isArray(data.buckets) ? data.buckets : [],
      totals: data.totals ?? {
        requests: 0,
        errors4xx: 0,
        errors5xx: 0,
        avgLatencyMs: 0,
        maxLatencyMs: 0,
      },
    };
  }

  public async getFeatureSeries(minutes = 60): Promise<FeatureSeries> {
    const safeMinutes = Math.min(60, Math.max(1, Math.round(minutes)));
    const res = await this.send(
      `/v1/metrics/features?minutes=${safeMinutes}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) await this.fail(res, "feature_metrics_unavailable");
    const data = (await res.json()) as Partial<FeatureSeries>;
    return {
      from: typeof data.from === "string" ? data.from : new Date().toISOString(),
      to: typeof data.to === "string" ? data.to : new Date().toISOString(),
      features: Array.isArray(data.features) ? data.features : [],
    };
  }

  public async getRecentRequests(limit = 100): Promise<RecentRequest[]> {
    const safeLimit = Math.min(100, Math.max(1, Math.round(limit)));
    const res = await this.send(`/v1/metrics/requests?limit=${safeLimit}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) await this.fail(res, "recent_requests_unavailable");
    const data = (await res.json()) as { items?: RecentRequest[] };
    return Array.isArray(data.items) ? data.items : [];
  }

  public async getDirectoryPrincipals(): Promise<DirectoryPrincipalsPage> {
    const res = await this.send("/v1/directory/principals", {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) await this.fail(res, "directory_principals_unavailable");
    const data = (await res.json()) as Partial<DirectoryPrincipalsPage>;
    return {
      items: Array.isArray(data.items) ? data.items : [],
      truncated: data.truncated === true,
    };
  }

  public async getDirectoryOrganizations(): Promise<DirectoryTree> {
    const res = await this.send("/v1/directory/organizations", {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) await this.fail(res, "directory_organizations_unavailable");
    const data = (await res.json()) as Partial<DirectoryTree>;
    if (!data.root) {
      throw new ApiError(0, "invalid_directory_response");
    }
    return {
      root: data.root,
      relations: Array.isArray(data.relations) ? data.relations : [],
      truncated: data.truncated === true,
    };
  }
}

export const api = new ApiClient();
