// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useEffect, useMemo, useState } from "react";
import { GitBranch } from "lucide-react";
import type { WorkflowExecutionSummary } from "../../../types";
import { useI18n } from "../../../locales/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "../../common/Card";
import { Badge, type BadgeVariant } from "../../common/Badge";
import { Button } from "../../common/Button";
import { EmptyState } from "../../common/EmptyState";
import { ErrorState } from "../../common/ErrorState";
import { LoadingSkeleton } from "../../common/LoadingSkeleton";
import { formatDateTime } from "../dashboard/metrics";
import { friendlyWorkflowName } from "./workflowMeta";

type WorkflowStatus = WorkflowExecutionSummary["status"];

interface WorkflowCaseTableProps {
  executions: WorkflowExecutionSummary[];
  products: Record<string, string>;
  filter: WorkflowStatus;
  loading: boolean;
  loadError: boolean;
  onFilterChange: (status: WorkflowStatus) => void;
  onRetry: () => void;
}

const FILTERS: WorkflowStatus[] = ["running", "completed", "cancelled"];
const PAGE_SIZE = 8;

const STATUS_VARIANT: Record<WorkflowStatus, BadgeVariant> = {
  running: "warning",
  completed: "success",
  cancelled: "destructive",
};

export const WorkflowCaseTable: React.FC<WorkflowCaseTableProps> = ({
  executions,
  products,
  filter,
  loading,
  loadError,
  onFilterChange,
  onRetry,
}) => {
  const { t, language } = useI18n();
  const w = t.workflows;
  const locale = language === "vi" ? "vi-VN" : "en-GB";
  const numberLocale = language === "vi" ? "vi-VN" : "en-US";
  const number = (value: number) =>
    new Intl.NumberFormat(numberLocale).format(value);
  const [page, setPage] = useState(0);

  useEffect(() => {
    setPage(0);
  }, [filter]);

  const label = (status: WorkflowStatus): string =>
    status === "running"
      ? w.filterRunning
      : status === "completed"
        ? w.filterCompleted
        : w.filterCancelled;

  const statusLabel = (status: WorkflowStatus): string =>
    status === "running"
      ? w.statusRunning
      : status === "completed"
        ? w.statusCompleted
        : w.statusCancelled;

  const visible = useMemo(
    () => executions.filter((execution) => execution.status === filter),
    [executions, filter]
  );
  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const rows = visible.slice(
    currentPage * PAGE_SIZE,
    currentPage * PAGE_SIZE + PAGE_SIZE
  );

  return (
    <Card>
      <CardHeader>
        <div className="min-w-0">
          <CardTitle>{w.casesTitle}</CardTitle>
          <p className="mt-1 text-sm text-[var(--muted)]">{w.casesDesc}</p>
        </div>
        <Badge variant="outline">
          {w.caseCount.replace("{n}", number(executions.length))}
        </Badge>
      </CardHeader>

      <div
        role="tablist"
        aria-label={w.filterLabel}
        className="flex gap-1 overflow-x-auto border-b border-[var(--border)] px-3 pt-3"
      >
        {FILTERS.map((status) => {
          const count = executions.filter(
            (execution) => execution.status === status
          ).length;
          const selected = status === filter;
          return (
            <button
              key={status}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => onFilterChange(status)}
              className={`-mb-px whitespace-nowrap rounded-t-md border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                selected
                  ? "border-[var(--accent)] text-[var(--accent)]"
                  : "border-transparent text-[var(--muted)] hover:text-[var(--text)]"
              }`}
            >
              {label(status)}
              <span className="ml-1.5 text-xs font-normal">
                ({number(count)})
              </span>
            </button>
          );
        })}
      </div>

      <CardContent className="p-0">
        {loadError ? (
          <div className="p-5">
            <ErrorState
              title={w.loadErrorTitle}
              message={w.loadErrorDesc}
              onRetry={onRetry}
            />
          </div>
        ) : loading && executions.length === 0 ? (
          <div className="p-5">
            <LoadingSkeleton rows={4} />
          </div>
        ) : visible.length === 0 ? (
          <div className="p-5">
            <EmptyState
              title={w.casesEmptyTitle}
              description={
                executions.length === 0
                  ? w.casesEmptyDesc
                  : w.filterEmptyDesc
              }
              icon={<GitBranch className="h-6 w-6" aria-hidden="true" />}
            />
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">{w.casesTitle}</caption>
                <thead>
                  <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--muted)]">
                    <th className="px-3 py-2 font-semibold">{w.colCaseId}</th>
                    <th className="px-3 py-2 font-semibold">{w.colWorkflow}</th>
                    <th className="px-3 py-2 font-semibold">{w.colProduct}</th>
                    <th className="px-3 py-2 font-semibold">{w.colStatus}</th>
                    <th className="px-3 py-2 font-semibold">{w.colStarted}</th>
                    <th className="px-3 py-2 font-semibold">{w.colEnded}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((execution) => {
                    const key = execution.definition.key ?? "";
                    const name = friendlyWorkflowName(execution.definition, w);
                    const ended =
                      execution.status === "running"
                        ? null
                        : execution.updatedAt;
                    return (
                      <tr
                        key={execution.id}
                        className="border-b border-[var(--border)]/60 last:border-0"
                      >
                        <td className="max-w-[16rem] truncate px-3 py-2 font-mono text-xs text-[var(--text)]">
                          {execution.id}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-[var(--text)]">
                          {name}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-[var(--muted)]">
                          {products[key] ?? w.productNone}
                        </td>
                        <td className="px-3 py-2">
                          <Badge variant={STATUS_VARIANT[execution.status]}>
                            {statusLabel(execution.status)}
                          </Badge>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-[var(--muted)]">
                          {execution.startedAt
                            ? formatDateTime(execution.startedAt, locale)
                            : w.unknownTime}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-[var(--muted)]">
                          {ended
                            ? formatDateTime(ended, locale)
                            : w.noEndTime}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {pages > 1 && (
              <div className="flex items-center justify-between gap-3 border-t border-[var(--border)] px-3 py-2 text-sm text-[var(--muted)]">
                <span>
                  {w.pageStatus
                    .replace("{page}", String(currentPage + 1))
                    .replace("{pages}", String(pages))}
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={currentPage === 0}
                    onClick={() => setPage((value) => Math.max(0, value - 1))}
                  >
                    {w.prevPage}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={currentPage >= pages - 1}
                    onClick={() =>
                      setPage((value) => Math.min(pages - 1, value + 1))
                    }
                  >
                    {w.nextPage}
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
};
