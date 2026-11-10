// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import {
  CheckCircle2,
  Clock,
  GitBranch,
  XCircle,
} from "lucide-react";
import type {
  WorkflowSummary as WorkflowSummaryData,
  WorkflowSummaryDefinition,
} from "../../../types";
import { useI18n } from "../../../locales/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "../../common/Card";
import { StatCard } from "../../common/StatCard";
import { EmptyState } from "../../common/EmptyState";
import { ErrorState } from "../../common/ErrorState";
import { LoadingSkeleton } from "../../common/LoadingSkeleton";
import { friendlyWorkflowName } from "./workflowMeta";

interface WorkflowSummaryProps {
  summary: WorkflowSummaryData | null;
  loading: boolean;
  loadError: boolean;
  onRetry: () => void;
  onSelect: (definition: WorkflowSummaryDefinition) => void;
}

export const WorkflowSummary: React.FC<WorkflowSummaryProps> = ({
  summary,
  loading,
  loadError,
  onRetry,
  onSelect,
}) => {
  const { t, language } = useI18n();
  const w = t.workflows;
  const numberLocale = language === "vi" ? "vi-VN" : "en-US";
  const number = (value: number) =>
    new Intl.NumberFormat(numberLocale).format(value);
  const totals = summary?.totals;
  const definitions = summary?.definitions ?? [];
  const productOf = (definition: WorkflowSummaryDefinition): string =>
    definition.application?.name ?? w.productNone;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title={w.statDefinitions}
          value={loading && !totals ? "—" : number(totals?.definitions ?? 0)}
          icon={<GitBranch className="h-4 w-4" aria-hidden="true" />}
        />
        <StatCard
          title={w.statRunning}
          value={loading && !totals ? "—" : number(totals?.running ?? 0)}
          icon={<Clock className="h-4 w-4" aria-hidden="true" />}
        />
        <StatCard
          title={w.statCompleted}
          value={loading && !totals ? "—" : number(totals?.completed ?? 0)}
          icon={<CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
        />
        <StatCard
          title={w.statCancelled}
          value={loading && !totals ? "—" : number(totals?.cancelled ?? 0)}
          icon={<XCircle className="h-4 w-4" aria-hidden="true" />}
        />
      </div>

      <Card>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle>{w.summaryTitle}</CardTitle>
            <p className="mt-1 text-sm text-[var(--muted)]">{w.summaryDesc}</p>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {loadError ? (
            <div className="p-5">
              <ErrorState
                title={w.summaryErrorTitle}
                message={w.summaryErrorDesc}
                onRetry={onRetry}
              />
            </div>
          ) : loading && definitions.length === 0 ? (
            <div className="p-5">
              <LoadingSkeleton rows={4} />
            </div>
          ) : definitions.length === 0 ? (
            <div className="p-5">
              <EmptyState
                title={w.summaryEmptyTitle}
                description={w.summaryEmptyDesc}
                icon={<GitBranch className="h-6 w-6" aria-hidden="true" />}
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">{w.summaryTitle}</caption>
                <thead>
                  <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--muted)]">
                    <th className="px-3 py-2 font-semibold">{w.colWorkflow}</th>
                    <th className="px-3 py-2 font-semibold">{w.colProduct}</th>
                    <th className="px-3 py-2 text-right font-semibold">
                      {w.colRunning}
                    </th>
                    <th className="px-3 py-2 text-right font-semibold">
                      {w.colCompleted}
                    </th>
                    <th className="px-3 py-2 text-right font-semibold">
                      {w.colCancelled}
                    </th>
                    <th className="min-w-40 px-3 py-2 font-semibold">
                      {w.colSuccessRate}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {definitions.map((definition) => {
                    const name = friendlyWorkflowName(definition, w);
                    const decided =
                      definition.counts.completed + definition.counts.cancelled;
                    const rate =
                      decided > 0
                        ? Math.round(
                            (definition.counts.completed / decided) * 100
                          )
                        : 0;
                    return (
                      <tr
                        key={definition.key}
                        onClick={() => onSelect(definition)}
                        className="cursor-pointer border-b border-[var(--border)]/60 last:border-0 hover:bg-[var(--accent-soft)]/60"
                      >
                        <td className="px-3 py-2">
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              onSelect(definition);
                            }}
                            className="text-left font-medium text-[var(--text)] hover:text-[var(--accent)] hover:underline"
                          >
                            {name}
                          </button>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-[var(--muted)]">
                          {productOf(definition)}
                        </td>
                        <td className="px-3 py-2 text-right text-[var(--muted)]">
                          {number(definition.counts.running)}
                        </td>
                        <td className="px-3 py-2 text-right text-[var(--muted)]">
                          {number(definition.counts.completed)}
                        </td>
                        <td className="px-3 py-2 text-right text-[var(--muted)]">
                          {number(definition.counts.cancelled)}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            <div
                              className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--accent-soft)]"
                              role="img"
                              aria-label={w.successRateAria
                                .replace("{name}", name)
                                .replace("{rate}", String(rate))}
                            >
                              <div
                                className="h-full rounded-full bg-[var(--chart-blue)]"
                                style={{ width: `${rate}%` }}
                              />
                            </div>
                            <span className="w-10 text-right text-xs font-semibold text-[var(--text)]">
                              {w.successRateValue.replace(
                                "{rate}",
                                String(rate)
                              )}
                            </span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
