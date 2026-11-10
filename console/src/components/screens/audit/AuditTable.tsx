// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import { useI18n } from "../../../locales/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "../../common/Card";
import { Badge, type BadgeVariant } from "../../common/Badge";
import { SearchFilterBar } from "../../common/SearchFilterBar";
import {
  RESULTS,
  type AuditResult,
  type AuditRow,
  type RangeFilter,
  type ResultFilter,
} from "./auditRows";

const RESULT_VARIANT: Record<AuditResult, BadgeVariant> = {
  success: "teal",
  denied: "warning",
  error: "destructive",
};

const selectClass =
  "px-2.5 py-1.5 text-sm rounded-md border border-slate-200 dark:border-[#243843] bg-white dark:bg-[#13242D] text-stone-ink dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-[#176B80] dark:focus:ring-[var(--accent)]";

interface AuditTableProps {
  rows: AuditRow[];
  query: string;
  onQueryChange: (value: string) => void;
  resultFilter: ResultFilter;
  onResultChange: (value: ResultFilter) => void;
  rangeFilter: RangeFilter;
  onRangeChange: (value: RangeFilter) => void;
  numberLocale: string;
  loading: boolean;
}

export const AuditTable: React.FC<AuditTableProps> = ({
  rows,
  query,
  onQueryChange,
  resultFilter,
  onResultChange,
  rangeFilter,
  onRangeChange,
  numberLocale,
  loading,
}) => {
  const { t } = useI18n();
  const a = t.audit;
  const label = (key: string) => (a as Record<string, string>)[key] ?? key;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{a.title}</CardTitle>
        <Badge variant="outline">
          {a.count.replace("{n}", String(rows.length))}
        </Badge>
      </CardHeader>
      <CardContent className="p-0">
        <div className="border-b border-slate-100 px-5 py-4 dark:border-[#243843]/70">
          <SearchFilterBar
            searchQuery={query}
            onSearchChange={onQueryChange}
            placeholder={a.searchPlaceholder}
            filterComponent={
              <div className="flex flex-wrap gap-2">
                <select
                  aria-label={a.resultFilter}
                  value={resultFilter}
                  onChange={(event) =>
                    onResultChange(event.target.value as ResultFilter)
                  }
                  className={selectClass}
                >
                  <option value="all">{a.allResults}</option>
                  {RESULTS.map((result) => (
                    <option key={result} value={result}>
                      {label(`result_${result}`)}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={a.rangeFilter}
                  value={rangeFilter}
                  onChange={(event) =>
                    onRangeChange(event.target.value as RangeFilter)
                  }
                  className={selectClass}
                >
                  <option value="24h">{a.range24h}</option>
                  <option value="7d">{a.range7d}</option>
                  <option value="30d">{a.range30d}</option>
                  <option value="all">{a.rangeAll}</option>
                </select>
              </div>
            }
          />
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm text-slate-600 dark:text-slate-300">
            <caption className="sr-only">{a.tableCaption}</caption>
            <thead className="border-b border-slate-200/80 bg-slate-50 text-sm font-semibold uppercase text-slate-500 dark:border-[#243843] dark:bg-[#1B303B]/40 dark:text-slate-400">
              <tr>
                <th className="px-5 py-3">{a.colTime}</th>
                <th className="px-5 py-3">{a.colActor}</th>
                <th className="px-5 py-3">{a.colAction}</th>
                <th className="px-5 py-3">{a.colTarget}</th>
                <th className="px-5 py-3">{a.colResult}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-[#243843]/70">
              {rows.length === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    className="px-5 py-10 text-center text-slate-400"
                  >
                    <p className="font-semibold text-slate-500 dark:text-slate-300">
                      {loading ? t.common.loading : a.emptyTitle}
                    </p>
                    {!loading && <p className="mt-1">{a.emptyDesc}</p>}
                  </td>
                </tr>
              )}
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className="transition-colors hover:bg-slate-50/80 dark:hover:bg-[#1B303B]/30"
                >
                  <td className="whitespace-nowrap px-5 py-3 text-slate-500 dark:text-slate-400">
                    {new Date(row.timestamp).toLocaleString(numberLocale)}
                  </td>
                  <td className="px-5 py-3">
                    <span className="font-mono text-xs text-stone-ink dark:text-slate-100">
                      {row.actor}
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    <span className="block font-medium">{row.action}</span>
                    <span className="mt-0.5 block text-xs text-slate-400">
                      {row.outcome}
                    </span>
                  </td>
                  <td className="max-w-xs px-5 py-3 text-slate-500 dark:text-slate-400">
                    {row.target || "—"}
                  </td>
                  <td className="px-5 py-3">
                    <Badge variant={RESULT_VARIANT[row.result]}>
                      {label(`result_${row.result}`)}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
};
