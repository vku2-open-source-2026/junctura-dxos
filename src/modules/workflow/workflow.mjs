// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { applicationToken } from "../applications/applications.mjs";
import { dataRequest, sendRecordResult } from "../data/data.mjs";
import { HttpError, json, jsonObject, readRecordJson, requireWriter, uuidPattern } from "../../platform/http/http.mjs";
import { workflowRequest, workflowText } from "./client.mjs";
import { validateDefinition } from "./definition-policy.mjs";
import { workflowSummary } from "./summary.mjs";
import { completeTask, engineId, executionPolicy, handleClaim, managedStart, releaseCancellationLease, reserveCancellation, workflowTaskPage } from "./tasks.mjs";

export { startWorkflowReconciler } from "./tasks.mjs";
const executionStatuses = new Set(["running", "completed", "cancelled"]);

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
  if (definition.tenantId !== tenantId || definition.key === "junctura_c4a_single") throw new HttpError(404, "not_found");
  const input = item.variables?.find((variable) => variable.name === "input")?.value;
  const view = { id: item.id, definitionId: item.processDefinitionId,
    status: item.endTime ? (item.deleteReason ? "cancelled" : "completed") : "running",
    input: input ? JSON.parse(input) : {} };
  return { view, definitionKey: definition.key };
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

function caseTitle(item, definitionName) {
  if (!definitionName) return null;
  const raw = item.variables?.find((variable) => variable.name === "input")?.value;
  let input = raw;
  if (typeof raw === "string") {
    try { input = JSON.parse(raw); } catch { input = null; }
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return definitionName;
  const reference = safeText(input.reference, 32);
  return reference && /^[A-Z][A-Z0-9-]{0,31}$/.test(reference) ? `${definitionName} ${reference}` : definitionName;
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
  const definitionName = safeText(item.processDefinitionName) ?? known?.name ?? null;
  return {
    id: item.id,
    definition: {
      id: definitionId,
      key: safeText(item.processDefinitionKey, 128) ?? known?.key ?? parts.key ?? null,
      name: definitionName,
      version: Number.isInteger(item.processDefinitionVersion) ? item.processDefinitionVersion : known?.version ?? parts.version ?? null,
    },
    status,
    startedAt: item.startTime ?? null,
    updatedAt: item.endTime ?? task?.createTime ?? item.startTime ?? null,
    title: caseTitle(item, definitionName),
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
  const body = await readRecordJson(request);
  if (!jsonObject(body) || Object.keys(body).some((name) => !["definitionId", "input", "unit", "taskUnits", "dueAt", "taskDueAt"].includes(name)) ||
      typeof body.definitionId !== "string" || !engineId.test(body.definitionId) ||
      (body.input !== undefined && !jsonObject(body.input))) {
    throw new HttpError(400, "invalid_workflow_request");
  }
  const input = canonicalInput(body.input ?? {});
  const definition = await workflowRequest(config, `repository/process-definitions/${encodeURIComponent(body.definitionId)}`);
  if (definition.id !== body.definitionId || definition.tenantId !== identity.tenantId || definition.key === "junctura_c4a_single") {
    throw new HttpError(404, "not_found");
  }
  const startEngine = async (businessKey) => {
    const result = await workflowRequest(config, "runtime/process-instances", { method: "POST", body: JSON.stringify({
      // Flowable derives the tenant from this already-authorized definition ID.
      processDefinitionId: body.definitionId, businessKey,
      variables: [{ name: "input", type: "string", value: JSON.stringify(input) }],
    }) });
    if (result?.tenantId !== identity.tenantId || result.processDefinitionId !== body.definitionId ||
        typeof result.id !== "string" || !engineId.test(result.id)) throw new HttpError(503, "workflow_unavailable");
    return result.id;
  };
  const findEngine = async (businessKey) => {
    const prior = await history(config, identity.tenantId, { businessKey });
    const [item] = prior.data;
    if (prior.data.length !== 1 || item.tenantId !== identity.tenantId || item.businessKey !== businessKey ||
        item.processDefinitionId !== body.definitionId || !engineId.test(item.id ?? "")) {
      throw new HttpError(409, "execution_pending_reconciliation");
    }
    return item.id;
  };
  const readExecution = async (id) => (await execution(config, identity.tenantId, id)).view;
  if (definition.key !== "junctura_checkpoint" || Object.keys(body).some(name => name !== "definitionId" && name !== "input")) {
    return managedStart(config, identity, definition, body, key, startEngine, findEngine, readExecution);
  }
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
  if (row.engine_id) return { status: 200, value: await readExecution(row.engine_id) };
  const businessKey = `${identity.tenantId}:${key}`;
  const id = reserved ? await startEngine(businessKey) : await findEngine(businessKey);
  await ledger({ method: "PATCH", body: JSON.stringify({ engine_id: id }) });
  return { status: reserved ? 201 : 200, value: await readExecution(id) };
}

function verifiedDefinition(item, tenantId, key) {
  return item && typeof item.id === "string" && item.id && item.tenantId === tenantId &&
    item.key === key && Number.isInteger(item.version) && item.version >= 1
    ? { id: item.id, key: item.key, version: item.version } : null;
}

async function latestIdenticalDefinition(config, tenantId, key, xml) {
  const result = await workflowRequest(config, `repository/process-definitions?${new URLSearchParams({
    key, tenantId, latest: "true",
  })}`);
  const latest = verifiedDefinition(Array.isArray(result?.data) ? result.data[0] : undefined, tenantId, key);
  if (!latest) return null;
  const resource = await workflowText(config, `repository/process-definitions/${encodeURIComponent(latest.id)}/resourcedata`);
  return resource === xml ? latest : null;
}

// Publishes one tenant-scoped business BPMN definition for operator installers.
// Authorization (verified direct tenant administrator with the writer role, no
// delegated actor) and policy validation complete before any engine request; the
// tenant always comes from the verified identity. consoleRole is the only
// administrator boundary: auth.mjs sets it solely for the verified
// junctura-console client after checking current role membership, so an ordinary
// writer or backend token never publishes. The tenant ledger row is the durable
// cross-replica reservation, so concurrent requests never rely on an in-process
// lock: only the reserving request deploys, and an ambiguous engine outcome is
// reconciled against the deployed resource.
async function publishDefinition(request, identity, config) {
  requireWriter(identity);
  if (identity.actor) throw new HttpError(403, "delegation_not_allowed");
  if (identity.consoleRole !== "admin") throw new HttpError(403, "operator_required");
  const key = request.headers["idempotency-key"];
  if (typeof key !== "string" || !uuidPattern.test(key)) throw new HttpError(400, "uuid_idempotency_key_required");
  const body = await readRecordJson(request, 262144 + 16384);
  if (!jsonObject(body) || Object.keys(body).length !== 1 || typeof body.xml !== "string") {
    throw new HttpError(400, "invalid_workflow_request");
  }
  const model = validateDefinition(body.xml, { includeTasks: true });
  if (!model.ok) throw new HttpError(400, "definition_invalid", { problems: model.problems });
  if (model.tasks.some(task => task.groups.length === 0)) {
    throw new HttpError(400, "definition_invalid", { problems: [{ rule: "missing_group",
      detail: "Every user task must declare flowable:candidateGroups" }] });
  }
  const tenantId = identity.tenantId;
  const hash = createHash("sha256").update(body.xml).digest("hex");
  const query = new URLSearchParams({ key: `eq.${key}` });
  const ledger = (options) => dataRequest(config, tenantId, query, options, "workflow_requests");
  let reserved = false;
  let row;
  try {
    [row] = await ledger({ method: "POST", body: JSON.stringify({ key, definition_id: model.key, input_hash: hash }) });
    reserved = true;
  } catch (error) {
    if (error.status !== 409) throw error;
    [row] = await ledger();
  }
  if (!row || row.definition_id !== model.key || row.input_hash !== hash) throw new HttpError(409, "idempotency_conflict");
  if (row.engine_id) {
    const replay = await workflowRequest(config, `repository/process-definitions/${encodeURIComponent(row.engine_id)}`)
      .catch(error => error.status === 404 ? null : Promise.reject(error));
    const published = verifiedDefinition(replay, tenantId, model.key);
    if (published) return { status: 200, value: published };
  }
  const existing = await latestIdenticalDefinition(config, tenantId, model.key, body.xml);
  if (existing) {
    if (row.engine_id !== existing.id) {
      await ledger({ method: "PATCH", body: JSON.stringify({ engine_id: existing.id }) });
    }
    return { status: 200, value: existing };
  }
  if (!reserved) throw new HttpError(409, "deployment_pending_reconciliation");
  const form = new FormData();
  form.append("tenantId", tenantId);
  form.append("file", new Blob([body.xml], { type: "application/xml" }), `${model.key}.bpmn20.xml`);
  const deployment = await workflowRequest(config, "repository/deployments", { method: "POST", body: form });
  if (typeof deployment?.id !== "string" || !deployment.id) throw new HttpError(503, "workflow_unavailable");
  const result = await workflowRequest(config, `repository/process-definitions?${new URLSearchParams({
    deploymentId: deployment.id, tenantId, key: model.key,
  })}`);
  const item = verifiedDefinition(Array.isArray(result?.data) ? result.data[0] : undefined, tenantId, model.key);
  if (!item) throw new HttpError(503, "workflow_unavailable");
  await ledger({ method: "PATCH", body: JSON.stringify({ engine_id: item.id }) });
  return { status: 201, value: item };
}

function decodeEngineId(raw, error) {
  let id;
  try { id = decodeURIComponent(raw); } catch { throw new HttpError(400, error); }
  if (!engineId.test(id)) throw new HttpError(400, error);
  return id;
}

function requireMethod(request, response, methods) {
  if (methods.includes(request.method)) return;
  response.setHeader("Allow", methods.join(", "));
  throw new HttpError(405, "method_not_allowed");
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
  if (url.pathname === "/v1/workflows/tasks") {
    requireMethod(request, response, ["GET"]);
    return json(response, 200, await workflowTaskPage(config, identity, url));
  }
  const historyRoute = url.pathname.match(/^\/v1\/workflows\/executions\/([^/]+)\/history$/);
  if (historyRoute) {
    requireMethod(request, response, ["GET"]);
    const id = decodeEngineId(historyRoute[1], "invalid_execution_id");
    await execution(config, identity.tenantId, id);
    return json(response, 200, await workflowTaskPage(config, identity, url, id));
  }
  if (url.search) throw new HttpError(400, "invalid_query");
  const claim = url.pathname.match(/^\/v1\/workflows\/tasks\/([^/]+)\/(claim|release)$/);
  if (claim) {
    requireMethod(request, response, ["POST"]);
    return handleClaim(request, response, identity, config, decodeEngineId(claim[1], "invalid_task_id"), claim[2]);
  }
  if (url.pathname === "/v1/workflows/definitions") {
    if (request.method === "GET") {
      const result = await workflowRequest(config, `repository/process-definitions?${new URLSearchParams({ tenantId: identity.tenantId, latest: "true", size: "100" })}`);
      return json(response, 200, { items: result.data.filter(item => item.key !== "junctura_c4a_single").map(({ id, key, version, name }) => ({ id, key, version, name })) });
    }
    if (request.method === "POST") {
      return sendRecordResult(response, await publishDefinition(request, identity, config));
    }
  }
  if (url.pathname === "/v1/workflows/executions" && request.method === "POST") {
    return sendRecordResult(response, await start(request, identity, config));
  }
  const match = url.pathname.match(/^\/v1\/workflows\/executions\/([^/]+)(\/complete)?$/);
  if (!match) throw new HttpError(404, "not_found");
  requireMethod(request, response, match[2] ? ["POST"] : ["GET", "DELETE"]);
  const id = decodeEngineId(match[1], "invalid_execution_id");
  const readCurrent = () => execution(config, identity.tenantId, id);
  const readExecution = async () => (await readCurrent()).view;
  if (request.method === "GET") {
    const current = await readExecution();
    const policy = await executionPolicy(config, identity, id).catch(error => {
      if (!(error instanceof HttpError) || error.status !== 503) throw error;
      return null;
    });
    return json(response, 200, { ...current, dueAt: policy?.dueAt ?? null });
  }
  requireWriter(identity);
  if (request.method === "POST") {
    const body = await readRecordJson(request, 10 * 65536 + 16384);
    if (!jsonObject(body)) throw new HttpError(400, "invalid_request");
    if (Object.keys(body).length) return completeTask(request, response, identity, config, id, body, readExecution);
    const { view: current, definitionKey } = await readCurrent();
    if (definitionKey !== "junctura_checkpoint" && await executionPolicy(config, identity, id)) {
      throw new HttpError(400, "invalid_request");
    }
    if (current.status === "cancelled") throw new HttpError(409, "already_cancelled");
    if (current.status === "running") {
      const tasks = await workflowRequest(config, `runtime/tasks?${new URLSearchParams({ processInstanceId: id, tenantId: identity.tenantId, size: "2" })}`);
      if (tasks.data.length !== 1) throw new HttpError(409, "workflow_conflict");
      await workflowRequest(config, `runtime/tasks/${encodeURIComponent(tasks.data[0].id)}`, { method: "POST", body: JSON.stringify({ action: "complete" }) });
    }
    return json(response, 200, await readExecution());
  }
  const current = await readExecution();
  const lease = await reserveCancellation(config, identity, current);
  if (current.status === "completed") throw new HttpError(409, "already_completed");
  if (current.status === "running") {
    try {
      await workflowRequest(config, `runtime/process-instances/${encodeURIComponent(id)}?deleteReason=cancelled`, { method: "DELETE" });
    } catch (error) {
      const latest = await readExecution();
      if (latest.status === "completed") throw new HttpError(409, "already_completed");
      if (latest.status === "running" && lease) await releaseCancellationLease(config, identity, id, lease);
      if (latest.status !== "cancelled") throw error;
    }
  }
  return sendRecordResult(response, { status: 204 });
}
