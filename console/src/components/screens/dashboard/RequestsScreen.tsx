// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useMemo, useState } from "react";
import { Activity, RefreshCw } from "lucide-react";
import { useI18n } from "../../../locales/i18n";
import { PageHeader } from "../../layout/PageHeader";
import { Badge, type BadgeVariant } from "../../common/Badge";
import { Button } from "../../common/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../../common/Card";
import { EmptyState } from "../../common/EmptyState";
import { ErrorState } from "../../common/ErrorState";
import { LoadingSkeleton } from "../../common/LoadingSkeleton";
import { formatDateTime, statusClass } from "./metrics";
import { useRecentRequests } from "./useMetrics";

type StatusFilter = "all" | "success" | "client" | "server";

const METHOD_VARIANTS: Record<string, BadgeVariant> = {
  GET: "method-get",
  POST: "method-post",
  PUT: "method-put",
  PATCH: "method-patch",
  DELETE: "method-delete",
};

const STATUS_VARIANTS: Record<"success" | "client" | "server", BadgeVariant> = {
  success: "success",
  client: "warning",
  server: "destructive",
};

const SELECT_CLASS =
  "rounded-md border border-[var(--border)] bg-[var(--card)] px-2.5 py-1.5 text-sm text-[var(--text)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]";

export const RequestsScreen: React.FC = () => {
  const { t, language } = useI18n();
  const d = t.dashboard;
  const locale = language === "vi" ? "vi-VN" : "en-GB";
  const numberLocale = language === "vi" ? "vi-VN" : "en-US";
  const { items, loading, error, refresh } = useRecentRequests(100, 30_000);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [method, setMethod] = useState("all");

  const methods = useMemo(
    () => Array.from(new Set(items.map((item) => item.method))).sort(),
    [items]
  );

  const filtered = useMemo(
    () =>
      items.filter((item) => {
        if (status !== "all" && statusClass(item.status) !== status) {
          return false;
        }
        return method === "all" || item.method === method;
      }),
    [items, status, method]
  );

  const number = (value: number) =>
    new Intl.NumberFormat(numberLocale).format(value);

  return (
    <div className="space-y-6">
      <PageHeader
        title={d.logsTitle}
        subtitle={d.logsSubtitle}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            isLoading={loading}
            leftIcon={<RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
          >
            {t.common.refresh}
          </Button>
        }
      />

      {error ? (
        <ErrorState
          title={d.loadError}
          message={d.recentError}
          onRetry={refresh}
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>{d.logsTitle}</CardTitle>
            <span className="text-sm text-[var(--muted)]">
              {d.logsCount.replace("{n}", number(filtered.length))}
            </span>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label
                  htmlFor="request-status-filter"
                  className="mb-1 block text-xs font-semibold text-[var(--muted)]"
                >
                  {d.logsFilterStatus}
                </label>
                <select
                  id="request-status-filter"
                  value={status}
                  onChange={(event) =>
                    setStatus(event.target.value as StatusFilter)
                  }
                  className={SELECT_CLASS}
                >
                  <option value="all">{d.logsAllStatuses}</option>
                  <option value="success">{d.logsSuccess}</option>
                  <option value="client">{d.logsClient}</option>
                  <option value="server">{d.logsServer}</option>
                </select>
              </div>
              <div>
                <label
                  htmlFor="request-method-filter"
                  className="mb-1 block text-xs font-semibold text-[var(--muted)]"
                >
                  {d.logsFilterMethod}
                </label>
                <select
                  id="request-method-filter"
                  value={method}
                  onChange={(event) => setMethod(event.target.value)}
                  className={SELECT_CLASS}
                >
                  <option value="all">{d.logsAllMethods}</option>
                  {methods.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {loading && items.length === 0 ? (
              <LoadingSkeleton rows={6} />
            ) : items.length === 0 ? (
              <EmptyState
                title={d.noRequestsTitle}
                description={d.noRequestsDesc}
                icon={<Activity className="h-6 w-6" aria-hidden="true" />}
              />
            ) : filtered.length === 0 ? (
              <EmptyState
                title={d.logsNoMatchesTitle}
                description={d.logsNoMatchesDesc}
                icon={<Activity className="h-6 w-6" aria-hidden="true" />}
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <caption className="sr-only">{d.logsTitle}</caption>
                  <thead>
                    <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--muted)]">
                      <th className="px-2 py-2 font-semibold">{d.colTime}</th>
                      <th className="px-2 py-2 font-semibold">{d.colMethod}</th>
                      <th className="px-2 py-2 font-semibold">{d.colPath}</th>
                      <th className="px-2 py-2 font-semibold">{d.colStatus}</th>
                      <th className="px-2 py-2 text-right font-semibold">
                        {d.colDuration}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((request, index) => (
                      <tr
                        key={`${request.at}-${request.path}-${index}`}
                        className="border-b border-[var(--border)]/60 last:border-0"
                      >
                        <td className="whitespace-nowrap px-2 py-2 font-mono text-xs text-[var(--muted)]">
                          {formatDateTime(request.at, locale)}
                        </td>
                        <td className="px-2 py-2">
                          <Badge
                            variant={METHOD_VARIANTS[request.method] ?? "outline"}
                          >
                            {request.method}
                          </Badge>
                        </td>
                        <td className="max-w-[28rem] truncate px-2 py-2 font-mono text-xs text-[var(--text)]">
                          {request.path}
                        </td>
                        <td className="px-2 py-2">
                          <Badge
                            variant={STATUS_VARIANTS[statusClass(request.status)]}
                          >
                            {request.status}
                          </Badge>
                        </td>
                        <td className="whitespace-nowrap px-2 py-2 text-right text-[var(--muted)]">
                          {Math.round(request.durationMs)} ms
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
};
