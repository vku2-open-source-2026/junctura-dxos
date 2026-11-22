// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { HttpError, jsonObject, logicalRequestDigest, readRecordJson, requireWriter, uuidPattern } from "../../platform/http/http.mjs";
import { signInternalToken } from "../../platform/security/internal-token.mjs";
import { parseRecordBatch, sendRecordResult } from "../data/data.mjs";
import { workflowRequest, workflowText } from "./client.mjs";
import { validateDefinition } from "./definition-policy.mjs";

export const engineId = /^[A-Za-z0-9:_-]{1,128}$/;
const unitId = /^[a-z][a-z0-9-]{1,63}$/;
const definitionKey = /^[a-z][a-z0-9_]{2,63}$/;
const variableName = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const markerName = "__junctura_completion";
const post = (body) => ({ method: "POST", body: JSON.stringify(body) });

async function workflowCommand(config, identity, rpc, operation, payload) {
  if (!config.dataUrl) throw new HttpError(503, "workflow_unavailable");
  const claims = {
    role: rpc === "worker" ? "junctura_workflow_worker" : "junctura_workflow_api",
    tenant_id: identity.tenantId, iss: identity.issuer, sub: identity.subject,
    client_id: identity.clientId, subject_id: identity.subjectId, display_name: identity.preferredUsername,
    resource_writer: identity.roles?.includes("core-writer"), groups: identity.groups, units: identity.units,
    aud: "junctura-data", exp: Math.floor(Date.now() / 1000) + 30,
  };
  try {
    const response = await fetch(`${config.dataUrl}/rpc/workflow_${rpc}_command`, {
      ...post({ operation, payload }),
      headers: { Authorization: `Bearer ${signInternalToken(config.dataSecret, claims)}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    if (!response.ok) throw new Error();
    const result = await response.json();
    if (!Number.isInteger(result?.status) || result.status < 200 || result.status > 499) throw new Error();
    return result;
  } catch { throw new HttpError(503, "workflow_unavailable"); }
}

function rpcValue(result) {
  if (result.error) throw new HttpError(result.status, result.error, result.details);
  return result.value;
}

export async function executionPolicy(config, identity, executionId) {
  return rpcValue(await workflowCommand(config, identity, "execution", "get", { executionId }));
}

function dateTime(value) {
  const match = typeof value === "string" &&
    /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.exec(value);
  if (!match) throw new HttpError(400, "invalid_workflow_request");
  const [, year, month, day] = match.map(Number);
  const utc = new Date(value);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  if (calendar.getUTCMonth() !== month - 1 || day === 0 || /T24:/i.test(value) ||
      !Number.isFinite(utc.getTime()) || utc.getUTCFullYear() < 1 || utc.getUTCFullYear() > 9999) {
    throw new HttpError(400, "invalid_workflow_request");
  }
  return utc.toISOString();
}

function keyedOverrides(value, keys, parse) {
  if (value === undefined) return {};
  if (!jsonObject(value) || Object.keys(value).some(key => !keys.has(key))) {
    throw new HttpError(400, "invalid_workflow_request");
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, parse(item)]));
}

function parseUnit(value) {
  if (typeof value !== "string" || !unitId.test(value)) throw new HttpError(400, "invalid_workflow_request");
  return value;
}

export async function managedStart(config, identity, definition, body, requestKey, startEngine, findEngine, readExecution) {
  const technical = definition.key === "junctura_checkpoint";
  if (technical && (body.unit !== undefined || body.taskUnits !== undefined)) {
    throw new HttpError(400, "invalid_workflow_request");
  }
  const dueAt = body.dueAt === undefined ? undefined : dateTime(body.dueAt);
  const unit = body.unit === undefined ? undefined : parseUnit(body.unit);
  const xml = await workflowText(config, `repository/process-definitions/${encodeURIComponent(definition.id)}/resourcedata`);
  const model = validateDefinition(xml, { includeTasks: true, ...(technical ? { reservedKeys: [] } : {}) });
  if (!model.ok || model.key !== definition.key || (!technical && model.tasks.some(task => task.groups.length === 0))) {
    throw new HttpError(409, "workflow_definition_policy_required");
  }
  const keys = new Set(model.tasks.map(task => task.id));
  const taskUnits = keyedOverrides(body.taskUnits, keys, parseUnit);
  const taskDueAt = keyedOverrides(body.taskDueAt, keys, dateTime);
  const steps = Object.fromEntries(model.tasks.map(({ id, name, groups }) => [id, {
    name: [...name].slice(0, 120).join(""), groups,
    unit: Object.hasOwn(taskUnits, id) ? taskUnits[id] : undefined,
    dueAt: Object.hasOwn(taskDueAt, id) ? taskDueAt[id] : undefined,
  }]));
  const payload = { definitionId: definition.id, definitionKey: definition.key, requestKey, unit, dueAt, steps,
    digest: logicalRequestDigest({ body }) };
  const reserve = await workflowCommand(config, identity, "execution", "reserve", payload);
  const { reserved, businessKey } = rpcValue(reserve);
  if (reserve.status === 201) return reserve;
  const id = reserved ? await startEngine(`workflow:${businessKey}`) : await findEngine(`workflow:${businessKey}`);
  const execution = await readExecution(id);
  return workflowCommand(config, identity, "execution", "confirm", { ...payload, execution });
}

function taskIdentity(task, tenant) {
  if (task?.tenantId !== tenant || ![task.id, task.processInstanceId, task.processDefinitionId,
    task.taskDefinitionKey, task.executionId].every(id => typeof id === "string" && engineId.test(id))) return null;
  return {
    taskId: task.id, executionId: task.processInstanceId, definitionId: task.processDefinitionId,
    stepKey: task.taskDefinitionKey, engineExecutionId: task.executionId,
  };
}

async function runtimeTask(config, taskId) {
  try { return await workflowRequest(config, `runtime/tasks/${encodeURIComponent(taskId)}`); }
  catch (error) { if (error.status === 404) return null; throw error; }
}

async function historicTask(config, tenantId, taskId, processInstanceId, withMarker = false) {
  const query = new URLSearchParams({ tenantId, taskId, size: "2", includeTaskLocalVariables: String(withMarker) });
  if (processInstanceId !== undefined) query.set("processInstanceId", processInstanceId);
  const result = await workflowRequest(config, `history/historic-task-instances?${query}`);
  if (!Array.isArray(result?.data) || result.data.length > 1) throw new HttpError(503, "workflow_unavailable");
  return result.data[0];
}

async function loadTask(config, tenantId, taskId, executionId) {
  const active = await runtimeTask(config, taskId);
  const task = active ?? await historicTask(config, tenantId, taskId, executionId);
  const key = taskIdentity(task, tenantId);
  if (!key || key.taskId !== taskId || (executionId !== undefined && key.executionId !== executionId)) {
    throw new HttpError(404, "not_found");
  }
  return { ...key, active: Boolean(active), finished: Boolean(task.endTime && task.deleteReason == null) };
}

const taskFilters = { unit: unitId, candidateGroup: unitId, definitionKey, overdue: /^(true|false)$/ };
const cursorTime = /^(\d{4})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/;

function pageOptions(url, mode) {
  const fields = mode === "list" ? taskFilters : {};
  const params = url.searchParams;
  for (const key of new Set(params.keys())) {
    if ((key !== "limit" && key !== "cursor" && !Object.hasOwn(fields, key)) || params.getAll(key).length !== 1) {
      throw new HttpError(400, "invalid_query");
    }
  }
  const rawLimit = params.get("limit") ?? "20";
  const limit = Number(rawLimit);
  if (!/^\d+$/.test(rawLimit) || limit < 1 || limit > 100) throw new HttpError(400, "invalid_query");
  const filters = {};
  for (const [key, pattern] of Object.entries(fields)) {
    const value = params.get(key);
    if (value === null) continue;
    if (!pattern.test(value)) throw new HttpError(400, "invalid_query");
    filters[key] = value;
  }
  return { limit, filters, cursor: params.get("cursor") };
}

function cursorAfter(cursor, scope, allowNull) {
  if (cursor === null) return undefined;
  try {
    if (!/^[A-Za-z0-9_-]{1,1024}$/.test(cursor)) throw new Error();
    const [storedScope, time, taskId] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (scope !== storedScope || typeof taskId !== "string" || !engineId.test(taskId)) throw new Error();
    if (!(time === null && allowNull)) {
      if (typeof time !== "string" || !cursorTime.test(time)) throw new Error();
      dateTime(time);
    }
    return [time, taskId];
  } catch { throw new HttpError(400, "invalid_query"); }
}

async function activeTasks(config, tenantId, key) {
  const tasks = new Map();
  const params = new URLSearchParams({ tenantId, size: "100", sort: "id", order: "asc" });
  if (key) params.set("processDefinitionKey", key);
  for (let start = 0; ; ) {
    params.set("start", String(start));
    const result = await workflowRequest(config, `runtime/tasks?${params}`);
    if (!Array.isArray(result?.data) || !Number.isInteger(result.total)) throw new HttpError(503, "workflow_unavailable");
    for (const task of result.data) {
      const identity = taskIdentity(task, tenantId);
      if (identity) tasks.set(identity.taskId, identity);
    }
    start += result.data.length;
    if (!result.data.length || start >= result.total) return [...tasks.values()];
  }
}

export async function workflowTaskPage(config, identity, url, executionId) {
  const mode = executionId === undefined ? "list" : "history";
  const { limit, filters, cursor } = pageOptions(url, mode);
  const scope = logicalRequestDigest({ body: { tenant: identity.tenantId, mode, executionId, filters } });
  const after = cursorAfter(cursor, scope, mode === "list");
  const tasks = mode === "list" && identity.groups?.length
    ? await activeTasks(config, identity.tenantId, filters.definitionKey) : [];
  const result = await workflowCommand(config, identity, "task", mode, { ...filters, executionId, tasks, limit: limit + 1, after });
  const items = rpcValue(result);
  const more = items.length > limit;
  if (more) items.pop();
  const last = items.at(-1);
  return { items, nextCursor: more
    ? Buffer.from(JSON.stringify([scope, mode === "list" ? last.dueAt : last.completedAt, last.taskId])).toString("base64url")
    : null };
}

function hasBody(request) {
  return (request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0") ||
    request.headers["transfer-encoding"] !== undefined;
}

export async function handleClaim(request, response, identity, config, taskId, action) {
  requireWriter(identity);
  const body = hasBody(request) ? await readRecordJson(request) : {};
  const ttlSeconds = body.ttlSeconds ?? 1800;
  if (!jsonObject(body) || Object.keys(body).some(key => action !== "claim" || key !== "ttlSeconds") ||
      (Object.hasOwn(body, "ttlSeconds") && (!Number.isInteger(body.ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 28800))) {
    throw new HttpError(400, "invalid_request");
  }
  const task = await loadTask(config, identity.tenantId, taskId);
  return sendRecordResult(response, await workflowCommand(config, identity, "task", action, { ...task, ttlSeconds }));
}

export async function completeTask(request, response, identity, config, executionId, body, readExecution) {
  const { taskId, variables = {}, records } = body;
  const requestKey = request.headers["idempotency-key"];
  if (typeof requestKey !== "string" || !uuidPattern.test(requestKey)) throw new HttpError(400, "uuid_idempotency_key_required");
  if (typeof taskId !== "string" || !engineId.test(taskId) || Object.keys(body).some(key => !["taskId", "variables", "records"].includes(key)) ||
      !jsonObject(variables) || Object.entries(variables).some(([name, value]) =>
        !variableName.test(name) || name === "input" || name === markerName ||
        !(typeof value === "string" || typeof value === "boolean" || Number.isFinite(value))) ||
      [["decision", 120], ["reason", 500]].some(([name, max]) => Object.hasOwn(variables, name) &&
        (typeof variables[name] !== "string" || variables[name].length === 0 || [...variables[name]].length > max))) {
    throw new HttpError(400, "invalid_request");
  }
  if (Buffer.byteLength(JSON.stringify(variables)) > 4096) throw new HttpError(413, "body_too_large");
  let operations;
  if (records !== undefined) {
    if (!Array.isArray(records) || records.length < 1 || records.length > 10 ||
        records.some(item => !jsonObject(item) || Object.keys(item).some(key => key !== "collection" && key !== "data"))) {
      throw new HttpError(400, "invalid_request");
    }
    operations = parseRecordBatch({ operations: records.map(record => ({ ...record, op: "create" })) }).operations;
  }
  const payload = { taskId, executionId, variables, records: operations, requestKey, digest: logicalRequestDigest({ body }) };
  const receipt = await workflowCommand(config, identity, "task", "complete", payload);
  if (receipt.status !== 200) return sendRecordResult(response, receipt);
  const execution = await readExecution();
  const task = await loadTask(config, identity.tenantId, taskId, executionId);
  if (task.definitionId !== execution.definitionId) throw new HttpError(404, "not_found");
  if (execution.status !== "running") task.active = false;
  return sendRecordResult(response, await workflowCommand(config, identity, "task", "complete", { ...payload, ...task, execution }));
}

export async function reserveCancellation(config, identity, execution) {
  rpcValue(await workflowCommand(config, identity, "task", "cancel", { executionId: execution.id, status: execution.status }));
}

function matches(job, task) {
  const identity = taskIdentity(task, job.tenant_id);
  return identity?.taskId === job.task_id && identity.executionId === job.execution_id &&
    identity.engineExecutionId === job.engine_execution_id && identity.definitionId === job.definition_id &&
    identity.stepKey === job.step_key;
}

async function completionEvidence(config, job) {
  const prior = await historicTask(config, job.tenant_id, job.task_id, job.execution_id, true);
  if (!matches(job, prior) || !prior.endTime) return null;
  if (prior.deleteReason != null) return { state: "cancelled" };
  const marker = prior.variables?.find(variable => variable.name === markerName && variable.scope === "local");
  if (marker?.value !== job.marker) return { state: "unconfirmed" };
  return { state: "applied", completedAt: new Date(prior.endTime).toISOString() };
}

export async function reconcileCompletion(config, job) {
  const evidence = await completionEvidence(config, job);
  if (evidence) return evidence;
  const task = await runtimeTask(config, job.task_id);
  if (!matches(job, task)) return { state: "pending" };
  const variables = Object.entries(job.variables).map(([name, value]) => ({
    name, value, type: typeof value === "number" ? (Number.isInteger(value) ? "long" : "double") : typeof value,
  }));
  // Flowable stores the local variable and ends this task in the same engine transaction.
  variables.push({ name: markerName, value: job.marker, type: "string", scope: "local" });
  try {
    await workflowRequest(config, `runtime/tasks/${encodeURIComponent(job.task_id)}`, post({ action: "complete", variables }));
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    // The engine may have committed before Core lost its response.
  }
  return await completionEvidence(config, job) ?? { state: "pending" };
}

export function startWorkflowReconciler(config, delay = 1000) {
  if (!config.workflowUrl || !config.dataUrl) return;
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const job = rpcValue(await workflowCommand(config, {}, "worker", "lease", {}));
      if (!job) return;
      let outcome = { state: "pending" };
      try { outcome = await reconcileCompletion(config, job); }
      catch { /* Resume after the durable retry delay. */ }
      await workflowCommand(config, { tenantId: job.tenant_id }, "worker", "settle", {
        taskId: job.task_id, lease: job.lease, ...outcome,
      });
    } catch { /* An unfinished lease can be acquired after it expires. */ }
    finally { busy = false; }
  }, delay).unref();
  return () => clearInterval(timer);
}
