// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Clock,
  GitBranch,
  RefreshCw,
  ServerCrash,
} from "lucide-react";
import type { RecentRequest, ScreenId } from "../../../types";
import { api } from "../../../services/apiClient";
import { useSession } from "../../../services/session";
import { useI18n } from "../../../locales/i18n";
import { PageHeader } from "../../layout/PageHeader";
import { StatCard } from "../../common/StatCard";
import { Card, CardContent, CardHeader, CardTitle } from "../../common/Card";
import { Badge, type BadgeVariant } from "../../common/Badge";
import { Button } from "../../common/Button";
import { ErrorState } from "../../common/ErrorState";
import { EmptyState } from "../../common/EmptyState";
import { LoadingSkeleton } from "../../common/LoadingSkeleton";
import { TrafficChart } from "./TrafficChart";
import { formatClock, statusClass } from "./metrics";
import { useRecentRequests, useTrafficSeries } from "./useMetrics";

interface OverviewScreenProps {
  onNavigate: (screen: ScreenId) => void;
}

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

function requestTime(request: RecentRequest, locale: string): string {
  return formatClock(request.at, locale);
}

export const OverviewScreen: React.FC<OverviewScreenProps> = ({ onNavigate }) => {
  const { t, language } = useI18n();
  const d = t.dashboard;
  const { can } = useSession();
  const canReadCases = can("audit.read");
  const locale = language === "vi" ? "vi-VN" : "en-GB";
  const numberLocale = language === "vi" ? "vi-VN" : "en-US";

  const traffic = useTrafficSeries(60, 30_000);
  const recent = useRecentRequests(6, 30_000);
  const [runningCases, setRunningCases] = useState<number | null>(null);
  const [casesError, setCasesError] = useState(false);

  const loadRunningCases = useCallback(async () => {
    if (!canReadCases) return;
    try {
      const items = await api.getWorkflowExecutions({
        status: "running",
        limit: 100,
      });
      setRunningCases(items.length);
      setCasesError(false);
    } catch {
      setRunningCases(null);
      setCasesError(true);
    }
  }, [canReadCases]);

  useEffect(() => {
    void loadRunningCases();
  }, [loadRunningCases]);

  const totals = traffic.series?.totals;
  const buckets = traffic.series?.buckets ?? [];
  const loading = traffic.loading || recent.loading;
  const hasError = traffic.error || recent.error;
  const empty = !loading && !hasError && (totals?.requests ?? 0) === 0;

  const refresh = () => {
    traffic.refresh();
    recent.refresh();
    void loadRunningCases();
  };

  const number = (value: number) =>
    new Intl.NumberFormat(numberLocale).format(value);

  return (
    <div className="space-y-6">
      <PageHeader
        title={d.title}
        subtitle={d.subtitle}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            isLoading={loading}
            leftIcon={<RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
          >
            {d.refreshData}
          </Button>
        }
      />

      {traffic.error ? (
        <ErrorState
          title={d.loadError}
          message={d.loadErrorHint}
          onRetry={refresh}
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              title={d.metricTotalRequests}
              value={loading && !totals ? "—" : number(totals?.requests ?? 0)}
              subtitle={d.metricTotalRequestsHint}
              icon={<Activity className="h-4 w-4" aria-hidden="true" />}
            />
            <StatCard
              title={d.metricErrors}
              value={
                loading && !totals
                  ? "—"
                  : number(
                      (totals?.errors4xx ?? 0) + (totals?.errors5xx ?? 0)
                    )
              }
              subtitle={d.metricErrorsHint
                .replace("{client}", number(totals?.errors4xx ?? 0))
                .replace("{server}", number(totals?.errors5xx ?? 0))}
              icon={<AlertTriangle className="h-4 w-4" aria-hidden="true" />}
            />
            <StatCard
              title={d.metricAvgLatency}
              value={
                loading && !totals
                  ? "—"
                  : `${number(totals?.avgLatencyMs ?? 0)} ms`
              }
              subtitle={d.metricAvgLatencyHint}
              icon={<Clock className="h-4 w-4" aria-hidden="true" />}
            />
            <StatCard
              title={d.metricMaxLatency}
              value={
                loading && !totals
                  ? "—"
                  : `${number(totals?.maxLatencyMs ?? 0)} ms`
              }
              subtitle={d.metricMaxLatencyHint}
              icon={<ServerCrash className="h-4 w-4" aria-hidden="true" />}
            />
          </div>

          {canReadCases && (
            <Card>
              <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                  <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-md bg-[var(--accent-soft)] text-[var(--accent)]">
                    <GitBranch className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <p className="font-semibold text-[var(--text)]">
                      {d.pendingCasesTitle}
                    </p>
                    <p className="mt-0.5 text-sm text-[var(--muted)]">
                      {casesError
                        ? d.pendingCasesError
                        : runningCases === null
                          ? d.pendingCasesLoading
                          : d.pendingCasesDesc.replace(
                              "{n}",
                              number(runningCases)
                            )}
                    </p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onNavigate("workflows")}
                  rightIcon={
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  }
                >
                  {d.viewPendingCases}
                </Button>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <div className="min-w-0">
                <CardTitle>{d.chartTitle}</CardTitle>
                <p className="mt-1 text-sm text-[var(--muted)]">
                  {d.chartDesc}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onNavigate("traffic")}
                rightIcon={<ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />}
              >
                {d.viewMore}
              </Button>
            </CardHeader>
            <CardContent>
              {loading && buckets.length === 0 ? (
                <LoadingSkeleton rows={4} />
              ) : empty ? (
                <EmptyState
                  title={d.noRequestsTitle}
                  description={d.noRequestsDesc}
                  icon={<Activity className="h-6 w-6" aria-hidden="true" />}
                />
              ) : (
                <TrafficChart buckets={buckets} />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="min-w-0">
                <CardTitle>{d.recentTitle}</CardTitle>
                <p className="mt-1 text-sm text-[var(--muted)]">
                  {d.recentDesc}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onNavigate("requests")}
                rightIcon={<ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />}
              >
                {d.viewAllRequests}
              </Button>
            </CardHeader>
            <CardContent>
              {recent.error ? (
                <ErrorState message={d.recentError} onRetry={recent.refresh} />
              ) : recent.loading && recent.items.length === 0 ? (
                <LoadingSkeleton rows={3} />
              ) : recent.items.length === 0 ? (
                <EmptyState
                  title={d.noRequestsTitle}
                  description={d.noRequestsDesc}
                  icon={<Activity className="h-6 w-6" aria-hidden="true" />}
                />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <caption className="sr-only">{d.recentTitle}</caption>
                    <thead>
                      <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--muted)]">
                        <th className="px-2 py-2 font-semibold">{d.colTime}</th>
                        <th className="px-2 py-2 font-semibold">
                          {d.colMethod}
                        </th>
                        <th className="px-2 py-2 font-semibold">{d.colPath}</th>
                        <th className="px-2 py-2 font-semibold">{d.colStatus}</th>
                        <th className="px-2 py-2 text-right font-semibold">
                          {d.colDuration}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {recent.items.slice(0, 6).map((request, index) => (
                        <tr
                          key={`${request.at}-${request.path}-${index}`}
                          className="border-b border-[var(--border)]/60 last:border-0"
                        >
                          <td className="whitespace-nowrap px-2 py-2 font-mono text-xs text-[var(--muted)]">
                            {requestTime(request, locale)}
                          </td>
                          <td className="px-2 py-2">
                            <Badge
                              variant={
                                METHOD_VARIANTS[request.method] ?? "outline"
                              }
                            >
                              {request.method}
                            </Badge>
                          </td>
                          <td className="max-w-[20rem] truncate px-2 py-2 font-mono text-xs text-[var(--text)]">
                            {request.path}
                          </td>
                          <td className="px-2 py-2">
                            <Badge
                              variant={
                                STATUS_VARIANTS[statusClass(request.status)]
                              }
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
        </>
      )}
    </div>
  );
};
