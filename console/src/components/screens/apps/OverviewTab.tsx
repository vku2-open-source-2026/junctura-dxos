// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import { Info, ShieldCheck, XCircle } from "lucide-react";
import type { Application, Language } from "../../../types";
import { useI18n } from "../../../locales/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "../../common/Card";
import { Badge } from "../../common/Badge";
import { Button } from "../../common/Button";
import { AppStateBadge } from "./AppStateBadge";
import { formatDateTime } from "./format";
import type { AppDetailModel } from "./appDetailModel";
import type { AppRelatedData } from "./useAppRelated";
import {
  SHARE_BADGE,
  SHARE_LABEL_KEY,
  appName,
} from "../grants/shareMeta";

interface OverviewTabProps {
  application: Application;
  model: AppDetailModel;
  related: AppRelatedData;
  names: Map<string, string>;
  language: Language;
  onApprove: () => void;
  onReject: () => void;
}

export const OverviewTab: React.FC<OverviewTabProps> = ({
  application,
  model,
  related,
  names,
  language,
  onApprove,
  onReject,
}) => {
  const { t } = useI18n();
  const a = t.applications;
  const g = t.grants;

  const rows: Array<{ label: string; value: React.ReactNode }> = [
    { label: a.detailOwnerUnit, value: model.ownerUnit ?? "—" },
    { label: a.detailRegistrant, value: model.registrant },
    {
      label: a.columnState,
      value: <AppStateBadge state={application.state} />,
    },
    {
      label: a.detailRegisteredAt,
      value: formatDateTime(application.createdAt, language),
    },
    {
      label: a.detailApprovedAt,
      value: model.approvedAt
        ? formatDateTime(model.approvedAt, language)
        : a.detailNotApproved,
    },
    {
      label: a.detailApprover,
      value: model.approver ?? "—",
    },
    {
      label: a.detailCollections,
      value: related.loading
        ? t.common.loading
        : related.storageError
          ? a.detailStorageUnavailable
          : model.collections,
    },
    {
      label: a.detailFiles,
      value: related.loading
        ? t.common.loading
        : related.storageError || model.files === null
          ? a.detailStorageUnavailable
          : model.files,
    },
  ];

  const capabilityList = (title: string, items: string[]) => (
    <div>
      <h4 className="text-sm font-semibold text-stone-ink dark:text-slate-100">
        {title}
      </h4>
      {related.loading ? (
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {t.common.loading}
        </p>
      ) : items.length === 0 ? (
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {a.detailNoCapabilities}
        </p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {items.map((item) => (
            <li
              key={item}
              className="rounded-md border border-slate-200/80 px-3 py-2 text-sm text-slate-700 dark:border-[#243843] dark:text-slate-200"
            >
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <div className="space-y-6">
      {application.state === "pending" && (
        <Card className="border-amber-200 dark:border-amber-900/60">
          <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-sm font-semibold text-stone-ink dark:text-slate-100">
                {a.pendingTitle}
              </h3>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                {a.pendingDesc}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="teal"
                size="sm"
                onClick={onApprove}
                leftIcon={<ShieldCheck className="w-3.5 h-3.5" />}
              >
                {a.approveBtn}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={onReject}
                leftIcon={<XCircle className="w-3.5 h-3.5" />}
              >
                {a.rejectBtn}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{a.overviewIdentityTitle}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="divide-y divide-slate-100 dark:divide-[#243843]/70">
            {rows.map((row) => (
              <div
                key={row.label}
                className="flex flex-col gap-1 py-2.5 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
              >
                <dt className="text-sm text-slate-500 dark:text-slate-400">
                  {row.label}
                </dt>
                <dd className="text-sm text-stone-ink dark:text-slate-200 sm:max-w-[70%] sm:text-right">
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{a.detailCapabilitiesTitle}</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {capabilityList(a.detailCapabilitiesProvided, model.providerCapabilities)}
          {capabilityList(a.detailCapabilitiesUsed, model.consumerCapabilities)}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>{a.detailSharesTitle}</CardTitle>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              {a.detailSharesDesc}
            </p>
          </div>
        </CardHeader>
        <CardContent>
          {model.shares.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {a.detailNoShares}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-sm text-slate-600 dark:text-slate-300">
                <thead className="border-b border-slate-200/80 text-xs font-semibold uppercase text-slate-500 dark:border-[#243843] dark:text-slate-400">
                  <tr>
                    <th className="px-3 py-2">{g.colPair}</th>
                    <th className="px-3 py-2">{g.colShared}</th>
                    <th className="px-3 py-2">{g.colProposer}</th>
                    <th className="px-3 py-2">{g.colState}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-[#243843]/70">
                  {model.shares.map(({ edge, state }) => {
                    const provider =
                      edge.providerAppId === application.appId
                        ? application.displayName
                        : appName(names, edge.providerAppId);
                    const consumer =
                      edge.consumerAppId === application.appId
                        ? application.displayName
                        : appName(names, edge.consumerAppId);
                    return (
                      <tr key={edge.grantId}>
                        <td className="px-3 py-2 font-medium text-stone-ink dark:text-slate-100">
                          {provider} → {consumer}
                        </td>
                        <td className="px-3 py-2">
                          {edge.title ?? edge.capabilityId}
                        </td>
                        <td className="px-3 py-2">
                          {formatDateTime(edge.createdAt, language)}
                        </td>
                        <td className="px-3 py-2">
                          <Badge variant={SHARE_BADGE[state]}>
                            {g[SHARE_LABEL_KEY[state]]}
                          </Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex items-start gap-3 rounded-md border border-slate-200/80 bg-slate-50 p-4 text-sm text-slate-600 dark:border-[#243843] dark:bg-[#13242D] dark:text-slate-300">
        <Info className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
        <p>{a.detailCallsUnavailable}</p>
      </div>

      <details className="rounded-md border border-slate-200/80 bg-white p-4 dark:border-[#243843] dark:bg-[#13242D]">
        <summary className="cursor-pointer text-sm font-semibold text-stone-ink dark:text-slate-100">
          {a.technicalDetails}
        </summary>
        <dl className="mt-3 space-y-2 text-sm">
          {[
            { label: a.appIdLabel, value: application.appId },
            { label: a.oauthClientLabel, value: application.oauthClientId },
            { label: a.providerOriginLabel, value: application.providerOrigin },
            { label: a.tenantLabel, value: application.tenantId },
            { label: a.revisionLabel, value: String(application.revision) },
            { label: a.overviewDigestTitle, value: application.digest },
            {
              label: a.updatedLabel,
              value: formatDateTime(application.updatedAt, language),
            },
          ].map((row) => (
            <div key={row.label} className="flex flex-col gap-1 sm:flex-row">
              <dt className="text-slate-500 dark:text-slate-400">
                {row.label}
              </dt>
              <dd className="break-all font-mono text-xs text-stone-ink dark:text-slate-200 sm:ml-auto sm:text-right">
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
};
