// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Read-only aggregate of business workflow definitions. Admins may inspect the
// shape and counts of a process, but this module never starts, completes or
// cancels anything and never reads workflow variables or case data.
import { readFileSync, readdirSync } from "node:fs";
import { workflowRequest } from "./client.mjs";

const DEFINITIONS_DIRECTORY = new URL("./definitions/", import.meta.url);
const MAX_SUMMARY_PAGES = 100;

// Technical fixtures are installed for core verification only. junctura_checkpoint
// is deliberately marked technical:true; neither it nor the C4A engine definition
// belongs in an operator-facing workflow summary.
const TECHNICAL_DEFINITIONS = new Map([
  ["junctura_checkpoint", { name: "Kiểm tra kỹ thuật", technical: true }],
  ["junctura_c4a_single", { name: "Kỹ thuật C4A", technical: true }],
]);

// Ownership is a reviewed code-level declaration until applications expose a
// stable key the workflow schema can join on. IDs are stable application keys,
// not database UUIDs.
const APPLICATIONS = new Map([
  ["junctura_phe_duyet_yeu_cau", { id: "don-vi-tiep-nhan", name: "Đơn vị tiếp nhận" }],
  ["junctura_xac_minh_ho_so", { id: "don-vi-de-nghi", name: "Đơn vị đề nghị" }],
  ["junctura_doi_soat_chung_tu", { id: "don-vi-doi-soat", name: "Đơn vị đối soát" }],
]);

const OWNER_LABELS = new Map([
  ["don-vi-tiep-nhan", "Đơn vị tiếp nhận"],
  ["don-vi-xet-duyet", "Đơn vị xét duyệt"],
  ["don-vi-de-nghi", "Đơn vị đề nghị"],
  ["don-vi-doi-soat", "Đơn vị đối soát"],
]);

function safeText(value, max = 200) {
  return typeof value === "string" && value.length >= 1 && value.length <= max &&
    !/[\u0000-\u001f\u007f]/u.test(value) ? value : null;
}

function ownerLabel(groups) {
  if (!groups) return null;
  const labels = [];
  for (const group of groups.split(",").map((item) => item.trim()).filter(Boolean)) {
    const label = OWNER_LABELS.get(group) ?? safeText(group, 128);
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels.length ? labels.join(", ") : null;
}

function parseDefinition(xml) {
  const key = safeText(/<process\b[^>]*\bid="([^"]+)"/.exec(xml)?.[1], 128);
  const name = safeText(/<process\b[^>]*\bname="([^"]+)"/.exec(xml)?.[1]);
  if (!key || !name) return null;
  const steps = [];
  const seen = new Set();
  for (const match of xml.matchAll(/<userTask\b([^>]*)>/g)) {
    const attributes = match[1];
    const stepName = safeText(/\bname="([^"]+)"/.exec(attributes)?.[1]);
    if (!stepName || seen.has(stepName)) continue;
    seen.add(stepName);
    steps.push({
      name: stepName,
      owner: ownerLabel(/\bflowable:candidateGroups="([^"]+)"/.exec(attributes)?.[1]),
    });
  }
  return { key, name, steps };
}

function loadBusinessDefinitions() {
  const definitions = new Map();
  for (const file of readdirSync(DEFINITIONS_DIRECTORY).filter((name) => name.endsWith(".bpmn20.xml")).sort()) {
    const definition = parseDefinition(readFileSync(new URL(file, DEFINITIONS_DIRECTORY), "utf8"));
    if (!definition || TECHNICAL_DEFINITIONS.has(definition.key)) continue;
    definitions.set(definition.key, {
      ...definition,
      application: APPLICATIONS.get(definition.key) ?? null,
    });
  }
  return definitions;
}

const BUSINESS_DEFINITIONS = loadBusinessDefinitions();

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
    const definition = { key, name: name ?? key };
    byKey.set(key, definition);
    const id = safeText(item?.id, 256);
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
  for (const [key, definition] of BUSINESS_DEFINITIONS) {
    definitions.set(key, { ...definition, application: APPLICATIONS.get(key) ?? null });
  }
  for (const [key, definition] of index.byKey) {
    if (definitions.has(key) || TECHNICAL_DEFINITIONS.has(key)) continue;
    definitions.set(key, { key, name: definition.name, steps: [], application: null });
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
