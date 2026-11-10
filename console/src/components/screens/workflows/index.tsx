// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Info, RefreshCw } from "lucide-react";
import type {
  WorkflowExecutionSummary,
  WorkflowSummary as WorkflowSummaryData,
  WorkflowSummaryDefinition,
} from "../../../types";
import { api } from "../../../services/apiClient";
import { useI18n } from "../../../locales/i18n";
import { PageHeader } from "../../layout/PageHeader";
import { Button } from "../../common/Button";
import { DetailDrawer } from "../../common/DetailDrawer";
import { WorkflowSummary } from "./WorkflowSummary";
import { WorkflowCaseTable } from "./WorkflowCaseTable";
import { friendlyWorkflowName } from "./workflowMeta";

type WorkflowStatus = WorkflowExecutionSummary["status"];

export const WorkflowsScreen: React.FC = () => {
  const { t } = useI18n();
  const w = t.workflows;

  const [summary, setSummary] = useState<WorkflowSummaryData | null>(null);
  const [executions, setExecutions] = useState<WorkflowExecutionSummary[]>([]);
  const [filter, setFilter] = useState<WorkflowStatus>("running");
  const [loading, setLoading] = useState(true);
  const [summaryError, setSummaryError] = useState(false);
  const [executionsError, setExecutionsError] = useState(false);
  const [selected, setSelected] =
    useState<WorkflowSummaryDefinition | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setSummaryError(false);
    setExecutionsError(false);
    const [summaryResult, executionsResult] = await Promise.allSettled([
      api.getWorkflowSummary(),
      api.getWorkflowExecutions({ limit: 100 }),
    ]);
    if (summaryResult.status === "fulfilled") {
      setSummary(summaryResult.value);
    } else {
      setSummary(null);
      setSummaryError(true);
    }
    if (executionsResult.status === "fulfilled") {
      setExecutions(executionsResult.value);
    } else {
      setExecutions([]);
      setExecutionsError(true);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const products = useMemo(() => {
    const map: Record<string, string> = {};
    for (const definition of summary?.definitions ?? []) {
      if (definition.application) {
        map[definition.key] = definition.application.name;
      }
    }
    return map;
  }, [summary]);

  const selectedName = selected
    ? friendlyWorkflowName(selected, w)
    : undefined;

  return (
    <div className="space-y-6">
      <PageHeader
        title={w.title}
        subtitle={w.subtitle}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load()}
            isLoading={loading}
            leftIcon={<RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
          >
            {t.common.refresh}
          </Button>
        }
      />

      <p className="flex items-start gap-2 text-sm text-[var(--muted)]">
        <Info className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
        <span>{w.readOnlyNote}</span>
      </p>

      <WorkflowSummary
        summary={summary}
        loading={loading}
        loadError={summaryError}
        onRetry={() => void load()}
        onSelect={setSelected}
      />

      <WorkflowCaseTable
        executions={executions}
        products={products}
        filter={filter}
        loading={loading}
        loadError={executionsError}
        onFilterChange={setFilter}
        onRetry={() => void load()}
      />

      <DetailDrawer
        isOpen={selected !== null}
        onClose={() => setSelected(null)}
        title={w.stepsTitle}
        subtitle={selectedName}
      >
        {selected ? (
          <div className="space-y-5">
            <p className="text-sm leading-relaxed text-[var(--muted)]">
              {w.stepsDesc}
            </p>
            {selected.steps.length === 0 ? (
              <p className="text-sm text-[var(--muted)]">{w.stepsEmpty}</p>
            ) : (
              <ol className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                {selected.steps.map((step, index) => (
                  <li
                    key={`${step.name}-${index}`}
                    className="min-w-40 flex-1 rounded-md border border-[var(--border)] bg-[var(--card)] p-3"
                  >
                    <span className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
                      {w.stepNumber.replace("{n}", String(index + 1))}
                    </span>
                    <p className="mt-1 font-semibold text-[var(--text)]">
                      {step.name}
                    </p>
                    <p className="mt-0.5 text-sm text-[var(--muted)]">
                      {step.owner ?? w.stepOwnerUnknown}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </div>
        ) : null}
      </DetailDrawer>
    </div>
  );
};
