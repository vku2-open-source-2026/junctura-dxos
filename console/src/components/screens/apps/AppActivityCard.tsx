// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useEffect, useState } from "react";
import type { ApplicationStatsEntry } from "../../../types";
import { api } from "../../../services/apiClient";
import { useI18n } from "../../../locales/i18n";
import { useSession } from "../../../services/session";
import { Card, CardContent, CardHeader, CardTitle } from "../../common/Card";
import { formatDateTime } from "./format";
import { formatBytes } from "../files/fileMeta";

type ActivityState = "idle" | "loading" | "ready" | "error";

interface AppActivityCardProps {
  applicationId: string;
}

export const AppActivityCard: React.FC<AppActivityCardProps> = ({
  applicationId,
}) => {
  const { t, language } = useI18n();
  const e = t.ecosystem;
  const { can } = useSession();
  const allowed = can("audit.read");
  const [entry, setEntry] = useState<ApplicationStatsEntry | null>(null);
  const [state, setState] = useState<ActivityState>("idle");
  const locale = language === "vi" ? "vi-VN" : "en-US";
  const number = (value: number) =>
    new Intl.NumberFormat(locale).format(value);

  useEffect(() => {
    if (!allowed) {
      setState("idle");
      setEntry(null);
      return;
    }
    let cancelled = false;
    setState("loading");
    setEntry(null);
    api
      .getApplicationStats()
      .then((stats) => {
        if (cancelled) return;
        setEntry(
          stats.applications.find((item) => item.id === applicationId) ?? null
        );
        setState("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setEntry(null);
        setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [allowed, applicationId]);

  if (!allowed) return null;

  const rows = entry
    ? [
        {
          label: e.lastActivity,
          value: entry.lastActivityAt
            ? formatDateTime(entry.lastActivityAt, language)
            : e.never,
        },
        { label: e.colCallsOut24h, value: number(entry.calls.outgoing.last24h) },
        { label: e.colCallsOut7d, value: number(entry.calls.outgoing.last7d) },
        { label: e.colCallsIn24h, value: number(entry.calls.incoming.last24h) },
        { label: e.colCallsIn7d, value: number(entry.calls.incoming.last7d) },
        {
          label: e.colConnections,
          value: `${number(entry.connections.given)} / ${number(
            entry.connections.received
          )}`,
        },
        {
          label: e.colCapabilities,
          value: number(entry.capabilities.published),
        },
        { label: e.colRecords, value: number(entry.data.records) },
        {
          label: e.colFiles,
          value: entry.files ? (
            `${number(entry.files.count)} · ${formatBytes(
              entry.files.bytes,
              locale
            )}`
          ) : (
            <span aria-label={e.filesUnavailable}>—</span>
          ),
        },
      ]
    : [];

  return (
    <Card>
      <CardHeader>
        <div className="min-w-0">
          <CardTitle>{e.activityTitle}</CardTitle>
          <p className="mt-1 text-sm text-[var(--muted)]">{e.activityDesc}</p>
        </div>
      </CardHeader>
      <CardContent>
        {state === "loading" ? (
          <p className="text-sm text-[var(--muted)]">{t.common.loading}</p>
        ) : state === "error" ? (
          <p className="text-sm text-rose-700 dark:text-rose-400">
            {e.activityError}
          </p>
        ) : !entry ? (
          <p className="text-sm text-[var(--muted)]">{e.activityMissing}</p>
        ) : (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
            {rows.map((row) => (
              <div
                key={row.label}
                className="flex items-center justify-between gap-3 border-b border-[var(--border)]/60 py-1.5 last:border-0"
              >
                <dt className="text-sm text-[var(--muted)]">{row.label}</dt>
                <dd className="text-sm font-medium text-[var(--text)]">
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </CardContent>
    </Card>
  );
};
