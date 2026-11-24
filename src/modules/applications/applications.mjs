// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { isIP } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { HttpError, json, readFlatJsonObject, uuidPattern } from "../../platform/http/http.mjs";
import { handleApplicationManagement, withProvider } from "./management.mjs";
import { signInternalToken } from "../../platform/security/internal-token.mjs";

// Application proposals contain only objects and well-formed strings. This is
// the JCS subset needed here, not a general manifest/number canonicalizer.
export function applicationDigest(appId, tenantId, proposal) {
  function canonical(value) {
    if (typeof value === "string" && value.isWellFormed()) return JSON.stringify(value);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
    }
    throw new HttpError(400, "invalid_proposal");
  }
  return `sha256:${createHash("sha256").update(canonical({ resourceId: appId, tenantId, proposal })).digest("hex")}`;
}

export function validateApplicationBody(body, operation) {
  const models = {
    create: [["displayName", "oauthClientId", "providerOrigin"], []],
    approve: [["approvalId"], []],
    state: [["action", "reason"], ["approvalId"]],
    approval_create: [["resourceType", "resourceId", "resourceDigest", "resourceRevision", "requesterSubject", "requesterAppId", "decision", "expiresAt"], []],
    approval_revoke: [["reason"], []],
  };
  const [required, optional] = models[operation];
  if (required.some(key => !Object.hasOwn(body, key)) || Object.keys(body).some(key => !required.includes(key) && !optional.includes(key))) throw new HttpError(400, "invalid_application_body");
  for (const [key, value] of Object.entries(body)) {
    const max = { displayName: 120, oauthClientId: 120, providerOrigin: 255, reason: 512, requesterSubject: 255 }[key] ?? 256;
    if (key === "resourceRevision") {
      if (!Number.isInteger(value) || value < 1 || value > 2147483647) throw new HttpError(400, "invalid_revision");
    } else if (typeof value !== "string" || !value.isWellFormed() || !value.trim() || [...value].length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new HttpError(400, "invalid_application_body");
    if (["approvalId", "resourceId", "requesterAppId"].includes(key) && !uuidPattern.test(value)) throw new HttpError(400, "invalid_identifier");
  }
  if (operation === "create") {
    let origin;
    try { origin = new URL(body.providerOrigin); } catch { throw new HttpError(400, "invalid_provider_origin"); }
    if (origin.protocol !== "https:" || origin.origin !== body.providerOrigin || origin.username || origin.password || isIP(origin.hostname.replace(/^\[|\]$/g, "")) || !origin.hostname.includes(".") || origin.hostname.endsWith(".")) throw new HttpError(400, "invalid_provider_origin");
  }
  if (operation === "state" && (!["suspend", "reactivate", "revoke"].includes(body.action) || (body.action === "reactivate") !== Object.hasOwn(body, "approvalId"))) throw new HttpError(400, "invalid_transition_body");
  if (operation === "approval_create" && (body.resourceType !== "application" || !["approve", "deny"].includes(body.decision) || !/^sha256:[0-9a-f]{64}$/.test(body.resourceDigest) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(body.expiresAt) || !Number.isFinite(Date.parse(body.expiresAt)))) throw new HttpError(400, "invalid_application_approval");
  if (operation === "approval_create") {
    const normalized = body.expiresAt.replace(/(?:\.(\d{1,3}))?Z$/, (_, fraction) => `.${(fraction ?? "").padEnd(3, "0")}Z`);
    if (new Date(body.expiresAt).toISOString() !== normalized) throw new HttpError(400, "invalid_approval_expiry");
  }
  return body;
}

export function applicationToken(identity, secret, role = "junctura_app_api") {
  return signInternalToken(secret, { role, tenant_id: identity.tenantId, sub: identity.subject,
    ...(role === "junctura_resource_api" ? {
      resource_writer: identity.roles.includes("core-writer"), actor_sub: identity.actor?.sub,
    } : {}),
    ...(role === "junctura_trust_api" ? { trust_writer: identity.roles.includes("core-writer") } : {}),
    ...(role === "junctura_directory_api" ? { directory_writer: identity.roles.includes("core-writer") } : {}),
    // The candidate subjectId travels to RPCs that verify the operator binding.
    app_sync_worker: identity.appSyncWorker, console_role: identity.consoleRole, resource_unit: identity.resourceUnit, human_app_id: identity.humanAppId,
    ...(identity.subjectId ? { subject_id: identity.subjectId } : {}),
    iss: identity.issuer, client_id: identity.clientId, aud: "junctura-data", exp: Math.floor(Date.now() / 1000) + 30 });
}

async function applicationCommand(config, identity, operation, payload, rpc = "application_management") {
  let result;
  try {
    const db = await fetch(`${config.dataUrl}/rpc/${rpc}`, {
      method: "POST", headers: { Authorization: `Bearer ${applicationToken(identity, config.dataSecret)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ operation, payload }), signal: AbortSignal.timeout(5000), redirect: "error",
    });
    if (!db.ok) throw Error();
    result = await db.json();
  } catch { throw new HttpError(503, "applications_unavailable"); }
  if (result.error) throw new HttpError(result.status, result.error);
  return result;
}

export function startApplicationReconciler(config, delay = 30_000) {
  if (!config.dataUrl || !config.appSyncSecret) return undefined;
  const worker = { appSyncWorker: true, issuer: config.issuer, clientId: config.appSyncClientId, subject: config.appSyncClientId };
  let stopped = false;
  let timer;
  async function tick() {
    try {
      for (const queue of ["sync_apps", "sync_queue"]) {
        let cursor;
        while (!stopped) {
          const { value: jobs } = await applicationCommand(config, worker, queue, cursor ?? {});
          if (jobs.length === 0) break;
          for (const job of jobs) {
            if (stopped) break;
            const command = (operation, payload) => applicationCommand(config, { ...worker, tenantId: job.tenantId }, operation, payload);
            try {
              await withProvider(config, command, job.appId, async (fenced, provider, clientId, ready) => {
                if (!job.assignmentId) {
                  if (!ready) {
                    await provider.configure(clientId, job.appId);
                    await fenced("provider_confirm");
                  }
                  return;
                }
                const { value } = await fenced("assignment_sync", { assignmentId: job.assignmentId });
                if (!value || stopped) return;
                await provider.applyAssignment(job.tenantId, clientId, job.appId, value);
                await fenced("assignment_confirm", { assignmentId: value.assignmentId, enabled: value.enabled });
              });
            } catch { /* A failed synchronization remains queued. */ }
          }
          cursor = jobs.at(-1);
        }
      }
    } catch { /* Retry upstream outages on the next sweep. */ }
    if (!stopped) timer = setTimeout(tick, delay).unref();
  }
  timer = setTimeout(tick, delay).unref();
  return () => { stopped = true; clearTimeout(timer); };
}

export async function handleApplications(request, response, identity, config, url) {
  if (!config.dataUrl) throw new HttpError(503, "applications_unavailable");
  if (!identity.clientId) throw new HttpError(403, "verified_client_required");
  const command = (operation, payload, rpc) => applicationCommand(config, identity, operation, payload, rpc);

  if (config.enforceAppAccess || request.method !== "GET" || url.pathname === "/v1/applications" || url.pathname.endsWith("/assignments") || url.pathname.endsWith("/oidc-keys")) {
    const handled = await handleApplicationManagement(request, response, identity, config, url, command);
    if (response.headersSent) return handled;
  }
  if (url.search) throw new HttpError(400, "invalid_query");
  const match = url.pathname.match(/^\/v1\/(applications|approvals)(?:\/([^/]+)(?:\/(approve|state|revoke))?)?$/);
  if (!match || (match[2] && !uuidPattern.test(match[2]))) throw new HttpError(400, "invalid_application_path");
  const [, kind, id, action] = match;
  const operation = kind === "applications"
    ? !id && request.method === "POST" ? "create" : id && !action && request.method === "GET" ? "get" : id && ["approve", "state"].includes(action) && request.method === "POST" ? action : undefined
    : !id && request.method === "POST" ? "approval_create" : id && !action && request.method === "GET" ? "approval_get" : id && action === "revoke" && request.method === "POST" ? "approval_revoke" : undefined;
  if (!operation) throw new HttpError(405, "method_not_allowed");
  const body = request.method === "POST" ? validateApplicationBody(await readFlatJsonObject(request), operation) : {};
  let payload = { ...body };
  if (operation === "create") {
    const appId = randomUUID();
    payload = { ...body, appId, digest: applicationDigest(appId, identity.tenantId, { ...body, ownerSubject: identity.subject }) };
  } else if (operation === "approval_create") payload = { appId: body.resourceId, approvalId: randomUUID(), decision: body };
  else payload[kind === "applications" ? "appId" : "approvalId"] = id;
  if (request.headers["if-match"] !== undefined) payload.etag = request.headers["if-match"];
  const syncApproval = operation === "approve" && config.appSyncSecret;
  if (syncApproval) await command("approve_check", payload, "application_command");
  const apply = () => command(operation, payload, "application_command");
  const result = syncApproval
    ? await withProvider(config, command, payload.appId, async (fenced, provider, clientId, ready) => {
      if (!ready) {
        await provider.configure(clientId, payload.appId);
        await fenced("provider_confirm");
      }
      return apply();
    }) : await apply();
  const value = result.value;
  response.setHeader("ETag", `"${kind === "applications" ? "application" : "approval"}-${value.appId ?? value.approvalId}-${value.revision}"`);
  if (result.status === 201) response.setHeader("Location", `/v1/${kind}/${value.appId ?? value.approvalId}`);
  return json(response, result.status, value);
}
