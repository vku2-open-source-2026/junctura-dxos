// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import type { WorkflowDefinition } from "../types";

export interface WorkflowStep {
  id: string;
  labelKey: string;
  roleKey?: string;
}

export interface WorkflowDiagram {
  key: string;
  steps: WorkflowStep[];
}

const CHECKPOINT: WorkflowDiagram = {
  key: "junctura_checkpoint",
  steps: [
    { id: "checkpoint", labelKey: "checkpointTask", roleKey: "owner" },
    { id: "done", labelKey: "complete" },
  ],
};

const SCHOLARSHIP: WorkflowDiagram = {
  key: "scholarship_review",
  steps: [
    { id: "submit", labelKey: "scholarshipIntake", roleKey: "intakeUnit" },
    { id: "review", labelKey: "scholarshipDecision", roleKey: "reviewer" },
    { id: "receive", labelKey: "scholarshipReceive", roleKey: "reviewUnit" },
    { id: "done", labelKey: "complete" },
  ],
};

const PHE_DUYET_YEU_CAU: WorkflowDiagram = {
  key: "junctura_phe_duyet_yeu_cau",
  steps: [
    { id: "tiep_nhan", labelKey: "approvalIntake", roleKey: "intakeUnit" },
    { id: "xet_duyet", labelKey: "approvalReview", roleKey: "reviewUnit" },
    { id: "hoan_tat", labelKey: "approvalComplete", roleKey: "reviewUnit" },
    { id: "done", labelKey: "complete" },
  ],
};

const XAC_MINH_HO_SO: WorkflowDiagram = {
  key: "junctura_xac_minh_ho_so",
  steps: [
    { id: "gui_ho_so", labelKey: "verifySubmit", roleKey: "requestUnit" },
    { id: "xac_nhan", labelKey: "verifyConfirm", roleKey: "reviewUnit" },
    { id: "hoan_tat", labelKey: "verifyComplete", roleKey: "reviewUnit" },
    { id: "done", labelKey: "complete" },
  ],
};

const DOI_SOAT_CHUNG_TU: WorkflowDiagram = {
  key: "junctura_doi_soat_chung_tu",
  steps: [
    { id: "gui_chung_tu", labelKey: "reconcileSubmit", roleKey: "reconcileUnit" },
    { id: "xac_nhan", labelKey: "verifyConfirm", roleKey: "reviewUnit" },
    { id: "hoan_tat", labelKey: "verifyComplete", roleKey: "reviewUnit" },
    { id: "done", labelKey: "complete" },
  ],
};

const WORKFLOW_DIAGRAMS: Record<string, WorkflowDiagram> = {
  junctura_checkpoint: CHECKPOINT,
  scholarship_review: SCHOLARSHIP,
  junctura_phe_duyet_yeu_cau: PHE_DUYET_YEU_CAU,
  junctura_xac_minh_ho_so: XAC_MINH_HO_SO,
  junctura_doi_soat_chung_tu: DOI_SOAT_CHUNG_TU,
};

const INSTALLED_WORKFLOWS = new Set(Object.keys(WORKFLOW_DIAGRAMS));

export function diagramForKey(
  key: string | null | undefined
): WorkflowDiagram | undefined {
  if (!key) return undefined;
  return WORKFLOW_DIAGRAMS[key];
}

export function diagramForDefinition(
  definition: WorkflowDefinition | null | undefined
): WorkflowDiagram | undefined {
  if (!definition) return undefined;
  const key = definition.key || definition.id.split(":")[0];
  return INSTALLED_WORKFLOWS.has(key) ? WORKFLOW_DIAGRAMS[key] : undefined;
}

export function personSteps(diagram: WorkflowDiagram): WorkflowStep[] {
  return diagram.steps.filter((step) => step.roleKey !== undefined);
}
