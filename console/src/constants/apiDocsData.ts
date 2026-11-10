// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import {
  API_DOC_ENDPOINTS,
  generateDocCurl,
  type ApiDocEndpoint,
} from "./apiReferenceData";
import {
  API_DOCS_COPY_VI,
  API_DOCS_GROUP_ORDER,
  type ApiDocsCopy,
  type ApiDocsGroupId,
} from "./apiDocsVi";

export { API_DOCS_GROUP_ORDER };
export type { ApiDocsGroupId };

export interface ApiDocGroup {
  id: ApiDocsGroupId;
  endpoints: ApiDocEndpoint[];
}

const PSEUDO_PERMISSIONS = new Set([
  "live-resource-policy",
  "live-trust-management-policy",
  "resource-specific-approval-policy",
  "verified-subject",
]);

const PUBLIC_OPERATIONS = new Set([
  "getHealth",
  "headHealth",
  "getReadiness",
  "getOidcDiscovery",
  "authorizeOidc",
  "issueOidcToken",
  "getOidcKeys",
  "logoutOidc",
  "browserLogoutOidc",
]);

function classify(endpoint: ApiDocEndpoint): ApiDocsGroupId {
  const path = endpoint.path;
  if (path === "/health" || path === "/ready") return "operations";
  if (path.startsWith("/identity") || path === "/v1/identity") return "identity";
  if (path.startsWith("/v1/applications") || path.startsWith("/v1/approvals")) {
    return "applications";
  }
  if (path.startsWith("/v1/data") || path.startsWith("/v2/data")) return "data";
  if (
    path.startsWith("/v1/objects") ||
    path.startsWith("/v2/objects") ||
    path.startsWith("/v2/resource-shares")
  ) {
    return "files";
  }
  if (path.startsWith("/v1/workflows")) return "workflows";
  if (
    path.startsWith("/v1/capabilities") ||
    path.startsWith("/v1/trust") ||
    path.startsWith("/v1/delegations")
  ) {
    return "capabilities";
  }
  if (
    path.startsWith("/v1/capability-executions") ||
    path.startsWith("/v1/capability-authorizations") ||
    path.startsWith("/v1/compositions")
  ) {
    return "execution";
  }
  if (
    path.startsWith("/v1/audit-events") ||
    path.startsWith("/v1/me") ||
    path.startsWith("/v1/emergency-accesses")
  ) {
    return "audit";
  }
  return "operations";
}

function uniqueEndpoints(): ApiDocEndpoint[] {
  const seen = new Set<string>();
  return API_DOC_ENDPOINTS.filter((endpoint) => {
    const key = `${endpoint.method} ${endpoint.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const UNIQUE_ENDPOINTS = uniqueEndpoints();

export const API_DOC_GROUPS: ApiDocGroup[] = API_DOCS_GROUP_ORDER.map((id) => ({
  id,
  endpoints: UNIQUE_ENDPOINTS.filter((endpoint) => classify(endpoint) === id),
})).filter((group) => group.endpoints.length > 0);

export const API_DOC_TOTAL = UNIQUE_ENDPOINTS.length;

export function normalizeForSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

export function getApiCopy(
  endpoint: ApiDocEndpoint,
  language: "vi" | "en",
): ApiDocsCopy {
  if (language === "vi") {
    return (
      API_DOCS_COPY_VI[endpoint.operationId] ?? {
        summary: endpoint.summary,
        when: endpoint.description || endpoint.summary,
      }
    );
  }
  return {
    summary: endpoint.summary,
    when: endpoint.description || endpoint.summary,
  };
}

export function matchesApiDoc(
  endpoint: ApiDocEndpoint,
  query: string,
  language: "vi" | "en",
): boolean {
  const needle = normalizeForSearch(query.trim());
  if (!needle) return true;
  const copy = getApiCopy(endpoint, language);
  return normalizeForSearch(
    [
      endpoint.method,
      endpoint.path,
      endpoint.operationId,
      endpoint.summary,
      endpoint.description,
      copy.summary,
      copy.when,
      ...endpoint.permissions,
    ].join(" "),
  ).includes(needle);
}

export function endpointPermissions(endpoint: ApiDocEndpoint): string[] {
  return endpoint.permissions.filter(
    (permission) => !PSEUDO_PERMISSIONS.has(permission),
  );
}

export type ApiAccess =
  | { kind: "public" }
  | { kind: "authenticated" }
  | { kind: "permission"; permissions: string[] };

export function getApiAccess(endpoint: ApiDocEndpoint): ApiAccess {
  const permissions = endpointPermissions(endpoint);
  if (!endpoint.requiresAuth || PUBLIC_OPERATIONS.has(endpoint.operationId)) {
    return { kind: "public" };
  }
  if (permissions.length > 0) return { kind: "permission", permissions };
  return { kind: "authenticated" };
}

export function generateMaskedCurl(
  endpoint: ApiDocEndpoint,
  baseUrl: string,
): string {
  return generateDocCurl(endpoint, baseUrl)
    .replace(/<paste-bearer-token>/g, "<TOKEN>")
    .replace(/Bearer \$TOKEN/g, "Bearer <TOKEN>")
    .replace(/Bearer [A-Za-z0-9._~+/=-]{20,}/g, "Bearer <TOKEN>");
}
