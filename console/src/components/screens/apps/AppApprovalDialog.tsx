// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import type { Application } from "../../../types";
import { useI18n } from "../../../locales/i18n";
import { ConfirmationDialog } from "../../common/ConfirmationDialog";

export type AppDecision = "approve" | "deny";

interface AppApprovalDialogProps {
  isOpen: boolean;
  application: Application | null;
  decision: AppDecision;
  reason: string;
  error: string | null;
  isSubmitting: boolean;
  onDecisionChange: (decision: AppDecision) => void;
  onReasonChange: (reason: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

export const AppApprovalDialog: React.FC<AppApprovalDialogProps> = ({
  isOpen,
  application,
  decision,
  reason,
  error,
  isSubmitting,
  onDecisionChange,
  onReasonChange,
  onCancel,
  onConfirm,
}) => {
  const { t } = useI18n();
  const a = t.applications;
  const deny = decision === "deny";

  return (
    <ConfirmationDialog
      isOpen={isOpen}
      onCancel={onCancel}
      onConfirm={onConfirm}
      title={deny ? a.rejectBtn : a.createApprovalTitle}
      description={deny ? a.rejectReasonPlaceholder : a.pendingDesc}
      confirmLabel={deny ? a.rejectBtn : a.submitApprovalBtn}
      isLoading={isSubmitting}
      confirmDisabled={deny && !reason.trim()}
      variant={deny ? "danger" : "warning"}
    >
      <div className="space-y-4 my-2 text-left">
        {error && (
          <div
            role="alert"
            className="p-2.5 rounded bg-rose-50 text-rose-700 text-sm border border-rose-200 dark:bg-rose-950/30 dark:text-rose-300 dark:border-rose-900/50"
          >
            {error}
          </div>
        )}
        <div className="p-3 bg-slate-50 dark:bg-[#1B303B]/50 rounded border border-slate-200/80 dark:border-[#243843] text-sm space-y-1">
          <span className="text-slate-500">{a.columnApp}</span>
          <div className="text-sm font-medium text-stone-ink dark:text-slate-200">
            {application?.displayName ?? "—"}
          </div>
        </div>
        <fieldset>
          <legend className="block text-sm font-semibold text-stone-ink dark:text-slate-200 mb-1">
            {a.createApprovalTitle}
          </legend>
          <div className="flex gap-4">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="radio"
                name="approval-decision"
                checked={decision === "approve"}
                onChange={() => onDecisionChange("approve")}
              />
              <span className="text-emerald-700 dark:text-emerald-400 font-medium">
                {a.decisionApprove}
              </span>
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="radio"
                name="approval-decision"
                checked={decision === "deny"}
                onChange={() => onDecisionChange("deny")}
              />
              <span className="text-rose-700 dark:text-rose-400 font-medium">
                {a.decisionDeny}
              </span>
            </label>
          </div>
        </fieldset>
        {deny && (
          <div>
            <label
              htmlFor="app-reject-reason"
              className="mb-1 block text-sm font-semibold text-stone-ink dark:text-slate-200"
            >
              {a.rejectReasonLabel}
            </label>
            <textarea
              id="app-reject-reason"
              rows={3}
              value={reason}
              maxLength={512}
              onChange={(event) => onReasonChange(event.target.value)}
              placeholder={a.rejectReasonPlaceholder}
              className="w-full rounded border border-slate-200 bg-white px-3 py-1.5 text-sm text-stone-ink focus:outline-none focus:ring-1 focus:ring-junctura-blue dark:border-[#243843] dark:bg-[#13242D] dark:text-slate-100"
            />
            {!reason.trim() && (
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                {a.rejectReasonRequired}
              </p>
            )}
          </div>
        )}
      </div>
    </ConfirmationDialog>
  );
};
