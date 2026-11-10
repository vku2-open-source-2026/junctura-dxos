// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import { Check, X } from "lucide-react";
import type { WorkflowStep } from "../../../constants/workflowDiagrams";
import type { useI18n } from "../../../locales/i18n";

export type WorkflowStepState = "done" | "active" | "pending" | "cancelled";

export type WorkflowDiagramStrings =
  ReturnType<typeof useI18n>["t"]["workflows"]["diagrams"];

function circleClass(state: WorkflowStepState): string {
  switch (state) {
    case "done":
      return "border-emerald-600 bg-emerald-600 text-white";
    case "active":
      return "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)] ring-4 ring-[var(--accent)]/15";
    case "cancelled":
      return "border-rose-500 bg-rose-50 text-rose-600 dark:bg-rose-950/40 dark:text-rose-300";
    default:
      return "border-slate-300 bg-white text-slate-400 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-500";
  }
}

function labelClass(state: WorkflowStepState): string {
  if (state === "done") return "text-emerald-700 dark:text-emerald-300";
  if (state === "active") return "text-[var(--accent)]";
  if (state === "cancelled") return "text-rose-600 dark:text-rose-300";
  return "text-slate-500 dark:text-slate-400";
}

interface WorkflowStepItemProps {
  step: WorkflowStep;
  index: number;
  total: number;
  state: WorkflowStepState;
  strings: WorkflowDiagramStrings;
}

export const WorkflowStepItem: React.FC<WorkflowStepItemProps> = ({
  step,
  index,
  total,
  state,
  strings,
}) => {
  const labels = strings.labels as Record<string, string>;
  const roles = strings.roles as Record<string, string>;
  const label =
    labels[step.labelKey] ??
    (step.labelKey === "complete" ? strings.complete : step.labelKey);
  const role = step.roleKey ? roles[step.roleKey] : undefined;
  const isLast = index === total - 1;
  const lineColor =
    state === "done"
      ? "bg-emerald-500"
      : state === "cancelled"
        ? "bg-rose-300 dark:bg-rose-800"
        : "bg-slate-200 dark:bg-slate-700";

  return (
    <li
      aria-current={state === "active" ? "step" : undefined}
      className={`relative flex min-w-[7.5rem] flex-1 flex-col items-center px-1 text-center ${
        state === "pending" ? "opacity-60" : ""
      }`}
    >
      {!isLast && (
        <span
          aria-hidden="true"
          className={`absolute left-1/2 top-4 z-0 h-0.5 w-full ${lineColor}`}
        />
      )}
      <span
        className={`relative z-10 flex h-8 w-8 items-center justify-center rounded-full border-2 text-sm font-bold ${circleClass(
          state
        )}`}
      >
        {state === "done" ? (
          <Check className="h-4 w-4" aria-hidden="true" />
        ) : state === "cancelled" ? (
          <X className="h-4 w-4" aria-hidden="true" />
        ) : (
          index + 1
        )}
      </span>
      <span className={`mt-2 text-xs font-semibold leading-tight ${labelClass(state)}`}>
        {label}
      </span>
      {role && (
        <span className="mt-0.5 text-xs leading-tight text-slate-500 dark:text-slate-400">
          {role}
        </span>
      )}
    </li>
  );
};
