// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useMemo, useState } from "react";
import { ArrowRight, Info } from "lucide-react";
import type { ApplicationState } from "../../../types";
import type { TrustGraphNode } from "../../../types";
import { useI18n } from "../../../locales/i18n";
import { PageHeader } from "../../layout/PageHeader";
import { Card, CardContent, CardHeader } from "../../common/Card";
import { Button } from "../../common/Button";
import { EmptyState } from "../../common/EmptyState";
import { ErrorState } from "../../common/ErrorState";
import { LoadingSkeleton } from "../../common/LoadingSkeleton";
import { SearchFilterBar } from "../../common/SearchFilterBar";
import { AppStateBadge } from "./AppStateBadge";

interface AppListProps {
  applications: TrustGraphNode[];
  isLoading: boolean;
  error: string | null;
  onOpen: (appId: string) => void;
  onRetry: () => void;
}

const STATES: ApplicationState[] = ["active", "pending", "suspended", "revoked"];

export const AppList: React.FC<AppListProps> = ({
  applications,
  isLoading,
  error,
  onOpen,
  onRetry,
}) => {
  const { t } = useI18n();
  const a = t.applications;
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<ApplicationState | "all">(
    "all"
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return applications.filter((app) => {
      if (stateFilter !== "all" && app.state !== stateFilter) return false;
      if (!needle) return true;
      return app.displayName.toLowerCase().includes(needle);
    });
  }, [applications, query, stateFilter]);

  const renderBody = () => {
    if (isLoading) {
      return (
        <CardContent>
          <p className="sr-only">{a.loadingList}</p>
          <LoadingSkeleton rows={4} />
        </CardContent>
      );
    }
    if (error) {
      return (
        <CardContent>
          <ErrorState message={error} onRetry={onRetry} />
        </CardContent>
      );
    }
    if (applications.length === 0) {
      return (
        <CardContent>
          <EmptyState
            title={a.listEmptyTitle}
            description={a.listEmptyDesc}
          />
        </CardContent>
      );
    }
    if (filtered.length === 0) {
      return (
        <CardContent>
          <EmptyState title={a.noMatchTitle} description={a.noMatchDesc} />
        </CardContent>
      );
    }
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm text-slate-600 dark:text-slate-300">
          <thead className="border-b border-slate-200/80 bg-slate-50 text-sm font-semibold uppercase text-slate-500 dark:border-[#243843] dark:bg-[#1B303B]/40 dark:text-slate-400">
            <tr>
              <th className="px-5 py-3">{a.columnApp}</th>
              <th className="px-5 py-3">{a.columnState}</th>
              <th className="px-5 py-3 text-right">{a.columnActions}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-[#243843]/70">
            {filtered.map((app) => (
              <tr
                key={app.appId}
                className="transition-colors hover:bg-slate-50/80 dark:hover:bg-[#1B303B]/30"
              >
                <td className="px-5 py-3.5">
                  <button
                    type="button"
                    onClick={() => onOpen(app.appId)}
                    className="text-left font-semibold text-stone-ink hover:text-junctura-blue dark:text-slate-100 dark:hover:text-[var(--accent)]"
                  >
                    {app.displayName}
                  </button>
                  {app.owned && (
                    <span className="ml-2 text-xs text-[var(--muted)]">
                      ({a.ownerLabel})
                    </span>
                  )}
                </td>
                <td className="px-5 py-3.5">
                  <AppStateBadge state={app.state} />
                </td>
                <td className="px-5 py-3.5 text-right">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onOpen(app.appId)}
                    rightIcon={<ArrowRight className="w-3.5 h-3.5" />}
                  >
                    {a.openApp}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <PageHeader title={a.title} subtitle={a.subtitle} />

      <div className="flex items-start gap-3 rounded-md border border-slate-200/80 bg-slate-50 p-4 text-sm text-slate-600 dark:border-[#243843] dark:bg-[#13242D] dark:text-slate-300">
        <Info className="mt-0.5 w-4 h-4 flex-shrink-0 text-junctura-blue dark:text-[var(--accent)]" />
        <p className="leading-relaxed">{a.selfRegistrationNotice}</p>
      </div>

      <Card>
        <CardHeader>
          <div className="w-full">
            <SearchFilterBar
              searchQuery={query}
              onSearchChange={setQuery}
              placeholder={a.listSearchPlaceholder}
              filterComponent={
                <select
                  value={stateFilter}
                  onChange={(event) =>
                    setStateFilter(
                      event.target.value as ApplicationState | "all"
                    )
                  }
                  aria-label={a.filterStateLabel}
                  className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-stone-ink focus:outline-none focus:ring-1 focus:ring-junctura-blue dark:border-[#243843] dark:bg-[#13242D] dark:text-slate-100"
                >
                  <option value="all">{a.allStates}</option>
                  {STATES.map((state) => (
                    <option key={state} value={state}>
                      {state === "active"
                        ? a.stateActive
                        : state === "pending"
                          ? a.statePending
                          : state === "suspended"
                            ? a.stateSuspended
                            : a.stateRevoked}
                    </option>
                  ))}
                </select>
              }
            />
          </div>
        </CardHeader>
        {renderBody()}
      </Card>
    </div>
  );
};
