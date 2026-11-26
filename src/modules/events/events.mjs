// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { setTimeout as delay } from "node:timers/promises";
import { HttpError } from "../../platform/http/http.mjs";
import { signInternalToken } from "../../platform/security/internal-token.mjs";
import { workflowRequest } from "../workflow/client.mjs";

export const EVENTS_PATH = "/v1/events";
const taskId = /^[A-Za-z0-9:_-]{1,128}$/;
const taskEvents = new Set(["workflow.task.created", "workflow.task.due_soon", "workflow.task.overdue"]);
const eventNames = new Set(["record.status.changed", "consent.revoked", ...taskEvents]);
const heartbeatMs = 10000;
const taskPageSize = 100;
// One scan walks at most a bounded page count and reports at most the batch
// the journal accepts per observation; the keyset boundary carries the rest to
// the next scan instead of failing the tenant.
const maxObservedTasks = 400;
const maxScanPages = 40;
const maxObservedTaskIds = 4096;

async function eventRpc(config, identity, name, body, signal) {
  const observer = name === "event_observe_tasks" || name === "event_remind_tasks";
  const jwt = signInternalToken(config.dataSecret, {
    role: observer ? "junctura_event_observer" : "junctura_event_api",
    aud: "junctura-data", exp: Math.floor(Date.now() / 1000) + 30,
    tenant_id: identity.tenantId, iss: identity.issuer, sub: identity.subject, client_id: identity.clientId,
    subject_id: identity.subjectId, groups: identity.groups,
  });
  try {
    const timeout = AbortSignal.timeout(5000);
    const response = await fetch(`${config.dataUrl}/rpc/${name}`, {
      method: "POST", redirect: "error", signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.ok) {
      const result = await response.json();
      if (result.status === (observer ? 204 : 200)) return result.value;
    }
  } catch { /* Pass a single provider error through the stream boundary. */ }
  throw new HttpError(503, "events_unavailable");
}

function taskReference(task, tenantId) {
  if (task?.tenantId !== tenantId || task.suspended === true) return null;
  const { id, processInstanceId, processDefinitionId, taskDefinitionKey, createTime } = task;
  const created = Date.parse(createTime);
  if (!Number.isFinite(created) || ![id, processInstanceId, processDefinitionId, taskDefinitionKey]
    .every(value => typeof value === "string" && taskId.test(value))) return null;
  return { taskId: id, executionId: processInstanceId, definitionId: processDefinitionId,
    stepKey: taskDefinitionKey, createdAt: new Date(created).toISOString() };
}

async function taskStillActive(config, tenantId, target) {
  try {
    const current = taskReference(await workflowRequest(config, `runtime/tasks/${encodeURIComponent(target.taskId)}`), tenantId);
    return current && Object.entries(current).every(([key, value]) => target[key] === value);
  } catch (error) {
    if (error.status === 404) return false;
    throw error;
  }
}

// One scan walks a fixed sweep window newest first. The keyset boundary is
// the (createTime, taskId) pair: pages advance by createTime and every page
// re-includes the boundary instant's ties, so a tie never falls between
// pages, taskId dedup keeps the overlap and a resumed scan cheap, and an
// active set that shrinks between pages can never skip a task behind the
// boundary.
async function observeTasks(config, tenantId, startedAt, state, signal) {
  const floor = Math.max(startedAt, Date.now() - 120000);
  const params = new URLSearchParams({ tenantId, createdAfter: new Date(floor).toISOString(),
    size: String(taskPageSize), sort: "createTime", order: "desc", active: "true" });
  const tasks = [];
  let before = state.taskBefore;
  for (let page = 0; page < maxScanPages; page++) {
    signal.throwIfAborted();
    const query = new URLSearchParams(params);
    if (before !== undefined) query.set("createdBefore", new Date(before).toISOString());
    const result = await workflowRequest(config, `runtime/tasks?${query}`);
    if (!Array.isArray(result?.data) || result.data.length > taskPageSize ||
        !Number.isSafeInteger(result.total) || result.total < 0) {
      throw new HttpError(503, "events_unavailable");
    }
    const rows = result.data;
    let oldest = Infinity;
    let boundary = before;
    let fresh = false;
    for (const row of rows) {
      const created = Date.parse(row?.createTime);
      if (Number.isFinite(created)) oldest = Math.min(oldest, created);
      const task = taskReference(row, tenantId);
      if (!task || Date.parse(task.createdAt) <= floor || state.observed.has(task.taskId)) continue;
      state.observed.add(task.taskId);
      fresh = true;
      if (tasks.length < maxObservedTasks) tasks.push(task);
      boundary = new Date(Date.parse(task.createdAt) + 1).toISOString();
      if (tasks.length >= maxObservedTasks) break;
    }
    if (tasks.length >= maxObservedTasks) { state.taskBefore = boundary; break; }
    if (!Number.isFinite(oldest)) { state.taskBefore = undefined; break; }
    if (rows.length < taskPageSize) { state.taskBefore = undefined; break; }
    // A page whose tasks were all observed before only appears when the scan
    // resumed inside an already-served stretch: step past that createTime
    // block exclusively, otherwise re-include its ties on the next page.
    state.taskBefore = fresh ? oldest + 1 : oldest;
    before = state.taskBefore;
  }
  if (state.observed.size > maxObservedTaskIds) state.observed.clear();
  if (tasks.length) await eventRpc(config, { tenantId }, "event_observe_tasks", { payload: tasks }, signal);
}

// The scan makes progress without an open stream. Journal publication remains
// transactional, so a restart or another scanner can revisit the same page.
export function startWorkflowReminders(config, interval = 5000) {
  if (!config.workflowUrl || !config.dataUrl) return;
  const control = new AbortController();
  let start = 0;
  let busy = false;
  let nextLog = 0;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const params = new URLSearchParams({ start: String(start), size: String(taskPageSize),
        sort: "id", order: "asc", active: "true" });
      const result = await workflowRequest(config, `runtime/tasks?${params}`);
      if (!Array.isArray(result?.data) || result.data.length > taskPageSize ||
          !Number.isSafeInteger(result.total) || result.total < 0) throw new Error("invalid task page");
      const tenants = new Map();
      for (const row of result.data) {
        if (typeof row?.tenantId !== "string" || !row.tenantId) continue;
        const task = taskReference(row, row.tenantId);
        if (!task) continue;
        const tasks = tenants.get(row.tenantId) ?? [];
        tasks.push(task);
        tenants.set(row.tenantId, tasks);
      }
      for (const [tenantId, payload] of tenants) {
        control.signal.throwIfAborted();
        await eventRpc(config, { tenantId }, "event_remind_tasks", {
          payload, lead_seconds: config.workflowReminderLeadSeconds ?? 3600,
        }, control.signal);
      }
      start += result.data.length;
      if (!result.data.length || start >= result.total) start = 0;
    } catch {
      if (!control.signal.aborted && Date.now() >= nextLog) {
        console.warn("Workflow reminder scan will retry");
        nextLog = Date.now() + 60000;
      }
    } finally { busy = false; }
  }, interval).unref();
  return () => {
    control.abort();
    clearInterval(timer);
  };
}

export function createEventStreams(config) {
  const tenants = new Map();
  const connections = new Set();
  let closed = false;

  function scan(tenantId, state) {
    if (!config.workflowUrl || state.scan || Date.now() < state.nextScan) return;
    const floor = Math.min(...state.clients.values());
    if (!Number.isFinite(floor)) return;
    state.nextScan = Date.now() + 1000;
    state.scan = observeTasks(config, tenantId, floor, state, state.control.signal)
      .catch(() => { /* The journal still serves other events while task observation retries. */ })
      .finally(() => { state.scan = null; });
  }

  async function handle(request, response, identity, reauthorize, url) {
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      throw new HttpError(405, "method_not_allowed");
    }
    if (url.search) throw new HttpError(400, "invalid_query");
    if (!identity.clientId) throw new HttpError(403, "verified_client_required");
    if (!config.dataUrl || closed) throw new HttpError(503, "events_unavailable");

    const tenantId = identity.tenantId;
    const state = tenants.get(tenantId) ?? { clients: new Map(), control: new AbortController(),
      nextScan: 0, observed: new Set(), taskBefore: undefined };
    if (connections.size >= 64 || state.clients.size >= 8) throw new HttpError(429, "rate_limited");
    const control = new AbortController();
    const stop = () => {
      control.abort();
      if (!response.destroyed) response.destroy();
    };
    const { signal } = control;
    const expiresAt = identity.credentialExpiresAt;
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new HttpError(401, "invalid_token");
    const timer = setTimeout(stop, Math.min(expiresAt - Date.now(), 2 ** 31 - 1));
    connections.add(stop);
    tenants.set(tenantId, state);
    state.clients.set(stop, Infinity);
    response.once("close", stop);

    const command = (operation, payload, caller = identity) =>
      eventRpc(config, caller, "event_stream_command", { operation, payload }, signal);
    const currentIdentity = async () => {
      const current = await reauthorize();
      if (Date.now() >= expiresAt || current.credentialExpiresAt <= Date.now() ||
          current.tenantId !== tenantId || current.issuer !== identity.issuer ||
          current.subject !== identity.subject || current.clientId !== identity.clientId) {
        throw new HttpError(401, "invalid_token");
      }
      signal.throwIfAborted();
      return current;
    };
    const write = frame => {
      signal.throwIfAborted();
      if (!response.write(frame)) stop();
    };

    try {
      const first = await command("start", {});
      const startedAt = Date.parse(first?.startedAt);
      if (!Number.isFinite(startedAt) || !/^\d+$/.test(first?.sequence ?? "")) throw new HttpError(503, "events_unavailable");
      state.clients.set(stop, startedAt);
      signal.throwIfAborted();
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Accel-Buffering": "no",
      });
      write(": connected\n\n");
      let after = first.sequence;
      let heartbeatAt = Date.now() + heartbeatMs;
      while (!signal.aborted) {
        scan(tenantId, state);
        const page = await command("poll", { after });
        if (!page || page.overflow || !Array.isArray(page.items) || page.items.length > 64) break;
        for (const item of page.items) {
          if (!eventNames.has(item.event) || typeof item.sequence !== "string" || !/^\d+$/.test(item.sequence) ||
              BigInt(item.sequence) !== BigInt(after) + 1n) throw new HttpError(503, "events_unavailable");
          after = item.sequence;
          if (taskEvents.has(item.event)) {
            if (!item.task || (item.event === "workflow.task.created" && !(Date.parse(item.task.createdAt) > startedAt)) ||
                !await taskStillActive(config, tenantId, item.task)) continue;
          }
          const caller = await currentIdentity();
          const data = await command("deliver", { sequence: after }, caller);
          if (data && Date.now() < Math.min(expiresAt, caller.credentialExpiresAt)) {
            write(`event: ${item.event}\ndata: ${JSON.stringify(data)}\n\n`);
          }
        }
        if (Date.now() >= heartbeatAt) {
          await currentIdentity();
          write(": heartbeat\n\n");
          heartbeatAt = Date.now() + heartbeatMs;
        }
        await delay(1000, undefined, { signal });
      }
    } catch (error) {
      if (!response.headersSent && !signal.aborted) throw error;
    } finally {
      clearTimeout(timer);
      response.off("close", stop);
      connections.delete(stop);
      state.clients.delete(stop);
      if (state.clients.size === 0) {
        state.control.abort();
        tenants.delete(tenantId);
      }
      if (response.headersSent && !response.destroyed) response.end();
    }
  }

  return {
    handle,
    close() {
      closed = true;
      for (const stop of connections) stop();
    },
  };
}
