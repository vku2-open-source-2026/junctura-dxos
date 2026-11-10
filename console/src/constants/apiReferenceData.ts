// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import rawReference from "./apiReference.json";
import {
  FOUNDATION_ENDPOINTS,
  generateCurlExample,
  type ApiEndpointDef,
  type ApiParameterDef,
} from "./openapiData";

export interface ApiDocParameter {
  name: string;
  required: boolean;
  description: string;
}

export interface ApiDocEndpoint {
  path: string;
  method: string;
  operationId: string;
  summary: string;
  description: string;
  tags: string[];
  permissions: string[];
  responses: string[];
  hasRequestBody: boolean;
  requestContentTypes: string[];
  pathParameters: ApiDocParameter[];
  queryParameters: ApiDocParameter[];
  headerParameters: ApiDocParameter[];
  examplePath: string;
  requestContentType: string | null;
  requestBodyExample: unknown;
  responseExample: string;
  requiresAuth: boolean;
  source: "foundation" | "capability";
}

interface FoundationDetail {
  permissions: string[];
  responseExample: string;
}

interface RawCapabilityEndpoint {
  path: string;
  method: string;
  operationId: string;
  summary: string;
  description: string;
  tags: string[];
  permissions: string[];
  responses: string[];
  hasRequestBody: boolean;
  requestContentTypes: string[];
  pathParameters: ApiDocParameter[];
  queryParameters: ApiDocParameter[];
  headerParameters: ApiDocParameter[];
  examplePath: string;
  requestContentType: string | null;
  requestBodyExample: unknown;
  successStatus: string | null;
  responseExample: string;
}

interface RawReference {
  foundation: Record<string, FoundationDetail>;
  capability: RawCapabilityEndpoint[];
}

const reference = rawReference as unknown as RawReference;

export const API_BASE_URL = "http://127.0.0.1:8080";

export const API_TAG_ORDER = [
  "process",
  "tenant",
  "app-resource",
  "application-admin",
  "legacy-tenant",
  "oidc-upstream",
  "applications",
  "approvals",
  "capabilities",
  "trust",
  "capability-executions",
  "capability-authorizations",
  "compositions",
  "delegations",
  "audit-events",
] as const;

export type ApiTagId = (typeof API_TAG_ORDER)[number];

function normalizeParameter(parameter: ApiParameterDef): ApiDocParameter {
  return {
    name: parameter.name,
    required: parameter.required,
    description: parameter.description,
  };
}

function normalizeFoundation(endpoint: ApiEndpointDef): ApiDocEndpoint {
  const detail = reference.foundation[endpoint.operationId];
  return {
    path: endpoint.path,
    method: endpoint.method,
    operationId: endpoint.operationId,
    summary: endpoint.summary,
    description: endpoint.description || endpoint.summary,
    tags: endpoint.tags,
    permissions: detail?.permissions ?? [],
    responses: endpoint.responses,
    hasRequestBody: endpoint.hasRequestBody,
    requestContentTypes: endpoint.requestContentTypes,
    pathParameters: endpoint.pathParameters.map(normalizeParameter),
    queryParameters: endpoint.queryParameters.map(normalizeParameter),
    headerParameters: endpoint.headerParameters.map(normalizeParameter),
    examplePath: endpoint.path,
    requestContentType: endpoint.requestContentTypes[0] ?? null,
    requestBodyExample: null,
    responseExample: detail?.responseExample ?? "",
    requiresAuth: endpoint.security.length > 0,
    source: "foundation",
  };
}

export const API_DOC_ENDPOINTS: ApiDocEndpoint[] = [
  ...FOUNDATION_ENDPOINTS.map(normalizeFoundation),
  ...reference.capability.map((endpoint) => ({
    ...endpoint,
    requiresAuth: true,
    source: "capability" as const,
  })),
];

export function generateDocCurl(
  endpoint: ApiDocEndpoint,
  baseUrl: string = API_BASE_URL,
): string {
  if (endpoint.source === "foundation") {
    const original = FOUNDATION_ENDPOINTS.find(
      (candidate) => candidate.operationId === endpoint.operationId,
    );
    if (original) return generateCurlExample(original, baseUrl);
  }

  const lines: string[] = [];
  const headerNames = new Set(endpoint.headerParameters.map((header) => header.name));
  if (headerNames.has("If-Match")) lines.push('ETAG="<etag-from-last-response>"');
  if (headerNames.has("Idempotency-Key")) {
    lines.push(`IDEMPOTENCY_KEY="$(node -e 'console.log(crypto.randomUUID())')"`);
  }
  if (lines.length > 0) lines.push("");

  const url = `${baseUrl.replace(/\/$/, "")}${endpoint.examplePath}`;
  const command = [`curl -X ${endpoint.method} "${url}"`, "--fail-with-body", "--silent", "--show-error"];
  command.push('-H "Authorization: Bearer $TOKEN"');
  for (const header of endpoint.headerParameters) {
    if (header.name === "If-Match") command.push('-H "If-Match: $ETAG"');
    else if (header.name === "Idempotency-Key") {
      command.push('-H "Idempotency-Key: $IDEMPOTENCY_KEY"');
    } else command.push(`-H "${header.name}: <value>"`);
  }
  if (endpoint.requestContentType === "application/json") {
    command.push('-H "Content-Type: application/json"');
    const body = JSON.stringify(endpoint.requestBodyExample ?? {}, null, 2);
    command.push(`-d '${body}'`);
  }
  lines.push(command.join(" \\\n  "));
  return lines.join("\n");
}
