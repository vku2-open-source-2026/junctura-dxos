// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { applicationToken } from "../applications/applications.mjs";
import { dataRequest } from "../data/data.mjs";
import { HttpError, json, readJson, requireWriter, uuidPattern } from "../../platform/http/http.mjs";
import { workflowRequest } from "./client.mjs";
import { workflowSummary } from "./summary.mjs";

const engineId = /^[A-Za-z0-9:_-]{1,128}$/;
const executionStatuses = new Set(["running", "completed", "cancelled"]);
const businessLabels = {
  "chuyen-tuyen": "Chuyển tuyến",
  "xac-minh-don-thuoc": "Xác minh đơn thuốc",
  "xac-minh-chi-phi": "Xác minh chi phí",
};

export function canonicalInput(value, depth = 0) {
  if (depth > 32) throw new HttpError(400, "input_too_deep");
  if (Array.isArray(value)) return value.map((item) => canonicalInput(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalInput(value[key], depth + 1)]));
  return value;
}

async function history(config, tenantId, query) {
  return workflowRequest(config, `history/historic-process-instances?${new URLSearchParams({ ...query, tenantId, includeProcessVariables: "true", size: "2" })}`);
}

async function execution(config, tenantId, id) {
  const result = await history(config, tenantId, { processInstanceId: id });
  const item = result.data[0];
  if (!item || item.tenantId !== tenantId || item.id !== id) throw new HttpError(404, "not_found");
  const definition = await workflowRequest(config, `repository/process-definitions/${encodeURIComponent(item.processDefinitionId)}`);
  if (definition.key === "junctura_c4a_single") throw new HttpError(404, "not_found");
  const input = item.variables?.find((variable) => variable.name === "input")?.value;
  return { id: item.id, definitionId: item.processDefinitionId,
    status: item.endTime ? (item.deleteReason ? "cancelled" : "completed") : "running",
    input: input ? JSON.parse(input) : {} };
}

function parseListQuery(url) {
  const allowed = new Set(["limit", "status"]);
  for (const key of new Set(url.searchParams.keys())) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw new HttpError(400, "invalid_query");
    }
  }
  const rawLimit = url.searchParams.get("limit") ?? "20";
  if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 100) {
    throw new HttpError(400, "invalid_query");
  }
  const status = url.searchParams.get("status");
  if (status !== null && !executionStatuses.has(status)) throw new HttpError(400, "invalid_query");
  return { limit: Number(rawLimit), status };
}

function statusOf(item) {
  if (!item.endTime) return "running";
  return item.deleteReason ? "cancelled" : "completed";
}

function safeText(value, max = 200) {
  return typeof value === "string" && value.length >= 1 && value.length <= max &&
    !/[\u0000-\u001f\u007f]/u.test(value) ? value : null;
}

function businessTitle(item) {
  const raw = item.variables?.find((variable) => variable.name === "input")?.value;
  let input = raw;
  if (typeof raw === "string") {
    try { input = JSON.parse(raw); } catch { input = null; }
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const code = safeText(input.ma_ho_so, 32);
  if (!code || !/^[A-Z][A-Z0-9-]{0,31}$/.test(code)) return null;
  const label = businessLabels[input.loai] ?? "Hồ sơ";
  return `${label} ${code}`;
}

async function activeTask(config, tenantId, id) {
  const tasks = await workflowRequest(config, `runtime/tasks?${new URLSearchParams({
    processInstanceId: id, tenantId, size: "1",
  })}`);
  const task = Array.isArray(tasks?.data) ? tasks.data[0] : undefined;
  if (!task || typeof task.id !== "string") return null;
  const groups = [];
  try {
    const links = await workflowRequest(config, `runtime/tasks/${encodeURIComponent(task.id)}/identitylinks`);
    if (Array.isArray(links)) {
      for (const link of links) {
        const group = link?.type === "candidate" ? safeText(link.group ?? link.groupId, 128) : null;
        if (group && !groups.includes(group)) groups.push(group);
      }
    }
  } catch {
    // Identity links are optional. The task itself is enough to show the step.
  }
  return {
    name: safeText(task.name),
    assignee: safeText(task.assignee, 128),
    groups,
    createTime: typeof task.createTime === "string" ? task.createTime : null,
  };
}

function definitionParts(item) {
  const parts = typeof item.processDefinitionId === "string" ? item.processDefinitionId.split(":") : [];
  return {
    key: safeText(parts[0], 128),
    version: /^\d+$/.test(parts[1] ?? "") ? Number(parts[1]) : null,
  };
}

function executionView(item, task, definitions) {
  const status = statusOf(item);
  const definitionId = safeText(item.processDefinitionId);
  const parts = definitionParts(item);
  const known = definitionId ? definitions.get(definitionId) : undefined;
  return {
    id: item.id,
    definition: {
      id: definitionId,
      key: safeText(item.processDefinitionKey, 128) ?? known?.key ?? parts.key ?? null,
      name: safeText(item.processDefinitionName) ?? known?.name ?? null,
      version: Number.isInteger(item.processDefinitionVersion) ? item.processDefinitionVersion : known?.version ?? parts.version ?? null,
    },
    status,
    startedAt: item.startTime ?? null,
    updatedAt: item.endTime ?? task?.createTime ?? item.startTime ?? null,
    title: businessTitle(item),
    currentStep: status === "running" && task ? {
      name: task.name,
      assignee: task.assignee,
      groups: task.groups,
    } : null,
  };
}

async function definitionIndex(config, tenantId) {
  const result = await workflowRequest(config, `repository/process-definitions?${new URLSearchParams({
    tenantId, latest: "true", size: "100",
  })}`);
  const definitions = new Map();
  for (const item of Array.isArray(result?.data) ? result.data : []) {
    const id = safeText(item?.id, 256);
    if (id) definitions.set(id, {
      key: safeText(item.key, 128),
      name: safeText(item.name),
      version: Number.isInteger(item.version) ? item.version : null,
    });
  }
  return definitions;
}

async function listExecutions(config, tenantId, { limit, status }) {
  const items = [];
  const definitions = await definitionIndex(config, tenantId);
  let start = 0;
  let scanned = 0;
  for (let page = 0; page < 20 && items.length < limit; page++) {
    const query = new URLSearchParams({
      tenantId, includeProcessVariables: "true", size: "100", start: String(start),
      sort: "startTime", order: "desc",
    });
    // Flowable's finished flag selects both completed and deleted instances; the
    // deleteReason is the only portable distinction and is filtered below.
    if (status === "running") query.set("finished", "false");
    else if (status) query.set("finished", "true");
    const result = await workflowRequest(config, `history/historic-process-instances?${query}`);
    const batch = Array.isArray(result?.data) ? result.data : [];
    scanned += batch.length;
    for (const item of batch) {
      if (!item || typeof item.id !== "string" || item.tenantId !== tenantId) continue;
      const definitionId = safeText(item.processDefinitionId, 256);
      const known = definitionId ? definitions.get(definitionId) : undefined;
      const definitionKey = safeText(item.processDefinitionKey, 128) ?? known?.key ?? definitionParts(item).key;
      if (definitionKey === "junctura_c4a_single") continue;
      if (status && statusOf(item) !== status) continue;
      const task = statusOf(item) === "running" ? await activeTask(config, tenantId, item.id) : null;
      items.push(executionView(item, task, definitions));
      if (items.length >= limit) break;
    }
    const total = Number.isInteger(result?.total) ? result.total : scanned;
    if (!batch.length || scanned >= total) break;
    start = scanned;
  }
  return { items, limit };
}

async function requireWorkflowAudit(identity, config) {
  if (!config.dataUrl) throw new HttpError(503, "workflow_unavailable");
  if (!identity.clientId) throw new HttpError(403, "verified_client_required");
  let response;
  try {
    response = await fetch(`${config.dataUrl}/rpc/workflow_audit_access`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${applicationToken(identity, config.dataSecret, "junctura_workflow_audit_api")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ payload: {} }),
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
  } catch { throw new HttpError(503, "workflow_unavailable"); }
  if (!response.ok) throw new HttpError(503, "workflow_unavailable");
  let result;
  try { result = await response.json(); } catch { throw new HttpError(503, "workflow_unavailable"); }
  if (result?.error) throw new HttpError(result.status, result.error);
  if (result?.status !== 200 || result?.value?.allowed !== true) {
    throw new HttpError(503, "workflow_unavailable");
  }
}

async function start(request, identity, config) {
  requireWriter(identity);
  const key = request.headers["idempotency-key"];
  if (typeof key !== "string" || !uuidPattern.test(key)) throw new HttpError(400, "uuid_idempotency_key_required");
  const body = await readJson(request);
  if (Object.keys(body).some((name) => !["definitionId", "input"].includes(name)) ||
      typeof body.definitionId !== "string" || !engineId.test(body.definitionId) ||
      (body.input !== undefined && (!body.input || typeof body.input !== "object" || Array.isArray(body.input)))) {
    throw new HttpError(400, "invalid_workflow_request");
  }
  const input = canonicalInput(body.input ?? {});
  const definition = await workflowRequest(config, `repository/process-definitions/${encodeURIComponent(body.definitionId)}`);
  if (definition.tenantId !== identity.tenantId || definition.key === "junctura_c4a_single") throw new HttpError(404, "not_found");
  const hash = createHash("sha256").update(JSON.stringify({ definitionId: body.definitionId, input })).digest("hex");
  const query = new URLSearchParams({ key: `eq.${key}` });
  const ledger = (options) => dataRequest(config, identity.tenantId, query, options, "workflow_requests");
  let reserved = false;
  let row;
  try {
    [row] = await ledger({ method: "POST", body: JSON.stringify({ key, definition_id: body.definitionId, input_hash: hash }) });
    reserved = true;
  } catch (error) {
    if (error.status !== 409) throw error;
    [row] = await ledger();
  }
  if (!row || row.definition_id !== body.definitionId || row.input_hash !== hash) throw new HttpError(409, "idempotency_conflict");
  if (row.engine_id) return { created: false, value: await execution(config, identity.tenantId, row.engine_id) };
  const businessKey = `${identity.tenantId}:${key}`;
  let id;
  if (reserved) {
    const result = await workflowRequest(config, "runtime/process-instances", { method: "POST", body: JSON.stringify({
      // Flowable derives the tenant from this already-authorized definition ID.
      processDefinitionId: body.definitionId, businessKey,
      variables: [{ name: "input", type: "string", value: JSON.stringify(input) }],
    }) });
    id = result.id;
  } else {
    const prior = await history(config, identity.tenantId, { businessKey });
    if (prior.data.length !== 1) throw new HttpError(409, "execution_pending_reconciliation");
    id = prior.data[0].id;
  }
  await ledger({ method: "PATCH", body: JSON.stringify({ engine_id: id }) });
  return { created: reserved, value: await execution(config, identity.tenantId, id) };
}

export async function handleWorkflow(request, response, identity, config, url) {
  if (url.pathname === "/v1/workflows/summary") {
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      throw new HttpError(405, "method_not_allowed");
    }
    if (url.search) throw new HttpError(400, "invalid_query");
    await requireWorkflowAudit(identity, config);
    response.setHeader("Cache-Control", "no-store");
    return json(response, 200, await workflowSummary(config, identity.tenantId));
  }
  if (url.pathname === "/v1/workflows/executions" && request.method === "GET") {
    const options = parseListQuery(url);
    await requireWorkflowAudit(identity, config);
    return json(response, 200, await listExecutions(config, identity.tenantId, options));
  }
  if (url.search) throw new HttpError(400, "invalid_query");
  if (url.pathname === "/v1/workflows/definitions" && request.method === "GET") {
    const result = await workflowRequest(config, `repository/process-definitions?${new URLSearchParams({ tenantId: identity.tenantId, latest: "true", size: "100" })}`);
    return json(response, 200, { items: result.data.filter(item => item.key !== "junctura_c4a_single").map(({ id, key, version, name }) => ({ id, key, version, name })) });
  }
  if (url.pathname === "/v1/workflows/executions" && request.method === "POST") {
    const result = await start(request, identity, config);
    return json(response, result.created ? 201 : 200, result.value);
  }
  const match = url.pathname.match(/^\/v1\/workflows\/executions\/([^/]+)(\/complete)?$/);
  if (!match) throw new HttpError(404, "not_found");
  let id;
  try { id = decodeURIComponent(match[1]); } catch { throw new HttpError(400, "invalid_execution_id"); }
  if (!engineId.test(id)) throw new HttpError(400, "invalid_execution_id");
  const current = await execution(config, identity.tenantId, id);
  if (request.method === "GET" && !match[2]) return json(response, 200, current);
  requireWriter(identity);
  if (request.method === "POST" && match[2]) {
    if (Object.keys(await readJson(request)).length) throw new HttpError(400, "empty_object_required");
    if (current.status === "cancelled") throw new HttpError(409, "already_cancelled");
    if (current.status === "running") {
      const tasks = await workflowRequest(config, `runtime/tasks?${new URLSearchParams({ processInstanceId: id, tenantId: identity.tenantId, size: "2" })}`);
      if (tasks.data.length !== 1) throw new HttpError(409, "workflow_conflict");
      await workflowRequest(config, `runtime/tasks/${encodeURIComponent(tasks.data[0].id)}`, { method: "POST", body: JSON.stringify({ action: "complete" }) });
    }
    return json(response, 200, await execution(config, identity.tenantId, id));
  }
  if (request.method === "DELETE" && !match[2]) {
    if (current.status === "completed") throw new HttpError(409, "already_completed");
    if (current.status === "running") await workflowRequest(config, `runtime/process-instances/${encodeURIComponent(id)}?deleteReason=cancelled`, { method: "DELETE" });
    response.writeHead(204);
    return response.end();
  }
  response.setHeader("Allow", match[2] ? "POST" : "GET, DELETE");
  throw new HttpError(405, "method_not_allowed");
}
