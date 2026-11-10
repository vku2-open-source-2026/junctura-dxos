// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Pure model for the workflow step-through explainer.
import type { WorkflowStepState } from "../screens/workflows/WorkflowDiagramNode";

export type SimStepKind = "task" | "approval" | "done";
export type SimStepActor = "auto" | "person";
export type WorkflowPhase = "idle" | "running" | "waiting" | "done" | "rejected";

export interface SimStep {
  id: string;
  labelKey: string;
  kind: SimStepKind;
  actor?: SimStepActor;
}

export const SIM_STEPS: SimStep[] = [
  { id: "submit", labelKey: "scholarshipIntake", kind: "task", actor: "auto" },
  { id: "review", labelKey: "scholarshipDecision", kind: "approval", actor: "person" },
  { id: "receive", labelKey: "scholarshipReceive", kind: "approval", actor: "person" },
  { id: "done", labelKey: "complete", kind: "done" },
];

export interface WorkflowSimState {
  index: number;
  phase: WorkflowPhase;
}

export type WorkflowSimAction =
  | { type: "advance" }
  | { type: "approve" }
  | { type: "reject" }
  | { type: "reset" };

export function initialWorkflowState(): WorkflowSimState {
  return { index: 0, phase: "idle" };
}

function runForward(startIndex: number): WorkflowSimState {
  let index = startIndex;
  while (index < SIM_STEPS.length) {
    const step = SIM_STEPS[index];
    if (step.kind === "done") return { index, phase: "done" };
    if (step.actor === "person") return { index, phase: "waiting" };
    index += 1;
  }
  return { index: SIM_STEPS.length - 1, phase: "done" };
}

export function workflowReducer(
  state: WorkflowSimState,
  action: WorkflowSimAction
): WorkflowSimState {
  switch (action.type) {
    case "advance":
      if (state.phase === "done" || state.phase === "rejected" || state.phase === "waiting") {
        return state;
      }
      return runForward(state.phase === "idle" ? 0 : state.index + 1);
    case "approve":
      if (state.phase !== "waiting") return state;
      return runForward(state.index + 1);
    case "reject":
      if (state.phase !== "waiting") return state;
      return { index: state.index, phase: "rejected" };
    case "reset":
      return initialWorkflowState();
  }
}

export function stepStates(
  state: WorkflowSimState
): Record<string, WorkflowStepState> {
  const result: Record<string, WorkflowStepState> = {};
  SIM_STEPS.forEach((step, index) => {
    if (state.phase === "done") {
      result[step.id] = "done";
    } else if (state.phase === "rejected") {
      result[step.id] =
        index < state.index ? "done" : index === state.index ? "cancelled" : "pending";
    } else if (state.phase === "idle") {
      result[step.id] = index === 0 ? "active" : "pending";
    } else if (index < state.index) {
      result[step.id] = "done";
    } else if (index === state.index) {
      result[step.id] = state.phase === "waiting" ? "active" : "done";
    } else {
      result[step.id] = "pending";
    }
  });
  return result;
}

export function currentStep(state: WorkflowSimState): SimStep {
  return SIM_STEPS[state.index];
}
