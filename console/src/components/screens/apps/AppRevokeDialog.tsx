// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import { useI18n } from "../../../locales/i18n";
import { ConfirmationDialog } from "../../common/ConfirmationDialog";

interface AppRevokeDialogProps {
  isOpen: boolean;
  appName: string;
  reason: string;
  error: string | null;
  isSubmitting: boolean;
  onReasonChange: (reason: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export const AppRevokeDialog: React.FC<AppRevokeDialogProps> = ({
  isOpen,
  appName,
  reason,
  error,
  isSubmitting,
  onReasonChange,
  onConfirm,
  onCancel,
}) => {
  const { t } = useI18n();
  const a = t.applications;

  return (
    <ConfirmationDialog
      isOpen={isOpen}
      onCancel={onCancel}
      onConfirm={onConfirm}
      title={a.actionRevoke}
      description={a.stateDialogDesc
        .replace("{name}", appName)
        .replace("{action}", a.actionRevoke)}
      confirmLabel={a.stateSubmit}
      isLoading={isSubmitting}
      confirmDisabled={!reason.trim()}
      variant="danger"
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
        <div className="p-3 bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900/50 rounded text-sm text-rose-700 dark:text-rose-300">
          {t.common.terminalStateNotice}
        </div>
        <div>
          <label
            htmlFor="app-state-reason"
            className="block text-sm font-semibold text-stone-ink dark:text-slate-200 mb-1"
          >
            {a.actionReason}
          </label>
          <textarea
            id="app-state-reason"
            rows={3}
            value={reason}
            onChange={(event) => onReasonChange(event.target.value)}
            placeholder={a.actionReasonPlaceholder}
            className="w-full px-3 py-1.5 text-sm rounded border border-slate-200 dark:border-[#243843] bg-white dark:bg-[#13242D] text-stone-ink dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-junctura-blue"
          />
          {!reason.trim() && (
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              {a.stateReasonRequired}
            </p>
          )}
        </div>
      </div>
    </ConfirmationDialog>
  );
};
