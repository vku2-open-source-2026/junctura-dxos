// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import type { AuditEventEntry } from "../../../types";

export type RangeFilter = "24h" | "7d" | "30d" | "all";
export type ResultFilter = "success" | "denied" | "error" | "all";
export type AuditResult = Exclude<ResultFilter, "all">;

export interface AuditRow {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  target: string;
  result: AuditResult;
  outcome: string;
}

export const RESULTS: AuditResult[] = ["success", "denied", "error"];

export const RANGE_MS: Record<Exclude<RangeFilter, "all">, number> = {
  "24h": 24 * 3_600_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};

export function resultOf(outcome: string): AuditResult {
  const value = outcome.toLowerCase();
  if (value.includes("deny") || value.includes("denied") || value.includes("forbid")) {
    return "denied";
  }
  if (value.includes("fail") || value.includes("error")) return "error";
  return "success";
}

export function buildAuditRows(entries: AuditEventEntry[]): AuditRow[] {
  return entries.map((entry) => ({
    id: entry.eventId,
    timestamp: entry.occurredAt,
    actor:
      entry.subject ??
      entry.actorAppId ??
      entry.managementClient ??
      entry.issuer ??
      "—",
    action: entry.event,
    target: [entry.resourceType, entry.resourceId]
      .filter((value): value is string => Boolean(value))
      .join(" · "),
    result: resultOf(entry.outcome),
    outcome: entry.outcome,
  }));
}

export function filterAuditRows(
  rows: AuditRow[],
  query: string,
  resultFilter: ResultFilter,
  rangeFilter: RangeFilter
): AuditRow[] {
  const needle = query.trim().toLowerCase();
  const cutoff =
    rangeFilter === "all" ? null : Date.now() - RANGE_MS[rangeFilter];
  return rows.filter((row) => {
    if (resultFilter !== "all" && row.result !== resultFilter) return false;
    if (cutoff !== null && Date.parse(row.timestamp) < cutoff) return false;
    if (!needle) return true;
    return `${row.actor} ${row.action} ${row.target} ${row.result} ${row.outcome}`
      .toLowerCase()
      .includes(needle);
  });
}
