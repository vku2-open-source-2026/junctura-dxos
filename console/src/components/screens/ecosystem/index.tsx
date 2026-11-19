// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useCallback, useEffect, useState } from "react";
import {
  Activity,
  Boxes,
  Link2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import type { ApplicationStats } from "../../../types";
import { ApiError, api } from "../../../services/apiClient";
import { useI18n } from "../../../locales/i18n";
import { useSession } from "../../../services/session";
import { PageHeader } from "../../layout/PageHeader";
import { Button } from "../../common/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../../common/Card";
import { EmptyState } from "../../common/EmptyState";
import { ErrorState } from "../../common/ErrorState";
import { ForbiddenNotice } from "../../common/ForbiddenNotice";
import { LoadingSkeleton } from "../../common/LoadingSkeleton";
import { PermissionDenied } from "../../common/PermissionDenied";
import { StatCard } from "../../common/StatCard";
import { AppStateBadge } from "../apps/AppStateBadge";
import { formatDateTime } from "../apps/format";
import { appDetailHash } from "../apps/route";
import { formatBytes } from "../files/fileMeta";

type StatsError = "permission" | "generic" | null;

export const EcosystemScreen: React.FC = () => {
  const { t, language } = useI18n();
  const e = t.ecosystem;
  const { can } = useSession();
  const allowed = can("audit.read");
  const [stats, setStats] = useState<ApplicationStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<StatsError>(null);

  const locale = language === "vi" ? "vi-VN" : "en-US";
  const number = (value: number) =>
    new Intl.NumberFormat(locale).format(value);

  const load = useCallback(async () => {
    if (!allowed) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setStats(await api.getApplicationStats());
    } catch (failure) {
      setStats(null);
      setError(
        failure instanceof ApiError && failure.status === 403
          ? "permission"
          : "generic"
      );
    } finally {
      setLoading(false);
    }
  }, [allowed]);

  useEffect(() => {
    void load();
    return api.subscribe(() => void load());
  }, [load]);

  const permissionBlock = (
    <Card>
      <CardContent>
        <PermissionDenied actionName={e.title} requiredRole="audit.read" />
      </CardContent>
    </Card>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={e.title}
        subtitle={e.subtitle}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <a
              href="#/connect-map"
              className="inline-flex items-center gap-1.5 rounded border border-[var(--border)] px-2.5 py-1 text-sm font-medium text-[var(--accent)] hover:bg-[var(--accent-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
              {e.connectionMap}
            </a>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void load()}
              isLoading={loading}
              leftIcon={
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              }
            >
              {t.common.refresh}
            </Button>
          </div>
        }
      />

      {!allowed ? (
        permissionBlock
      ) : error === "permission" ? (
        <ForbiddenNotice />
      ) : error ? (
        <ErrorState
          title={e.loadErrorTitle}
          message={e.loadErrorDesc}
          onRetry={() => void load()}
        />
      ) : loading && !stats ? (
        <Card>
          <CardContent>
            <p className="sr-only">{e.loading}</p>
            <LoadingSkeleton rows={6} />
          </CardContent>
        </Card>
      ) : !stats ? (
        <Card>
          <CardContent>
            <EmptyState
              title={e.emptyTitle}
              description={e.emptyDesc}
              icon={<Boxes className="h-6 w-6" aria-hidden="true" />}
            />
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <StatCard
              title={e.statApplications}
              value={number(stats.totals.applications)}
              subtitle={e.statApplicationsHint}
              icon={<Boxes className="h-4 w-4" aria-hidden="true" />}
            />
            <StatCard
              title={e.statActive}
              value={number(stats.totals.activeApplications)}
              subtitle={e.statActiveHint}
              icon={<ShieldCheck className="h-4 w-4" aria-hidden="true" />}
            />
            <StatCard
              title={e.statActive24h}
              value={number(stats.totals.activeLast24h)}
              subtitle={e.statActive24hHint}
              icon={<Activity className="h-4 w-4" aria-hidden="true" />}
            />
            <StatCard
              title={e.statActive7d}
              value={number(stats.totals.activeLast7d)}
              subtitle={e.statActive7dHint}
              icon={<Activity className="h-4 w-4" aria-hidden="true" />}
            />
            <StatCard
              title={e.statConnections}
              value={number(stats.totals.activeConnections)}
              subtitle={e.statConnectionsHint}
              icon={<Link2 className="h-4 w-4" aria-hidden="true" />}
            />
          </div>

          {stats.applications.length === 0 ? (
            <Card>
              <CardContent>
                <EmptyState
                  title={e.emptyTitle}
                  description={e.emptyDesc}
                  icon={<Boxes className="h-6 w-6" aria-hidden="true" />}
                />
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader>
                <div className="min-w-0">
                  <CardTitle>{e.tableTitle}</CardTitle>
                  <p className="mt-1 text-sm text-[var(--muted)]">
                    {e.tableHint}
                  </p>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1000px] text-left text-sm">
                    <caption className="sr-only">{e.tableTitle}</caption>
                    <thead className="border-b border-[var(--border)] text-xs uppercase tracking-wide text-[var(--muted)]">
                      <tr>
                        <th className="px-3 py-2 font-semibold">{e.colName}</th>
                        <th className="px-3 py-2 font-semibold">{e.colState}</th>
                        <th className="px-3 py-2 font-semibold">
                          {e.colLastActivity}
                        </th>
                        <th className="px-3 py-2 font-semibold">
                          {e.colCallsOut24h}
                        </th>
                        <th className="px-3 py-2 font-semibold">
                          {e.colCallsOut7d}
                        </th>
                        <th className="px-3 py-2 font-semibold">
                          {e.colCallsIn24h}
                        </th>
                        <th className="px-3 py-2 font-semibold">
                          {e.colCallsIn7d}
                        </th>
                        <th className="px-3 py-2 font-semibold">
                          {e.colConnections}
                        </th>
                        <th className="px-3 py-2 font-semibold">
                          {e.colCapabilities}
                        </th>
                        <th className="px-3 py-2 font-semibold">
                          {e.colRecords}
                        </th>
                        <th className="px-3 py-2 font-semibold">
                          {e.colFiles}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.applications.map((application) => (
                        <tr
                          key={application.id}
                          className="border-b border-[var(--border)]/60 last:border-0"
                        >
                          <td className="px-3 py-2">
                            <button
                              type="button"
                              onClick={() => {
                                window.location.hash = appDetailHash(
                                  application.id
                                );
                              }}
                              aria-label={e.openApp.replace(
                                "{name}",
                                application.name
                              )}
                              className="text-left font-semibold text-[var(--accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                            >
                              {application.name}
                            </button>
                          </td>
                          <td className="px-3 py-2">
                            <AppStateBadge state={application.state} />
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 text-[var(--muted)]">
                            {application.lastActivityAt
                              ? formatDateTime(
                                  application.lastActivityAt,
                                  language
                                )
                              : e.never}
                          </td>
                          <td className="px-3 py-2">
                            {number(application.calls.outgoing.last24h)}
                          </td>
                          <td className="px-3 py-2">
                            {number(application.calls.outgoing.last7d)}
                          </td>
                          <td className="px-3 py-2">
                            {number(application.calls.incoming.last24h)}
                          </td>
                          <td className="px-3 py-2">
                            {number(application.calls.incoming.last7d)}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2">
                            {number(application.connections.given)} /{" "}
                            {number(application.connections.received)}
                          </td>
                          <td className="px-3 py-2">
                            {number(application.capabilities.published)}
                          </td>
                          <td className="px-3 py-2">
                            {number(application.data.records)}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2">
                            {application.files ? (
                              `${number(application.files.count)} · ${formatBytes(
                                application.files.bytes,
                                locale
                              )}`
                            ) : (
                              <span aria-label={e.filesUnavailable}>—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
};
