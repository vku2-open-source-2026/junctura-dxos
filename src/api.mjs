// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { createApplicationProvider } from "./modules/applications/keycloak.mjs";
import { handleApplications } from "./modules/applications/applications.mjs";
import { APPLICATION_STATS_PATH, handleApplicationStats } from "./modules/applications/stats.mjs";
import { AUDIT_EVENTS_PATH, AUDIT_EXPORT_PATH, AUDIT_VERIFY_PATH, handleAudit, handleAuditEvents } from "./modules/audit/audit.mjs";
import { DIRECTORY_MANAGEMENT_PATH, DIRECTORY_ORGANIZATIONS_PATH, DIRECTORY_PRINCIPALS_PATH, handleDirectory } from "./modules/directory/directory.mjs";
import { createEventStreams, EVENTS_PATH } from "./modules/events/events.mjs";
import { handleIdentity, verifiedSubjectBinding } from "./modules/identity/identity.mjs";
import { handleConsent, isConsentPath } from "./modules/consent/consent.mjs";
import { createAuthorizer, logAccessDenial } from "./platform/auth/auth.mjs";
import { tokenExchangePath } from "./platform/auth/delegation.mjs";
import { handleApprovals, handleCapabilities } from "./modules/capability/registry/capabilities.mjs";
import { handleCompositions } from "./modules/capability/composition/registry.mjs";
import { readExecutionJson } from "./modules/capability/execution/runtime.mjs";
import { accessDenialCodes, HttpError, json, readFlatJsonObject, requestIdFor } from "./platform/http/http.mjs";
import { handleAppRecords, handleData, handleRecordArchive, handleRecordQuery, presentRecordRequest } from "./modules/data/data.mjs";
import { handleObjects } from "./modules/objects/objects.mjs";
import { checkReadiness } from "./bootstrap/readiness.mjs";
import { handleWorkflow } from "./modules/workflow/workflow.mjs";
import { handleShares, requireLegacyClient, resourceIdentity } from "./modules/resources/resources.mjs";
import { SEARCH_PATH, handleSearch } from "./modules/search/search.mjs";
import { handleSecrets } from "./modules/secrets/secrets.mjs";
import { handleSubjectAccessEvents, SUBJECT_ACCESS_EVENTS_PATH } from "./modules/subject-access/subject-access.mjs";
import { isStoragePath, handleStorage } from "./modules/storage/storage.mjs";
import { TRUST_GRAPH_PATH, handleTrust, handleTrustGraph } from "./modules/capability/trust/trust.mjs";
import { ACCESS_REQUESTS_PATH, handleCapabilityAccessRequests } from "./modules/capability/trust/access-requests.mjs";
import { handleMetrics, isMetricsPath, recordRequest } from "./modules/metrics/metrics.mjs";

const tenantOf = new WeakMap();

export function createApi(config) {
  const applicationProvider = createApplicationProvider(config);
  const authorizer = createAuthorizer({ ...config, currentConsoleRoles: applicationProvider?.consoleRoles });
  const events = config.eventsRuntime ?? createEventStreams(config);
  const authorize = async (request, withContext = false) => {
    const identity = await authorizer(request, withContext);
    tenantOf.set(request, identity.tenantId);
    return identity;
  };
  const route = async (request, response) => {
    const startedAt = performance.now();
    if (typeof response.once === "function") response.once("finish", () => {
      try {
        recordRequest({
          tenantId: tenantOf.get(request),
          method: request.method,
          path: request.url?.split("?", 1)[0],
          statusCode: response.statusCode,
          durationMs: performance.now() - startedAt,
        });
      } catch { /* traffic accounting must never affect a request */ }
    });
    const path = request.url?.split("?", 1)[0];
    if (path === "/ready" && request.method === "GET") {
      try {
        await checkReadiness(config);
        return json(response, 200, { status: "ready" });
      } catch { throw new HttpError(503, "not_ready"); }
    }
    if (path === tokenExchangePath) {
      const requestId = requestIdFor(request);
      response.setHeader("X-Request-Id", requestId);
      try {
        if (request.method !== "POST") {
          response.setHeader("Allow", "POST");
          throw new HttpError(405, "method_not_allowed");
        }
        if (request.url.includes("?")) throw new HttpError(400, "invalid_query");
        const body = await readFlatJsonObject(request);
        if (Object.keys(body).length !== 1 || !Object.hasOwn(body, "subjectToken")) throw new HttpError(400, "invalid_request");
        return json(response, 200, await authorizer.exchange(request, body.subjectToken));
      } catch (error) {
        if (error.status === 413) response.setHeader("Connection", "close");
        return json(response, error instanceof HttpError ? error.status : 503,
          { error: error instanceof HttpError ? error.message : "identity_unavailable", requestId }, request.method);
      }
    }
    if ((config.executionRuntime || config.compositionRuntime) &&
      (path === "/v1/capability-executions" || path?.startsWith("/v1/capability-executions/") || path === "/v1/capability-authorizations/introspect")) {
      const requestId = requestIdFor(request);
      response.setHeader("X-Request-Id", requestId);
      let identity;
      try {
        identity = await authorize(request, true);
        const url = new URL(request.url, "http://core");
        if (path === "/v1/capability-executions" && request.method === "POST") {
          const body = await readExecutionJson(request);
          if (config.compositionRuntime && body?.target?.kind === "composition") {
            const result = await config.compositionRuntime.submit(request, response, identity, body);
            if (result) return json(response, result.status, result.value);
          }
          if (!config.executionRuntime) throw new HttpError(422, "capability_runtime_disabled");
          return await config.executionRuntime.handle(request, response, identity, url, { body });
        }
        if (path === "/v1/capability-authorizations/introspect" && config.compositionRuntime) {
          if (request.method !== "POST") throw new HttpError(405, "method_not_allowed");
          if (url.search) throw new HttpError(400, "invalid_query");
          const body = await readExecutionJson(request);
          const composition = await config.compositionRuntime.introspect(identity, body);
          if (composition.active === true) return json(response, 200, composition);
          if (!config.executionRuntime) return json(response, 200, { active: false });
          return await config.executionRuntime.handle(request, response, identity, url, { body });
        }
        const match = /^\/v1\/capability-executions\/([0-9a-f-]{36})$/.exec(url.pathname);
        if (match && config.compositionRuntime) {
          if (request.method !== "GET") throw new HttpError(405, "method_not_allowed");
          if (url.search) throw new HttpError(400, "invalid_query");
          try { return await config.compositionRuntime.get(request, response, identity, match[1]); }
          catch (error) { if (!(error instanceof HttpError) || error.status !== 404) throw error; }
        }
        if (!config.executionRuntime) throw new HttpError(404, "not_found");
        return await config.executionRuntime.handle(request, response, identity, url);
      } catch (error) {
        const code = error instanceof HttpError && error.status === 403 &&
          ["invoke_not_authorized", "consumer_binding_required", "write_forbidden"].includes(error.message)
          ? "capability_not_granted" : error.message;
        // Authorization failures before identity resolution were audited by app_access_check.
        if (error instanceof HttpError && accessDenialCodes.has(code)) {
          try { await logAccessDenial(config, identity, requestId, code); }
          catch { return json(response, 503, { error: "app_access_unavailable", requestId }); }
          return json(response, 403, { error: code, requestId });
        }
        if (error.status === 413) response.setHeader("Connection", "close");
        return json(response, error instanceof HttpError ? error.status : 503,
          { error: error instanceof HttpError ? error.message : "executions_unavailable", requestId,
            ...(error instanceof HttpError && error.details ? error.details : {}) });
      }
    }    if (config.compositionRuntime && (path === "/v1/compositions" || path?.startsWith("/v1/compositions/"))) {
      const requestId = requestIdFor(request);
      response.setHeader("X-Request-Id", requestId);
      try {
        const identity = await authorize(request, true);
        return await handleCompositions(request, response, identity, config, new URL(request.url, "http://core"));
      } catch (error) {
        if (error.status === 413) response.setHeader("Connection", "close");
        return json(response, error instanceof HttpError ? error.status : 503,
          { error: error instanceof HttpError ? error.message : "compositions_unavailable", requestId,
            ...(error instanceof HttpError && error.details ? error.details : {}) });
      }
    }

    if (path === APPLICATION_STATS_PATH) {
      const requestId = requestIdFor(request);
      response.setHeader("X-Request-Id", requestId);
      try {
        const identity = await authorize(request, true);
        return await handleApplicationStats(request, response, identity, config, new URL(request.url, "http://core"));
      } catch (error) {
        return json(response, error instanceof HttpError ? error.status : 503,
          { error: error instanceof HttpError ? error.message : "application_stats_unavailable", requestId });
      }
    }
    if (path === "/v1/applications" || path?.startsWith("/v1/applications/")) {
      const requestId = requestIdFor(request);
      response.setHeader("X-Request-Id", requestId);
      try {
        const identity = await authorize(request, true);
        return await handleApplications(request, response, identity, config, new URL(request.url, "http://core"));
      } catch (error) {
        if (error.status === 413) response.setHeader("Connection", "close");
        return json(response, error instanceof HttpError ? error.status : 503,
          { error: error instanceof HttpError ? error.message : "applications_unavailable", requestId });
      }
    }
    if (path === "/v1/approvals" || path?.startsWith("/v1/approvals/")) {
      const requestId = requestIdFor(request);
      response.setHeader("X-Request-Id", requestId);
      try {
        const identity = await authorize(request, true);
        return await handleApprovals(request, response, identity, config, new URL(request.url, "http://core"));
      } catch (error) {
        if (error.status === 413) response.setHeader("Connection", "close");
        return json(response, error instanceof HttpError ? error.status : 503,
          { error: error instanceof HttpError ? error.message : "approvals_unavailable", requestId });
      }
    }
    if (path === "/v1/capabilities" || path?.startsWith("/v1/capabilities/")) {
      const requestId = requestIdFor(request);
      response.setHeader("X-Request-Id", requestId);
      try {
        const identity = await authorize(request, true);
        return await handleCapabilities(request, response, identity, config, new URL(request.url, "http://core"));
      } catch (error) {
        if (error.status === 413) response.setHeader("Connection", "close");
        return json(response, error instanceof HttpError ? error.status : 503,
          { error: error instanceof HttpError ? error.message : "capabilities_unavailable", issues: error.issues, requestId });
      }
    }
    if (isConsentPath(path)) {
      const requestId = requestIdFor(request);
      response.setHeader("X-Request-Id", requestId);
      try {
        const identity = await authorize(request, true);
        return await handleConsent(request, response, identity, config, new URL(request.url, "http://core"));
      } catch (error) {
        if (error.status === 413) response.setHeader("Connection", "close");
        return json(response, error instanceof HttpError ? error.status : 503,
          { error: error instanceof HttpError ? error.message : "consent_unavailable", requestId });
      }
    }
    if (path === SUBJECT_ACCESS_EVENTS_PATH || /^\/v1\/me\/(?:data-access\/[^/]+\/flag|emergency-accesses\/[^/]+\/feedback)$/.test(path)) {
      const requestId = requestIdFor(request);
      response.setHeader("X-Request-Id", requestId);
      try {
        const identity = await authorize(request, true);
        if (!identity.subjectId || (request.method === "POST" && !await verifiedSubjectBinding(config, identity))) {
          throw new HttpError(403, "verified_subject_required");
        }
        return await handleSubjectAccessEvents(request, response, identity, config, new URL(request.url, "http://core"));
      } catch (error) {
        if (error.status === 413) response.setHeader("Connection", "close");
        if (error instanceof URIError) return json(response, 400, { error: "invalid_request", requestId });
        return json(response, error instanceof HttpError ? error.status : 503,
          { error: error instanceof HttpError ? error.message : "subject_access_unavailable", requestId });
      }
    }
    if (path === AUDIT_EVENTS_PATH || path === AUDIT_EXPORT_PATH) {
      const requestId = requestIdFor(request);
      response.setHeader("X-Request-Id", requestId);
      try {
        return await handleAuditEvents(request, response, await authorize(request, true), config, new URL(request.url, "http://core"));
      } catch (error) {
        if (error.status === 413) response.setHeader("Connection", "close");
        return json(response, error instanceof HttpError ? error.status : 503,
          { error: error instanceof HttpError ? error.message : "audit_unavailable", requestId });
      }
    }
    if (path === EVENTS_PATH) {
      const requestId = requestIdFor(request);
      response.setHeader("X-Request-Id", requestId);
      try {
        return await events.handle(request, response, await authorize(request, true), () => authorize(request, true),
          new URL(request.url, "http://core"));
      } catch (error) {
        return json(response, error instanceof HttpError ? error.status : 503,
          { error: error instanceof HttpError ? error.message : "events_unavailable", requestId });
      }
    }
    if (path === AUDIT_VERIFY_PATH) {
      const requestId = requestIdFor(request);
      response.setHeader("X-Request-Id", requestId);
      try {
        return await handleAudit(request, response, await authorize(request, true), config, new URL(request.url, "http://core"));
      } catch (error) {
        if (error.status === 413) response.setHeader("Connection", "close");
        return json(response, error instanceof HttpError ? error.status : 503,
          { error: error instanceof HttpError ? error.message : "audit_unavailable", requestId });
      }
    }
    if (path === DIRECTORY_PRINCIPALS_PATH || path === DIRECTORY_ORGANIZATIONS_PATH ||
        path?.startsWith(DIRECTORY_MANAGEMENT_PATH)) {
      const requestId = requestIdFor(request);
      response.setHeader("X-Request-Id", requestId);
      try {
        return await handleDirectory(request, response, await authorize(request, true), config, new URL(request.url, "http://core"));
      } catch (error) {
        return json(response, error instanceof HttpError ? error.status : 503,
          { error: error instanceof HttpError ? error.message : "directory_unavailable", requestId });
      }
    }
    if (isMetricsPath(path)) {
      const requestId = requestIdFor(request);
      response.setHeader("X-Request-Id", requestId);
      try {
        return await handleMetrics(request, response, await authorize(request, true), config, new URL(request.url, "http://core"));
      } catch (error) {
        return json(response, error instanceof HttpError ? error.status : 503,
          { error: error instanceof HttpError ? error.message : "metrics_unavailable", requestId });
      }
    }
    if (path === TRUST_GRAPH_PATH) {
      const requestId = requestIdFor(request);
      response.setHeader("X-Request-Id", requestId);
      try {
        return await handleTrustGraph(request, response, await authorize(request, true), config, new URL(request.url, "http://core"));
      } catch (error) {
        return json(response, error instanceof HttpError ? error.status : 503,
          { error: error instanceof HttpError ? error.message : "trust_unavailable", requestId });
      }
    }
    const accessRequest = path === ACCESS_REQUESTS_PATH || path?.startsWith(`${ACCESS_REQUESTS_PATH}/`);
    if (accessRequest || path === "/v1/trust/grants" || path?.startsWith("/v1/trust/grants/")) {
      const requestId = requestIdFor(request);
      response.setHeader("X-Request-Id", requestId);
      try {
        const handler = accessRequest ? handleCapabilityAccessRequests : handleTrust;
        return await handler(request, response, await authorize(request, true), config, new URL(request.url, "http://core"));
      } catch (error) {
        if (error.status === 413) response.setHeader("Connection", "close");
        return json(response, error instanceof HttpError ? error.status : 503,
          { error: error instanceof HttpError ? error.message : "trust_unavailable", requestId });
      }
    }
    if (isStoragePath(path)) {
      const requestId = requestIdFor(request);
      response.setHeader("X-Request-Id", requestId);
      try {
        return await handleStorage(request, response, await authorize(request, true), config, new URL(request.url, "http://core"));
      } catch (error) {
        return json(response, error instanceof HttpError ? error.status : 503,
          { error: error instanceof HttpError ? error.message : "storage_unavailable", requestId });
      }
    }
    if (path === SEARCH_PATH) {
      const requestId = requestIdFor(request);
      response.setHeader("X-Request-Id", requestId);
      try {
        return await handleSearch(request, response, await authorize(request, true), config, new URL(request.url, "http://core"));
      } catch (error) {
        return json(response, error instanceof HttpError ? error.status : 503,
          { error: error instanceof HttpError ? error.message : "search_unavailable", requestId });
      }
    }
    if (path?.startsWith("/v1/data/")) {
      const identity = await authorize(request, true);
      requireLegacyClient(identity, config);
      return handleData(request, response, identity, config, new URL(request.url, "http://core"));
    }
    if (path === "/v2/data:export" || path === "/v2/data:import") {
      return handleRecordArchive(request, response, await authorize(request, true), config, new URL(request.url, "http://core"));
    }
    if (path === "/v2/data:batch" || path?.startsWith("/v2/data/") || path?.startsWith("/v2/data-schemas/")) {
      const url = new URL(request.url, "http://core");
      const listing = request.method === "GET" && /^\/v2\/data\/[^/]+$/.test(path);
      if (/^\/v2\/data\/[^/]+\/aggregate$/.test(path) || (listing && (config.strictRecords ||
          url.searchParams.has("sort") || url.searchParams.has("ownerAppId") ||
          [...url.searchParams.keys()].some(key => key.startsWith("where["))))) {
        return handleRecordQuery(request, response, await authorize(request, true), config, url);
      }
      if (listing) {
        const identity = await resourceIdentity(config, await authorize(request, true));
        return handleData(request, response, identity, config, url);
      }
      const compatibility = path.startsWith("/v2/data/") && !path.endsWith(":lock") && !path.includes("/by-key/") &&
        !config.strictRecords;
      return presentRecordRequest(request, response, async () =>
        handleAppRecords(request, response, await authorize(request, true), config, url), compatibility);
    }
    if (["/v1/objects", "/v2/objects"].some(prefix => path === prefix || path?.startsWith(`${prefix}/`))) {
      let identity = await authorize(request, true);
      if (path.startsWith("/v2/")) identity = await resourceIdentity(config, identity);
      else requireLegacyClient(identity, config);
      return handleObjects(request, response, identity, config, new URL(request.url, "http://core"));
    }
    if (path === "/v2/resource-shares" || path?.startsWith("/v2/resource-shares/")) {
      const identity = await resourceIdentity(config, await authorize(request, true));
      return handleShares(request, response, identity, config, new URL(request.url, "http://core"));
    }
    if (path === "/v2/secrets" || path?.startsWith("/v2/secrets/")) {
      const identity = await resourceIdentity(config, await authorize(request, true));
      return handleSecrets(request, response, identity, config, new URL(request.url, "http://core"));
    }
    if (path?.startsWith("/v1/workflows/")) {
      return presentRecordRequest(request, response, async () =>
        handleWorkflow(request, response, await authorize(request, true), config, new URL(request.url, "http://core")));
    }
    if (path === "/internal/auth" || path === "/v1/identity") {
      let identity;
      try { identity = await authorize(request, true); }
      catch (error) {
        // The gateway drops auth_request bodies; the header lets it answer with the same JSON code.
        if (path === "/internal/auth" && error instanceof HttpError) response.setHeader("X-Junctura-Auth-Error", error.message);
        throw error;
      }
      if (path === "/internal/auth") {
        response.writeHead(204);
        return response.end();
      }
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        throw new HttpError(405, "method_not_allowed");
      }
      return handleIdentity(request, response, identity, config);
    }
    throw new HttpError(404, "not_found");
  };
  return async (request, response) => {
    try { return await route(request, response); }
    catch (error) {
      if (!(error instanceof HttpError) || !accessDenialCodes.has(error.message) || response.headersSent) throw error;
      const requestId = requestIdFor(request);
      response.setHeader("X-Request-Id", requestId);
      return json(response, 403, { error: error.message, requestId }, request.method);
    }
  };
}
