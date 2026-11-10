// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import { useI18n } from "../../../locales/i18n";
import type { PendingApprovalItem } from "../../../services/pendingApprovals";
import { ConfirmationDialog } from "../../common/ConfirmationDialog";
import { purposeOf, titleOf, type Decision } from "./item";

interface QueueDecisionDialogProps {
  item: PendingApprovalItem | null;
  decision: Decision | null;
  reason: string;
  onReasonChange: (value: string) => void;
  actionError: string | null;
  isSubmitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export const QueueDecisionDialog: React.FC<QueueDecisionDialogProps> = ({
  item,
  decision,
  reason,
  onReasonChange,
  actionError,
  isSubmitting,
  onCancel,
  onConfirm,
}) => {
  const { t } = useI18n();
  const q = t.queue;

  return (
    <ConfirmationDialog
      isOpen={decision !== null}
      title={decision === "reject" ? q.rejectTitle : q.approveTitle}
      description={decision === "reject" ? q.rejectDesc : q.approveDesc}
      confirmLabel={decision === "reject" ? q.reject : q.approve}
      cancelLabel={t.common.cancel}
      variant={decision === "reject" ? "danger" : "warning"}
      isLoading={isSubmitting}
      confirmDisabled={decision === "reject" && !reason.trim()}
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      {item && (
        <div className="space-y-3">
          <p className="text-sm font-semibold text-stone-ink dark:text-slate-100">
            {titleOf(item)}
          </p>
          <p className="text-sm leading-relaxed text-slate-500 dark:text-slate-400">
            {purposeOf(item, q)}
          </p>
          {decision === "reject" && (
            <div>
              <label
                htmlFor="queue-reject-reason"
                className="mb-1 block text-sm font-semibold text-stone-ink dark:text-slate-200"
              >
                {q.reasonLabel}
              </label>
              <textarea
                id="queue-reject-reason"
                rows={3}
                value={reason}
                onChange={(event) => onReasonChange(event.target.value)}
                placeholder={q.reasonPlaceholder}
                className="w-full rounded border border-slate-200 bg-white px-3 py-1.5 text-sm text-stone-ink focus:outline-none focus:ring-1 focus:ring-junctura-blue dark:border-[#243843] dark:bg-[#13242D] dark:text-slate-100"
              />
            </div>
          )}
          {actionError && (
            <div className="space-y-2">
              <p
                role="alert"
                className="rounded border border-rose-200 bg-rose-50 px-2.5 py-2 text-sm text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-300"
              >
                {actionError}
              </p>
            </div>
          )}
        </div>
      )}
    </ConfirmationDialog>
  );
};
