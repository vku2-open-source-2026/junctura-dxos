// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import { AppWindow, Inbox, Link2 } from "lucide-react";
import { useI18n } from "../../../locales/i18n";
import type { PendingApprovalItem } from "../../../services/pendingApprovals";
import { EmptyState } from "../../common/EmptyState";
import { Badge } from "../../common/Badge";
import { Card, CardContent, CardHeader, CardTitle } from "../../common/Card";
import { SearchFilterBar } from "../../common/SearchFilterBar";
import {
  kindLabel,
  requestedAtOf,
  requesterOf,
  titleOf,
  type QueueFilter,
} from "./item";

interface QueueListProps {
  items: PendingApprovalItem[];
  filtered: PendingApprovalItem[];
  query: string;
  onQueryChange: (value: string) => void;
  filter: QueueFilter;
  onFilterChange: (value: QueueFilter) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  isSelf: (item: PendingApprovalItem) => boolean;
}

export const QueueList: React.FC<QueueListProps> = ({
  items,
  filtered,
  query,
  onQueryChange,
  filter,
  onFilterChange,
  selectedId,
  onSelect,
  isSelf,
}) => {
  const { t, language } = useI18n();
  const q = t.queue;
  const numberLocale = language === "vi" ? "vi-VN" : "en-US";

  return (
    <Card>
      <CardHeader className="flex-col items-stretch gap-3">
        <CardTitle>
          {items.length} {q.requestCount}
        </CardTitle>
        <SearchFilterBar
          searchQuery={query}
          onSearchChange={onQueryChange}
          placeholder={q.searchPlaceholder}
          filterComponent={
            <select
              value={filter}
              onChange={(event) =>
                onFilterChange(event.target.value as QueueFilter)
              }
              aria-label={q.filterLabel}
              className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-stone-ink focus:outline-none focus:ring-1 focus:ring-junctura-blue dark:border-[#243843] dark:bg-[#13242D] dark:text-slate-100"
            >
              <option value="all">{q.filterAll}</option>
              <option value="application">{q.filterApplications}</option>
              <option value="grant">{q.filterGrants}</option>
            </select>
          }
        />
      </CardHeader>
      <CardContent className="p-0">
        {filtered.length === 0 ? (
          <div className="p-5">
            <EmptyState
              title={q.noResultsTitle}
              description={q.noResultsDesc}
              icon={<Inbox className="h-6 w-6" aria-hidden="true" />}
            />
          </div>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-[#243843]/70">
            {filtered.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => onSelect(item.id)}
                  aria-label={`${q.openDetail}: ${titleOf(item)}`}
                  className={`flex w-full flex-col gap-2 px-5 py-4 text-left transition-colors hover:bg-slate-50 dark:hover:bg-[#1B303B]/40 ${
                    selectedId === item.id
                      ? "bg-slate-50 dark:bg-[#1B303B]/60"
                      : ""
                  }`}
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant={
                        item.kind === "application" ? "warning" : "junctura"
                      }
                    >
                      {item.kind === "application" ? (
                        <AppWindow
                          className="mr-1 h-3 w-3"
                          aria-hidden="true"
                        />
                      ) : (
                        <Link2 className="mr-1 h-3 w-3" aria-hidden="true" />
                      )}
                      {kindLabel(item, q)}
                    </Badge>
                    <span className="ml-auto text-sm text-slate-400 dark:text-slate-500">
                      {requestedAtOf(item, numberLocale)}
                    </span>
                  </span>
                  <span className="text-sm font-semibold text-stone-ink dark:text-slate-100">
                    {titleOf(item)}
                  </span>
                  <span className="text-sm text-slate-500 dark:text-slate-400">
                    {requesterOf(item)}
                    {isSelf(item) ? ` (${q.selfLabel})` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
};
