// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useReducer } from "react";
import { Check, Play, RotateCcw, X } from "lucide-react";
import { useI18n } from "../../locales/i18n";
import { Button } from "../common/Button";
import { WorkflowDiagram } from "../screens/workflows/WorkflowDiagram";
import { diagramForKey } from "../../constants/workflowDiagrams";
import {
  SIM_STEPS,
  currentStep,
  initialWorkflowState,
  stepStates,
  workflowReducer,
} from "./workflowSimModel";
import { WORKFLOW_SIM_STRINGS } from "./workflowSim.i18n";

const DIAGRAM = diagramForKey("scholarship_review");
const TOTAL_STEPS = SIM_STEPS.length - 1;

export const WorkflowSim: React.FC<{ className?: string }> = ({ className = "" }) => {
  const { t, language } = useI18n();
  const s = WORKFLOW_SIM_STRINGS[language];
  const [state, dispatch] = useReducer(workflowReducer, undefined, initialWorkflowState);
  const states = stepStates(state);
  const step = currentStep(state);
  const labels = t.workflows.diagrams.labels as Record<string, string>;
  const stepName = labels[step.labelKey] ?? step.labelKey;
  const progress =
    state.phase === "done" ? 100 : Math.round((state.index / TOTAL_STEPS) * 100);

  const statusText =
    state.phase === "waiting"
      ? s.waiting
      : state.phase === "done"
        ? s.done
        : state.phase === "rejected"
          ? s.rejected
          : state.phase === "idle"
            ? s.idle
            : s.current.replace("{name}", stepName);

  return (
    <section className={`rounded-md border border-[var(--border)] bg-[var(--card)] p-5 ${className}`}>
      <header className="mb-4">
        <h3 className="text-lg font-semibold text-[var(--text)]">{s.title}</h3>
        <p className="text-sm text-slate-600 dark:text-slate-300">{s.subtitle}</p>
      </header>

      {DIAGRAM && (
        <div className="rounded-md border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900/30">
          <WorkflowDiagram
            diagram={DIAGRAM}
            strings={t.workflows.diagrams}
            ariaLabel={s.diagramAria}
            states={states}
          />
        </div>
      )}

      <div className="mt-4">
        <div
          className="relative h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"
          role="progressbar"
          aria-label={s.title}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <span
            className="absolute inset-y-0 left-0 rounded-full bg-[var(--accent)] transition-[width] duration-500 motion-reduce:transition-none"
            style={{ width: `${progress}%` }}
            aria-hidden="true"
          />
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p
          role="status"
          aria-live="polite"
          className={`text-sm ${
            state.phase === "rejected"
              ? "text-rose-700 dark:text-rose-300"
              : state.phase === "waiting"
                ? "text-amber-700 dark:text-amber-300"
                : "text-slate-600 dark:text-slate-300"
          }`}
        >
          {statusText}
        </p>
        <div className="flex flex-wrap gap-2">
          {state.phase === "waiting" ? (
            <>
              <Button size="sm" variant="teal" leftIcon={<Check className="h-4 w-4" aria-hidden="true" />} onClick={() => dispatch({ type: "approve" })}>{s.approve}</Button>
              <Button size="sm" variant="destructive" leftIcon={<X className="h-4 w-4" aria-hidden="true" />} onClick={() => dispatch({ type: "reject" })}>{s.reject}</Button>
            </>
          ) : (
            <Button size="sm" variant="primary" leftIcon={<Play className="h-4 w-4" aria-hidden="true" />} disabled={state.phase === "done" || state.phase === "rejected"} onClick={() => dispatch({ type: "advance" })}>{s.run}</Button>
          )}
          <Button size="sm" variant="ghost" leftIcon={<RotateCcw className="h-4 w-4" aria-hidden="true" />} onClick={() => dispatch({ type: "reset" })}>{s.reset}</Button>
        </div>
      </div>
    </section>
  );
};

export default WorkflowSim;
