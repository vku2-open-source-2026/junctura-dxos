// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Plug, RefreshCw } from "lucide-react";
import type { CapabilityState, CapabilityVersion } from "../../../types";
import { api } from "../../../services/apiClient";
import { useI18n } from "../../../locales/i18n";
import { PageHeader } from "../../layout/PageHeader";
import { Card, CardContent } from "../../common/Card";
import { Badge, type BadgeVariant } from "../../common/Badge";
import { Button } from "../../common/Button";
import { EmptyState } from "../../common/EmptyState";
import { ErrorState } from "../../common/ErrorState";
import { LoadingSkeleton } from "../../common/LoadingSkeleton";
import { SearchFilterBar } from "../../common/SearchFilterBar";

const STATE_VARIANTS: Record<CapabilityState, BadgeVariant> = {
  published: "teal",
  draft: "outline",
  deprecated: "warning",
  revoked: "destructive",
};

export const CapabilitiesScreen: React.FC = () => {
  const { t } = useI18n();
  const c = t.capabilities;
  const [items, setItems] = useState<CapabilityVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<CapabilityState | "all">(
    "all"
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      setItems(await api.getCapabilities());
    } catch {
      setItems([]);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const stateLabel = (state: CapabilityState): string => {
    if (state === "published") return c.capsStatePublished;
    if (state === "draft") return c.capsStateDraft;
    if (state === "deprecated") return c.state_deprecated;
    return c.state_revoked;
  };

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((item) => {
      if (stateFilter !== "all" && item.state !== stateFilter) return false;
      if (!needle) return true;
      return [
        item.manifest.title,
        item.manifest.capabilityId,
        item.manifest.providerAppId,
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [items, query, stateFilter]);

  return (
    <div className="space-y-6">
      <PageHeader
        title={c.title}
        subtitle={c.capsSubtitle}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load()}
            isLoading={loading}
            leftIcon={<RefreshCw className="w-3.5 h-3.5" />}
          >
            {t.common.refresh}
          </Button>
        }
      />

      <Card>
        <CardContent className="space-y-4">
          <SearchFilterBar
            searchQuery={query}
            onSearchChange={setQuery}
            placeholder={c.capsSearchPlaceholder}
            filterComponent={
              <select
                value={stateFilter}
                onChange={(event) =>
                  setStateFilter(event.target.value as CapabilityState | "all")
                }
                aria-label={c.capsColState}
                className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-stone-ink focus:outline-none focus:ring-1 focus:ring-junctura-blue dark:border-[#243843] dark:bg-[#13242D] dark:text-slate-100"
              >
                <option value="all">{c.filterAll}</option>
                <option value="published">{c.capsStatePublished}</option>
                <option value="draft">{c.capsStateDraft}</option>
                <option value="deprecated">{c.state_deprecated}</option>
                <option value="revoked">{c.state_revoked}</option>
              </select>
            }
            rightAction={
              <span className="text-sm text-slate-500 dark:text-slate-400">
                {filtered.length} {c.capsCount}
              </span>
            }
          />

          {error ? (
            <ErrorState message={t.common.error} onRetry={() => void load()} />
          ) : loading ? (
            <LoadingSkeleton rows={4} />
          ) : items.length === 0 ? (
            <EmptyState
              title={c.capsEmptyTitle}
              description={c.capsEmptyDesc}
              icon={<Plug className="w-6 h-6" />}
              actionLabel={t.common.refresh}
              onAction={() => void load()}
            />
          ) : filtered.length === 0 ? (
            <EmptyState
              title={c.capsNoResultsTitle}
              description={c.capsNoResultsDesc}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-slate-600 dark:text-slate-300">
                <thead className="border-b border-slate-200/80 bg-slate-50 text-sm font-semibold uppercase text-slate-500 dark:border-[#243843] dark:bg-[#1B303B]/40 dark:text-slate-400">
                  <tr>
                    <th className="px-4 py-3">{c.capsColName}</th>
                    <th className="px-4 py-3">{c.capsDetailVersion}</th>
                    <th className="px-4 py-3">{c.capsColState}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-[#243843]/70">
                  {filtered.map((item) => {
                    const state = item.state ?? "draft";
                    return (
                      <tr key={`${item.manifest.capabilityId}:${item.manifest.version}`}>
                        <td className="px-4 py-3">
                          <p className="font-semibold text-stone-ink dark:text-slate-100">
                            {item.manifest.title}
                          </p>
                          <p className="mt-0.5 font-mono text-xs text-slate-500 dark:text-slate-400">
                            {item.manifest.capabilityId}
                          </p>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs">
                          {item.manifest.version}
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant={STATE_VARIANTS[state] ?? "outline"}>
                            {stateLabel(state)}
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
    </div>
  );
};
