// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import type { TrustGraphEdge } from "../../../types";
import { useI18n } from "../../../locales/i18n";
import { Badge } from "../../common/Badge";
import { DetailDrawer } from "../../common/DetailDrawer";
import {
  SHARE_BADGE,
  SHARE_LABEL_KEY,
  appName,
  capabilityName,
  shareStateOf,
  type ShareActors,
} from "./shareMeta";

interface GrantDetailDrawerProps {
  edge: TrustGraphEdge | null;
  actors: ShareActors | null;
  names: Map<string, string>;
  locale: string;
  onClose: () => void;
}

export const GrantDetailDrawer: React.FC<GrantDetailDrawerProps> = ({
  edge,
  actors,
  names,
  locale,
  onClose,
}) => {
  const { t } = useI18n();
  const g = t.grants;
  const c = t.capabilities;

  const date = (value: string | null) =>
    value ? new Date(value).toLocaleString(locale) : g.detailNever;
  const state = edge ? shareStateOf(edge) : "pending";

  return (
    <DetailDrawer
      isOpen={edge !== null}
      onClose={onClose}
      title={edge ? capabilityName(edge) : ""}
      width="lg"
    >
      {edge && (
        <div className="space-y-5 text-sm text-slate-600 dark:text-slate-300">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={SHARE_BADGE[state]}>
              {g[SHARE_LABEL_KEY[state]]}
            </Badge>
            {state === "active" &&
              Date.parse(edge.expiresAt) - Date.now() < 7 * 86_400_000 && (
                <Badge variant="warning">{c.expiringSoon}</Badge>
              )}
          </div>

          <dl className="space-y-2.5">
            <div className="flex items-start justify-between gap-3">
              <dt className="text-slate-500 dark:text-slate-400">
                {g.detailProvider}
              </dt>
              <dd className="text-right font-medium text-stone-ink dark:text-slate-200">
                {appName(names, edge.providerAppId)}
              </dd>
            </div>
            <div className="flex items-start justify-between gap-3">
              <dt className="text-slate-500 dark:text-slate-400">
                {g.detailConsumer}
              </dt>
              <dd className="text-right font-medium text-stone-ink dark:text-slate-200">
                {appName(names, edge.consumerAppId)}
              </dd>
            </div>
            <div className="flex items-start justify-between gap-3">
              <dt className="text-slate-500 dark:text-slate-400">
                {g.colProposer}
              </dt>
              <dd className="text-right">
                {appName(names, edge.providerAppId)}
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  {date(edge.createdAt)}
                </div>
              </dd>
            </div>
            <div className="flex items-start justify-between gap-3">
              <dt className="text-slate-500 dark:text-slate-400">
                {g.colDecision}
              </dt>
              <dd className="text-right">
                {actors?.approver ?? actors?.decider ?? "—"}
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  {date(actors?.approvedAt ?? actors?.decidedAt ?? null)}
                </div>
              </dd>
            </div>
            {actors?.reason && (
              <div className="flex items-start justify-between gap-3">
                <dt className="text-slate-500 dark:text-slate-400">
                  {g.colReason}
                </dt>
                <dd className="max-w-[60%] text-right">{actors.reason}</dd>
              </div>
            )}
            <div className="flex items-start justify-between gap-3">
              <dt className="text-slate-500 dark:text-slate-400">
                {g.detailOperations}
              </dt>
              <dd className="text-right">
                {edge.operations
                  .map((operation) => c[`op_${operation}` as const])
                  .join(", ")}
              </dd>
            </div>
            <div className="flex items-start justify-between gap-3">
              <dt className="text-slate-500 dark:text-slate-400">
                {g.detailExpires}
              </dt>
              <dd className="text-right">{date(edge.expiresAt)}</dd>
            </div>
            <div className="flex items-start justify-between gap-3">
              <dt className="text-slate-500 dark:text-slate-400">
                {g.detailActivated}
              </dt>
              <dd className="text-right">{date(edge.activatedAt)}</dd>
            </div>
            <div className="flex items-start justify-between gap-3">
              <dt className="text-slate-500 dark:text-slate-400">
                {g.detailRevoked}
              </dt>
              <dd className="text-right">{date(edge.revokedAt)}</dd>
            </div>
          </dl>
        </div>
      )}
    </DetailDrawer>
  );
};
