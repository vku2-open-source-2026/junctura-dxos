// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Read-only aggregate of business workflow definitions. Admins may inspect the
// shape and counts of a process, but this module never starts, completes or
// cancels anything and never reads workflow variables or case data.
import { workflowRequest, workflowText } from "./client.mjs";

const MAX_SUMMARY_PAGES = 100;
const metadataCache = new Map();
const MAX_METADATA_ENTRIES = 200;

// Technical fixtures are installed for core verification only. junctura_checkpoint
// is deliberately marked technical:true; neither it nor the C4A engine definition
// belongs in an operator-facing workflow summary.
const TECHNICAL_DEFINITIONS = new Map([
  ["junctura_checkpoint", { name: "Kiểm tra kỹ thuật", technical: true }],
  ["junctura_c4a_single", { name: "Kỹ thuật C4A", technical: true }],
]);

function safeText(value, max = 200) {
  return typeof value === "string" && value.length >= 1 && value.length <= max &&
    !/[\u0000-\u001f\u007f]/u.test(value) ? value : null;
}

function metadataId(value) {
  const id = safeText(value, 64);
  return id && /^[a-z][a-z0-9-]{1,63}$/.test(id) ? id : null;
}

function decodeReferences(value) {
  const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return value.replace(/&(#x[\da-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (reference, entity) => {
    if (!entity.startsWith("#")) return entities[entity];
    const code = entity.startsWith("#x") ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code <= 0x10ffff ? String.fromCodePoint(code) : reference;
  });
}

function attributes(source) {
  const attrs = new Map();
  const pattern = /\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gy;
  let end = 0;
  for (let match; (match = pattern.exec(source));) {
    if (attrs.has(match[1])) return null;
    attrs.set(match[1], decodeReferences(match[2] ?? match[3]));
    end = pattern.lastIndex;
  }
  return source.slice(end).trim() ? null : attrs;
}

export function parseDefinition(xml) {
  if (typeof xml !== "string" || /<!DOCTYPE|<!ENTITY/i.test(xml)) return null;
  const stack = [];
  const tasks = [];
  let definition = null;
  let processElement;
  let processDepth;
  let end = 0;
  let rootSeen = false;
  // Track nesting so task extensions, comments and metadata outside the process
  // cannot supply ownership. Quoted '>' characters belong to attribute values.
  const tags = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w.:-]*)((?:[^"'<>]|"[^"]*"|'[^']*')*)>/g;
  for (const match of xml.matchAll(tags)) {
    const gap = xml.slice(end, match.index);
    if (gap.includes("<") || (!stack.length && gap.trim())) return null;
    end = match.index + match[0].length;
    const [, closing, element, source] = match;
    if (!element) continue;
    if (closing) {
      if (source.trim() || stack.pop() !== element) return null;
      continue;
    }
    if (!stack.length) {
      if (rootSeen) return null;
      rootSeen = true;
    }
    const attrs = attributes(source.replace(/\/\s*$/, ""));
    if (!attrs) return null;
    const localName = element.split(":").at(-1);
    if (localName === "process") {
      if (definition) return null;
      const key = safeText(attrs.get("id"), 128);
      const name = safeText(attrs.get("name"));
      if (!key || !name) return null;
      definition = { key, name, steps: [], owner: null, groups: new Map() };
      processElement = element;
      processDepth = stack.length;
    } else if (definition && stack[processDepth] === processElement) {
      if (localName === "userTask") {
        tasks.push({ name: safeText(attrs.get("name")), groups: safeText(attrs.get("flowable:candidateGroups"), 4096) });
      } else if (stack.length === processDepth + 2 && stack.at(-1).split(":").at(-1) === "extensionElements") {
        const id = metadataId(attrs.get("id"));
        const name = safeText(attrs.get("name"));
        if (id && name) {
          if (element === "junctura:owner") definition.owner ??= { id, name };
          if (element === "junctura:group") definition.groups.set(id, name);
        }
      }
    }
    if (!/\/\s*$/.test(source)) stack.push(element);
  }
  if (!definition || stack.length || xml.slice(end).trim()) return null;
  const seen = new Set();
  for (const task of tasks) {
    if (!task.name || seen.has(task.name)) continue;
    seen.add(task.name);
    const owner = (task.groups ?? "").split(",")
      .map((group) => definition.groups.get(metadataId(group.trim()))).find(Boolean) ?? null;
    definition.steps.push({ name: task.name, owner });
  }
  return definition;
}

async function definitionMetadata(config, id) {
  if (!id) return null;
  if (metadataCache.has(id)) return metadataCache.get(id);
  try {
    const xml = await workflowText(config, `repository/process-definitions/${encodeURIComponent(id)}/resourcedata`);
    const metadata = parseDefinition(xml);
    if (metadata) {
      metadataCache.set(id, metadata);
      if (metadataCache.size > MAX_METADATA_ENTRIES) metadataCache.delete(metadataCache.keys().next().value);
    }
    return metadata;
  } catch {
    // Missing or unreadable metadata affects this definition only. Retry later.
    return null;
  }
}

function definitionParts(item) {
  const parts = typeof item.processDefinitionId === "string" ? item.processDefinitionId.split(":") : [];
  return safeText(parts[0], 128);
}

function statusOf(item) {
  if (!item.endTime) return "running";
  return item.deleteReason ? "cancelled" : "completed";
}

function countTemplate() {
  return { running: 0, completed: 0, cancelled: 0, updatedAt: null, updatedAtMs: 0 };
}

function applyExecution(counts, item) {
  const timestamp = typeof item.endTime === "string" ? item.endTime : item.startTime;
  const parsed = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
  counts[statusOf(item)] += 1;
  if (Number.isFinite(parsed) && parsed > counts.updatedAtMs) {
    counts.updatedAtMs = parsed;
    counts.updatedAt = new Date(parsed).toISOString();
  }
}

async function definitionIndex(config, tenantId) {
  const result = await workflowRequest(config, `repository/process-definitions?${new URLSearchParams({
    tenantId, latest: "true", size: "100",
  })}`);
  const byId = new Map();
  const byKey = new Map();
  for (const item of Array.isArray(result?.data) ? result.data : []) {
    const key = safeText(item?.key, 128);
    const name = safeText(item?.name);
    if (!key) continue;
    const id = safeText(item?.id, 256);
    const definition = { id, key, name: name ?? key };
    byKey.set(key, definition);
    if (id) byId.set(id, definition);
  }
  return { byId, byKey };
}

async function collectCounts(config, tenantId, { byId }) {
  const counts = new Map();
  const names = new Map();
  let start = 0;
  let scanned = 0;
  for (let page = 0; page < MAX_SUMMARY_PAGES; page += 1) {
    const query = new URLSearchParams({
      tenantId, size: "100", start: String(start), sort: "startTime", order: "desc",
    });
    const result = await workflowRequest(config, `history/historic-process-instances?${query}`);
    const batch = Array.isArray(result?.data) ? result.data : [];
    scanned += batch.length;
    for (const item of batch) {
      if (!item || typeof item.id !== "string" || item.tenantId !== tenantId) continue;
      const key = safeText(item.processDefinitionKey, 128) ?? byId.get(item.processDefinitionId)?.key ?? definitionParts(item);
      if (!key || TECHNICAL_DEFINITIONS.has(key)) continue;
      let bucket = counts.get(key);
      if (!bucket) {
        bucket = countTemplate();
        counts.set(key, bucket);
      }
      if (!names.has(key)) {
        const name = safeText(item.processDefinitionName);
        if (name) names.set(key, name);
      }
      applyExecution(bucket, item);
    }
    const total = Number.isInteger(result?.total) ? result.total : scanned;
    if (!batch.length || scanned >= total) break;
    start = scanned;
  }
  return { counts, names };
}

export async function workflowSummary(config, tenantId) {
  const index = await definitionIndex(config, tenantId);
  const { counts, names } = await collectCounts(config, tenantId, index);
  const definitions = new Map();
  const deployed = await Promise.all([...index.byKey.values()]
    .filter((definition) => !TECHNICAL_DEFINITIONS.has(definition.key))
    .map(async (definition) => {
      const metadata = await definitionMetadata(config, definition.id);
      return { key: definition.key, name: definition.name, steps: metadata?.steps ?? [], application: metadata?.owner ?? null };
    }));
  for (const definition of deployed) {
    definitions.set(definition.key, definition);
  }
  for (const key of counts.keys()) {
    if (definitions.has(key)) continue;
    definitions.set(key, { key, name: names.get(key) ?? key, steps: [], application: null });
  }
  const items = [...definitions.values()]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((definition) => {
      const bucket = counts.get(definition.key) ?? countTemplate();
      return {
        key: definition.key,
        name: definition.name,
        application: definition.application,
        steps: definition.steps,
        counts: { running: bucket.running, completed: bucket.completed, cancelled: bucket.cancelled },
        updatedAt: bucket.updatedAt,
      };
    });
  const totals = { definitions: items.length, running: 0, completed: 0, cancelled: 0 };
  for (const item of items) {
    totals.running += item.counts.running;
    totals.completed += item.counts.completed;
    totals.cancelled += item.counts.cancelled;
  }
  return { definitions: items, totals };
}
