// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, RefreshCw, ShieldAlert } from "lucide-react";
import type { EmergencyAccess } from "../../types";
import { api } from "../../services/apiClient";
import { useI18n } from "../../locales/i18n";
import { useSession } from "../../services/session";
import { PageHeader } from "../layout/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "../common/Card";
import { Badge, type BadgeVariant } from "../common/Badge";
import { Button } from "../common/Button";
import { EmptyState } from "../common/EmptyState";
import { ErrorState } from "../common/ErrorState";
import { LoadingSkeleton } from "../common/LoadingSkeleton";
import { PermissionDenied } from "../common/PermissionDenied";
import { SearchFilterBar } from "../common/SearchFilterBar";
import { StatCard } from "../common/StatCard";

type StateFilter = EmergencyAccess["state"] | "all";

const STATE_VARIANT: Record<EmergencyAccess["state"], BadgeVariant> = {
  pending: "warning",
  justified: "teal",
  unjustified: "destructive",
};

const selectClass =
  "px-2.5 py-1.5 text-sm rounded-md border border-slate-200 dark:border-[#243843] bg-white dark:bg-[#13242D] text-stone-ink dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-[#176B80] dark:focus:ring-[var(--accent)]";

export const EmergencyScreen: React.FC = () => {
  const { t, language } = useI18n();
  const e = t.emergency;
  const { can } = useSession();

  const [accesses, setAccesses] = useState<EmergencyAccess[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");

  const numberLocale = language === "vi" ? "vi-VN" : "en-GB";
  const appName = (access: EmergencyAccess) =>
    access.consumer.displayName ?? access.consumer.appId;

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      setAccesses(await api.getEmergencyAccesses());
    } catch {
      setAccesses([]);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(
    () => ({
      pending: accesses.filter((item) => item.state === "pending").length,
      justified: accesses.filter((item) => item.state === "justified").length,
      unjustified: accesses.filter((item) => item.state === "unjustified")
        .length,
    }),
    [accesses]
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return accesses
      .filter((access) => {
        if (stateFilter !== "all" && access.state !== stateFilter) return false;
        if (!needle) return true;
        return [
          access.consumer.displayName ?? "",
          access.provider.displayName ?? "",
          access.capability.capabilityId,
        ]
          .join(" ")
          .toLowerCase()
          .includes(needle);
      })
      .sort((left, right) => {
        if (left.state !== right.state)
          return left.state === "pending" ? -1 : 1;
        return Date.parse(right.accessedAt) - Date.parse(left.accessedAt);
      });
  }, [accesses, query, stateFilter]);

  if (!can("audit.read")) {
    return <PermissionDenied actionName={e.title} requiredRole="audit.read" />;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={e.title}
        subtitle={e.subtitle}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load()}
            isLoading={loading}
            leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
          >
            {t.common.refresh}
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard
          title={e.pendingCount}
          value={counts.pending}
          icon={<AlertTriangle className="h-4 w-4" aria-hidden="true" />}
        />
        <StatCard
          title={e.validCount}
          value={counts.justified}
          icon={<CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
        />
        <StatCard
          title={e.violationCount}
          value={counts.unjustified}
          icon={<ShieldAlert className="h-4 w-4" aria-hidden="true" />}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{e.listTitle}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="border-b border-slate-100 px-5 py-4 dark:border-[#243843]/70">
            <SearchFilterBar
              searchQuery={query}
              onSearchChange={setQuery}
              placeholder={e.searchPlaceholder}
              filterComponent={
                <select
                  aria-label={e.colState}
                  value={stateFilter}
                  onChange={(event) =>
                    setStateFilter(event.target.value as StateFilter)
                  }
                  className={selectClass}
                >
                  <option value="all">{e.allStates}</option>
                  <option value="pending">{e.statePending}</option>
                  <option value="justified">{e.stateValid}</option>
                  <option value="unjustified">{e.stateViolation}</option>
                </select>
              }
            />
          </div>

          {loadError ? (
            <div className="p-5">
              <ErrorState message={t.common.error} onRetry={() => void load()} />
            </div>
          ) : loading ? (
            <div className="p-5">
              <LoadingSkeleton rows={4} />
            </div>
          ) : visible.length === 0 ? (
            <div className="p-5">
              <EmptyState
                title={e.emptyTitle}
                description={accesses.length === 0 ? e.emptyDesc : e.noMatches}
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-slate-600 dark:text-slate-300">
                <caption className="sr-only">{e.tableCaption}</caption>
                <thead className="border-b border-slate-200/80 bg-slate-50 text-sm font-semibold uppercase text-slate-500 dark:border-[#243843] dark:bg-[#1B303B]/40 dark:text-slate-400">
                  <tr>
                    <th className="px-5 py-3">{e.colTime}</th>
                    <th className="px-5 py-3">{e.colApp}</th>
                    <th className="px-5 py-3">{e.colSubject}</th>
                    <th className="px-5 py-3">{e.colState}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-[#243843]/70">
                  {visible.map((access) => (
                    <tr
                      key={access.executionId}
                      className="transition-colors hover:bg-slate-50/80 dark:hover:bg-[#1B303B]/30"
                    >
                      <td className="whitespace-nowrap px-5 py-3 text-slate-500 dark:text-slate-400">
                        {new Date(access.accessedAt).toLocaleString(
                          numberLocale
                        )}
                      </td>
                      <td className="px-5 py-3 font-semibold text-stone-ink dark:text-slate-100">
                        {appName(access)}
                      </td>
                      <td className="max-w-xs px-5 py-3">
                        {access.capability.capabilityId}
                      </td>
                      <td className="px-5 py-3">
                        <Badge variant={STATE_VARIANT[access.state]}>
                          {access.state === "pending"
                            ? e.statePending
                            : access.state === "justified"
                              ? e.stateValid
                              : e.stateViolation}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="rounded-md border border-slate-200/80 bg-slate-50 p-3 text-sm leading-relaxed text-slate-500 dark:border-[#243843] dark:bg-[#13242D] dark:text-slate-400">
        {e.readOnlyNote}
      </p>
    </div>
  );
};
