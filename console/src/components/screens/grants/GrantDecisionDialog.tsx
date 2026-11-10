// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import type { TrustGraphEdge } from "../../../types";
import { useI18n } from "../../../locales/i18n";
import { ConfirmationDialog } from "../../common/ConfirmationDialog";
import { appName, capabilityName } from "./shareMeta";
import type { ShareAction } from "./ShareTable";

interface GrantDecisionDialogProps {
  edge: TrustGraphEdge | null;
  action: ShareAction | null;
  names: Map<string, string>;
  reason: string;
  onReasonChange: (value: string) => void;
  error: string | null;
  isSubmitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export const GrantDecisionDialog: React.FC<GrantDecisionDialogProps> = ({
  edge,
  action,
  names,
  reason,
  onReasonChange,
  error,
  isSubmitting,
  onCancel,
  onConfirm,
}) => {
  const { t } = useI18n();
  const g = t.grants;
  const approve = action === "approve";
  const requiresReason = action === "reject" || action === "revoke";

  const title =
    action === "reject"
      ? g.rejectTitle
      : action === "revoke"
        ? g.revokeTitle
        : g.approveTitle;
  const description =
    action === "reject"
      ? g.rejectDesc
      : action === "revoke"
        ? g.revokeDesc
        : g.approveDesc;

  return (
    <ConfirmationDialog
      isOpen={edge !== null && action !== null}
      title={title}
      description={description}
      confirmLabel={
        action === "reject"
          ? g.actionReject
          : action === "revoke"
            ? g.actionRevoke
            : g.actionApprove
      }
      cancelLabel={t.common.cancel}
      variant={approve ? "warning" : "danger"}
      isLoading={isSubmitting}
      confirmDisabled={requiresReason && !reason.trim()}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {edge && (
        <div className="space-y-2 text-sm text-slate-600 dark:text-slate-300">
          <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 dark:border-[#243843] dark:bg-[#0D1A22]">
            <span className="font-semibold text-stone-ink dark:text-slate-100">
              {appName(names, edge.providerAppId)}
            </span>{" "}
            →{" "}
            <span className="font-semibold text-stone-ink dark:text-slate-100">
              {appName(names, edge.consumerAppId)}
            </span>{" "}
            · {capabilityName(edge)}
          </p>
          {requiresReason && (
            <>
              <label
                htmlFor="grant-decision-reason"
                className="block font-medium text-stone-ink dark:text-slate-100"
              >
                {g.reasonLabel}
              </label>
              <textarea
                id="grant-decision-reason"
                value={reason}
                maxLength={512}
                onChange={(event) => onReasonChange(event.target.value)}
                placeholder={g.reasonPlaceholder}
                className="min-h-20 w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-stone-ink focus:outline-none focus:ring-1 focus:ring-junctura-blue dark:border-[#243843] dark:bg-[#0D1A22] dark:text-slate-100"
              />
              {!reason.trim() && (
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  {g.reasonRequired}
                </p>
              )}
            </>
          )}
          {error && (
            <p role="alert" className="text-red-700 dark:text-red-300">
              {error}
            </p>
          )}
        </div>
      )}
    </ConfirmationDialog>
  );
};
