// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import { AlertTriangle, ShieldCheck, XCircle } from "lucide-react";
import { useI18n } from "../../../locales/i18n";
import type { PendingApprovalItem } from "../../../services/pendingApprovals";
import { Badge } from "../../common/Badge";
import { Button } from "../../common/Button";
import { DetailDrawer } from "../../common/DetailDrawer";
import {
  afterOf,
  beforeOf,
  expiresOf,
  kindLabel,
  purposeOf,
  requestedAtOf,
  requesterOf,
  titleOf,
} from "./item";

interface QueueItemDetailProps {
  item: PendingApprovalItem | null;
  self: boolean;
  canApprove: boolean;
  onClose: () => void;
  onApprove: () => void;
  onReject: () => void;
}

export const QueueItemDetail: React.FC<QueueItemDetailProps> = ({
  item,
  self,
  canApprove,
  onClose,
  onApprove,
  onReject,
}) => {
  const { t, language } = useI18n();
  const q = t.queue;
  const numberLocale = language === "vi" ? "vi-VN" : "en-US";

  return (
    <DetailDrawer
      isOpen={item !== null}
      onClose={onClose}
      title={item ? titleOf(item) : ""}
      width="lg"
    >
      {item && (
        <div className="space-y-5 text-sm text-slate-600 dark:text-slate-300">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={item.kind === "application" ? "warning" : "junctura"}>
              {kindLabel(item, q)}
            </Badge>
          </div>

          <div className="rounded-md border border-slate-200/80 bg-slate-50 p-4 dark:border-[#243843] dark:bg-[#1B303B]/40">
            <p className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              {q.purpose}
            </p>
            <p className="mt-1 leading-relaxed text-stone-ink dark:text-slate-200">
              {purposeOf(item, q)}
            </p>
          </div>

          <dl className="space-y-2.5">
            <div className="flex items-start justify-between gap-3">
              <dt className="text-slate-500 dark:text-slate-400">
                {q.proposer}
              </dt>
              <dd className="text-right font-medium text-stone-ink dark:text-slate-200">
                {requesterOf(item)}
                {self ? ` (${q.selfLabel})` : ""}
              </dd>
            </div>
            <div className="flex items-start justify-between gap-3">
              <dt className="text-slate-500 dark:text-slate-400">
                {q.requestedAt}
              </dt>
              <dd className="text-right text-stone-ink dark:text-slate-200">
                {requestedAtOf(item, numberLocale)}
              </dd>
            </div>
            <div className="flex items-start justify-between gap-3">
              <dt className="text-slate-500 dark:text-slate-400">
                {q.expiresAt}
              </dt>
              <dd className="text-right text-stone-ink dark:text-slate-200">
                {expiresOf(item, q, numberLocale)}
              </dd>
            </div>
          </dl>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="rounded-md border border-slate-200/80 p-3 dark:border-[#243843]">
              <p className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                {q.before}
              </p>
              <p className="mt-1 leading-relaxed">{beforeOf(item, q)}</p>
            </div>
            <div className="rounded-md border border-slate-200/80 p-3 dark:border-[#243843]">
              <p className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                {q.after}
              </p>
              <p className="mt-1 leading-relaxed">{afterOf(item, q)}</p>
            </div>
          </div>

          {self && (
            <div className="flex items-start gap-2.5 rounded-md border border-rose-200 bg-rose-50 p-3 text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-200">
              <AlertTriangle
                className="mt-0.5 h-4 w-4 flex-shrink-0"
                aria-hidden="true"
              />
              <div>
                <p className="font-semibold">{q.selfBlockTitle}</p>
                <p className="mt-0.5 leading-relaxed">{q.selfBlockDesc}</p>
              </div>
            </div>
          )}

          {!self && !canApprove && (
            <div className="flex items-start gap-2.5 rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
              <AlertTriangle
                className="mt-0.5 h-4 w-4 flex-shrink-0"
                aria-hidden="true"
              />
              <div>
                <p className="font-semibold">{q.noPermissionTitle}</p>
                <p className="mt-0.5 leading-relaxed">{q.noPermissionDesc}</p>
              </div>
            </div>
          )}

          {canApprove && (
            <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-4 dark:border-[#243843]/70">
              <Button
                variant="teal"
                size="sm"
                disabled={self}
                onClick={onApprove}
                leftIcon={<ShieldCheck className="h-3.5 w-3.5" />}
              >
                {q.approve}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={self}
                onClick={onReject}
                leftIcon={<XCircle className="h-3.5 w-3.5" />}
              >
                {q.reject}
              </Button>
            </div>
          )}
        </div>
      )}
    </DetailDrawer>
  );
};
