// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import type { WorkflowDiagram as WorkflowDiagramModel } from "../../../constants/workflowDiagrams";
import {
  WorkflowStepItem,
  type WorkflowDiagramStrings,
  type WorkflowStepState,
} from "./WorkflowDiagramNode";

export type { WorkflowDiagramStrings, WorkflowStepState } from "./WorkflowDiagramNode";

interface WorkflowDiagramProps {
  diagram: WorkflowDiagramModel;
  strings: WorkflowDiagramStrings;
  ariaLabel: string;
  states?: Record<string, WorkflowStepState>;
}

export const WorkflowDiagram: React.FC<WorkflowDiagramProps> = ({
  diagram,
  strings,
  ariaLabel,
  states,
}) => {
  const labels = strings.labels as Record<string, string>;
  const roles = strings.roles as Record<string, string>;
  const stepText = diagram.steps
    .map((step) => {
      const label =
        labels[step.labelKey] ??
        (step.labelKey === "complete" ? strings.complete : step.labelKey);
      const role = step.roleKey ? roles[step.roleKey] : undefined;
      return role ? `${label} (${role})` : label;
    })
    .join(" → ");

  return (
    <div className="w-full overflow-x-auto pb-1">
      <ol
        aria-label={`${ariaLabel}. ${stepText}`}
        className="flex min-w-[26rem] items-start pt-1"
      >
        {diagram.steps.map((step, index) => (
          <WorkflowStepItem
            key={step.id}
            step={step}
            index={index}
            total={diagram.steps.length}
            state={states?.[step.id] ?? "pending"}
            strings={strings}
          />
        ))}
      </ol>
    </div>
  );
};
