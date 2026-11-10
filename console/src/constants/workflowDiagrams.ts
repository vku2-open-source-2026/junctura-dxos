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
    { id: "submit", labelKey: "scholarshipIntake", roleKey: "healthStation" },
    { id: "review", labelKey: "scholarshipDecision", roleKey: "hospitalDoctor" },
    { id: "receive", labelKey: "scholarshipReceive", roleKey: "hospital" },
    { id: "done", labelKey: "complete" },
  ],
};

const CHUYEN_TUYEN: WorkflowDiagram = {
  key: "junctura_chuyen_tuyen",
  steps: [
    { id: "tiep_nhan", labelKey: "chuyenTuyenIntake", roleKey: "healthStation" },
    { id: "bac_si_duyet", labelKey: "chuyenTuyenReview", roleKey: "hospitalDoctor" },
    { id: "hoan_tat", labelKey: "chuyenTuyenComplete", roleKey: "hospital" },
    { id: "done", labelKey: "complete" },
  ],
};

const XAC_MINH_DON_THUOC: WorkflowDiagram = {
  key: "junctura_xac_minh_don_thuoc",
  steps: [
    { id: "nha_thuoc_gui", labelKey: "pharmacySubmit", roleKey: "pharmacy" },
    { id: "benh_vien_xac_nhan", labelKey: "hospitalConfirm", roleKey: "hospital" },
    { id: "hoan_tat", labelKey: "hospitalComplete", roleKey: "hospital" },
    { id: "done", labelKey: "complete" },
  ],
};

const XAC_MINH_CHI_PHI: WorkflowDiagram = {
  key: "junctura_xac_minh_chi_phi",
  steps: [
    { id: "bao_hiem_gui", labelKey: "insuranceSubmit", roleKey: "insurance" },
    { id: "benh_vien_xac_nhan", labelKey: "hospitalConfirm", roleKey: "hospital" },
    { id: "hoan_tat", labelKey: "hospitalComplete", roleKey: "hospital" },
    { id: "done", labelKey: "complete" },
  ],
};

const WORKFLOW_DIAGRAMS: Record<string, WorkflowDiagram> = {
  junctura_checkpoint: CHECKPOINT,
  scholarship_review: SCHOLARSHIP,
  junctura_chuyen_tuyen: CHUYEN_TUYEN,
  junctura_xac_minh_don_thuoc: XAC_MINH_DON_THUOC,
  junctura_xac_minh_chi_phi: XAC_MINH_CHI_PHI,
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
