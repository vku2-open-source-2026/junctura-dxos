// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Files, HardDrive, RefreshCw, ShieldAlert } from "lucide-react";
import type {
  StorageApplication,
  StorageFiles,
  StorageSummary,
} from "../../types";
import { ApiError, api } from "../../services/apiClient";
import { useI18n } from "../../locales/i18n";
import { useSession } from "../../services/session";
import { PageHeader } from "../layout/PageHeader";
import { Badge } from "../common/Badge";
import { Button } from "../common/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../common/Card";
import { EmptyState } from "../common/EmptyState";
import { ErrorState } from "../common/ErrorState";
import { LoadingSkeleton } from "../common/LoadingSkeleton";
import { PermissionDenied } from "../common/PermissionDenied";
import { StatCard } from "../common/StatCard";
import { FileBrowser } from "./files/FileBrowser";
import { formatBytes } from "./files/fileMeta";

type FileApplication = StorageApplication & { files: StorageFiles };

export const FilesScreen: React.FC = () => {
  const { t, language } = useI18n();
  const f = t.files;
  const { can } = useSession();
  const allowed = can("audit.read");
  const [summary, setSummary] = useState<StorageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<"permission" | "generic" | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

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
      setSummary(await api.getStorageSummary());
    } catch (failure) {
      setSummary(null);
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

  const applications = useMemo<FileApplication[]>(
    () =>
      (summary?.applications ?? []).filter(
        (app): app is FileApplication =>
          app.files !== null && app.files !== undefined
      ),
    [summary]
  );

  useEffect(() => {
    if (applications.length === 0) {
      setSelectedId(null);
      return;
    }
    setSelectedId((current) =>
      current && applications.some((app) => app.id === current)
        ? current
        : applications[0].id
    );
  }, [applications]);

  const totals = summary?.totals.files ?? null;
  const selectedApp =
    applications.find((app) => app.id === selectedId) ?? null;
  const maxBytes = Math.max(1, ...applications.map((app) => app.files.bytes));

  return (
    <div className="space-y-6">
      <PageHeader
        title={f.title}
        subtitle={f.subtitle}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load()}
            isLoading={loading}
            leftIcon={<RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
          >
            {t.common.refresh}
          </Button>
        }
      />

      {!allowed ? (
        <Card>
          <CardContent>
            <PermissionDenied actionName={f.title} requiredRole="audit.read" />
          </CardContent>
        </Card>
      ) : error ? (
        <ErrorState
          title={error === "permission" ? f.permissionDeniedTitle : f.loadErrorTitle}
          message={error === "permission" ? f.permissionDeniedDesc : f.loadErrorDesc}
          onRetry={() => void load()}
        />
      ) : loading && !summary ? (
        <Card>
          <CardContent>
            <p className="sr-only">{f.loading}</p>
            <LoadingSkeleton rows={5} />
          </CardContent>
        </Card>
      ) : !summary ? (
        <Card>
          <CardContent>
            <EmptyState
              title={f.emptyTitle}
              description={f.emptyDesc}
              icon={<Files className="h-6 w-6" aria-hidden="true" />}
            />
          </CardContent>
        </Card>
      ) : totals === null ? (
        <Card>
          <CardContent>
            <EmptyState
              title={f.unavailableTitle}
              description={f.unavailableDesc}
              icon={<HardDrive className="h-6 w-6" aria-hidden="true" />}
            />
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard
              title={f.statFiles}
              value={number(totals.count)}
              subtitle={f.statFilesHint}
              icon={<Files className="h-4 w-4" aria-hidden="true" />}
            />
            <StatCard
              title={f.statStorage}
              value={formatBytes(totals.bytes, locale)}
              subtitle={f.statStorageHint}
              icon={<HardDrive className="h-4 w-4" aria-hidden="true" />}
            />
            <StatCard
              title={f.statQuarantined}
              value={number(totals.quarantined)}
              subtitle={f.statQuarantinedHint}
              icon={<ShieldAlert className="h-4 w-4" aria-hidden="true" />}
              badge={
                totals.quarantined > 0 ? (
                  <Badge variant="warning">{f.needsReview}</Badge>
                ) : undefined
              }
            />
          </div>

          {applications.length === 0 ? (
            <Card>
              <CardContent>
                <EmptyState
                  title={f.emptyTitle}
                  description={f.emptyDesc}
                  icon={<Files className="h-6 w-6" aria-hidden="true" />}
                />
              </CardContent>
            </Card>
          ) : (
            <div className="grid items-start gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
              <Card className="min-w-0">
                <CardHeader>
                  <div className="min-w-0">
                    <CardTitle>{f.appListTitle}</CardTitle>
                    <p className="mt-1 text-sm text-[var(--muted)]">
                      {f.appListHint}
                    </p>
                  </div>
                </CardHeader>
                <CardContent className="p-2">
                  <ul className="space-y-1">
                    {applications.map((app) => {
                      const active = app.id === selectedApp?.id;
                      const percent = Math.round(
                        (app.files.bytes / maxBytes) * 100
                      );
                      return (
                        <li key={app.id}>
                          <button
                            type="button"
                            onClick={() => setSelectedId(app.id)}
                            aria-pressed={active}
                            className={`w-full rounded-md border px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                              active
                                ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                                : "border-transparent hover:border-[var(--border)] hover:bg-[var(--accent-soft)]/40"
                            }`}
                          >
                            <span className="block break-words text-sm font-semibold text-[var(--text)]">
                              {app.name}
                            </span>
                            <span className="mt-1 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--muted)]">
                              <span>
                                {f.colFiles}: {number(app.files.count)}
                              </span>
                              <span>{formatBytes(app.files.bytes, locale)}</span>
                            </span>
                            <span
                              role="img"
                              aria-label={f.storageShare.replace(
                                "{percent}",
                                String(percent)
                              )}
                              className="mt-1.5 block h-1 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"
                            >
                              <span
                                className="block h-full rounded-full bg-[var(--accent)]"
                                style={{ width: `${percent}%` }}
                              />
                            </span>
                            {app.files.count === 0 && (
                              <span className="mt-1 block text-xs text-[var(--muted)]">
                                {f.appNoFiles}
                              </span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </CardContent>
              </Card>

              {selectedApp ? (
                <FileBrowser key={selectedApp.id} app={selectedApp} />
              ) : (
                <Card>
                  <CardContent>
                    <EmptyState
                      title={f.selectAppTitle}
                      description={f.selectAppDesc}
                      icon={<Files className="h-6 w-6" aria-hidden="true" />}
                    />
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
};
