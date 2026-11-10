// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import { Check, Eye, RotateCcw, X } from "lucide-react";
import type { TrustGraphEdge } from "../../../types";
import { useI18n } from "../../../locales/i18n";
import { Badge } from "../../common/Badge";
import { Button } from "../../common/Button";
import {
  SHARE_BADGE,
  SHARE_LABEL_KEY,
  appName,
  capabilityName,
  type ShareActors,
  type ShareState,
} from "./shareMeta";

export type ShareAction = "approve" | "reject" | "revoke";

export interface ShareRow {
  edge: TrustGraphEdge;
  state: ShareState;
  actors: ShareActors;
}

interface ShareTableProps {
  rows: ShareRow[];
  names: Map<string, string>;
  locale: string;
  canDecide: boolean;
  onView: (edge: TrustGraphEdge) => void;
  onDecision: (edge: TrustGraphEdge, action: ShareAction) => void;
}

export const ShareTable: React.FC<ShareTableProps> = ({
  rows,
  names,
  locale,
  canDecide,
  onView,
  onDecision,
}) => {
  const { t } = useI18n();
  const g = t.grants;

  const when = (value: string | null) =>
    value
      ? new Date(value).toLocaleString(locale, {
          dateStyle: "medium",
          timeStyle: "short",
        })
      : "—";

  const decisionCell = (row: ShareRow) => {
    if (row.state === "pending") return "—";
    const actor =
      row.state === "rejected"
        ? row.actors.decider
        : row.state === "revoked"
          ? row.actors.decider
          : row.actors.approver;
    const time =
      row.state === "rejected" || row.state === "revoked"
        ? row.actors.decidedAt
        : row.actors.approvedAt;
    const label =
      row.state === "rejected"
        ? g.rejectedBy
        : row.state === "revoked"
          ? g.revokedBy
          : g.approvedBy;
    return (
      <div className="space-y-0.5">
        <div className="text-stone-ink dark:text-slate-100">
          {label}: {actor ?? "—"}
        </div>
        <div className="text-xs text-slate-500 dark:text-slate-400">
          {when(time)}
        </div>
      </div>
    );
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[980px] text-left text-sm text-slate-600 dark:text-slate-300">
        <thead className="border-b border-slate-200/80 bg-slate-50 text-xs font-semibold uppercase text-slate-500 dark:border-[#243843] dark:bg-[#1B303B]/40 dark:text-slate-400">
          <tr>
            <th className="px-4 py-3">{g.colPair}</th>
            <th className="px-4 py-3">{g.colShared}</th>
            <th className="px-4 py-3">{g.colProposer}</th>
            <th className="px-4 py-3">{g.colDecision}</th>
            <th className="px-4 py-3">{g.colState}</th>
            <th className="px-4 py-3 text-right">{g.colActions}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-[#243843]/70">
          {rows.map(({ edge, state, actors }) => {
            const provider = appName(names, edge.providerAppId);
            const consumer = appName(names, edge.consumerAppId);
            const cap = capabilityName(edge);
            const reason =
              state === "rejected" || state === "revoked"
                ? actors.reason
                : null;
            return (
              <tr
                key={edge.grantId}
                data-testid={`share-row-${edge.grantId}`}
                className="align-top transition-colors hover:bg-slate-50 dark:hover:bg-[#1B303B]/40"
              >
                <td className="px-4 py-3 font-semibold text-stone-ink dark:text-slate-100">
                  {provider} → {consumer}
                </td>
                <td className="px-4 py-3">
                  <div className="font-medium text-stone-ink dark:text-slate-100">
                    {cap}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    {edge.version}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <div className="text-stone-ink dark:text-slate-100">
                    {provider}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    {when(edge.createdAt)}
                  </div>
                </td>
                <td className="px-4 py-3">
                  {decisionCell({ edge, state, actors })}
                  {reason && (
                    <p className="mt-1 max-w-[18rem] text-xs text-slate-500 dark:text-slate-400">
                      {g.colReason}: {reason}
                    </p>
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-3">
                  <Badge variant={SHARE_BADGE[state]}>
                    {g[SHARE_LABEL_KEY[state]]}
                  </Badge>
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap justify-end gap-1.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onView(edge)}
                      leftIcon={<Eye className="h-3.5 w-3.5" />}
                      aria-label={`${g.viewDetail}: ${cap}`}
                    >
                      {g.viewDetail}
                    </Button>
                    {canDecide && state === "pending" && (
                      <>
                        <Button
                          variant="teal"
                          size="sm"
                          onClick={() => onDecision(edge, "approve")}
                          leftIcon={<Check className="h-3.5 w-3.5" />}
                          aria-label={`${g.actionApprove}: ${cap}`}
                        >
                          {g.actionApprove}
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => onDecision(edge, "reject")}
                          leftIcon={<X className="h-3.5 w-3.5" />}
                          aria-label={`${g.actionReject}: ${cap}`}
                        >
                          {g.actionReject}
                        </Button>
                      </>
                    )}
                    {canDecide && state === "active" && (
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => onDecision(edge, "revoke")}
                        leftIcon={<RotateCcw className="h-3.5 w-3.5" />}
                        aria-label={`${g.actionRevoke}: ${cap}`}
                      >
                        {g.actionRevoke}
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
