// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0

export interface WorkflowStep {
  id: string;
  labelKey: string;
  roleKey?: string;
}

export interface WorkflowDiagram {
  key: string;
  steps: WorkflowStep[];
}

export const EXAMPLE_WORKFLOW: WorkflowDiagram = {
  key: "example_request",
  steps: [
    { id: "submit", labelKey: "exampleSubmit", roleKey: "requester" },
    { id: "review", labelKey: "exampleReview", roleKey: "reviewer" },
    { id: "receive", labelKey: "exampleReceive", roleKey: "receiver" },
    { id: "done", labelKey: "complete" },
  ],
};
