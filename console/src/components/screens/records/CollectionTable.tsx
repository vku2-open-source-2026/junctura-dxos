// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import type { ApplicationState, StorageApplication } from "../../../types";
import { useI18n } from "../../../locales/i18n";
import { Badge, type BadgeVariant } from "../../common/Badge";

const STATE_VARIANT: Record<ApplicationState, BadgeVariant> = {
  pending: "warning",
  active: "teal",
  suspended: "destructive",
  revoked: "default",
};

export interface SelectedCollection {
  appId: string;
  name: string;
}

interface CollectionTableProps {
  applications: StorageApplication[];
  number: (value: number) => string;
  dateFormat: Intl.DateTimeFormat;
  collectionLabel: (name: string) => string;
  maxRecords: number;
  selected: SelectedCollection | null;
  onSelect: (appId: string, name: string) => void;
}

export const CollectionTable: React.FC<CollectionTableProps> = ({
  applications,
  number,
  dateFormat,
  collectionLabel,
  maxRecords,
  selected,
  onSelect,
}) => {
  const { t } = useI18n();
  const r = t.records;

  const stateLabel = (state: ApplicationState): string =>
    t.applications[`state${state.charAt(0).toUpperCase()}${state.slice(1)}` as
      | "statePending"
      | "stateActive"
      | "stateSuspended"
      | "stateRevoked"];

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] text-sm">
        <caption className="sr-only">{r.tableTitle}</caption>
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--muted)]">
            <th scope="col" className="px-2 py-2 font-semibold">
              {r.colCollection}
            </th>
            <th scope="col" className="px-2 py-2 text-right font-semibold">
              {r.colRecords}
            </th>
            <th scope="col" className="px-2 py-2 font-semibold">
              {r.colUpdated}
            </th>
            <th scope="col" className="px-2 py-2 font-semibold">
              {r.colShare}
            </th>
          </tr>
        </thead>
        {applications.map((app) => {
          const appRecords = app.collections.reduce(
            (sum, collection) => sum + collection.records,
            0
          );
          return (
            <tbody key={app.id}>
              <tr className="border-b border-[var(--border)] bg-slate-50/70 dark:bg-[#1B303B]/40">
                <th scope="rowgroup" colSpan={4} className="px-2 py-2.5 text-left">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-[var(--text)]">
                      {app.name}
                    </span>
                    <Badge variant={STATE_VARIANT[app.state]}>
                      {stateLabel(app.state)}
                    </Badge>
                    <span className="text-xs font-normal text-[var(--muted)]">
                      {r.appRecordCount
                        .replace("{records}", number(appRecords))
                        .replace(
                          "{collections}",
                          number(app.collections.length)
                        )}
                    </span>
                  </span>
                </th>
              </tr>
              {app.collections.map((collection) => {
                const percent = Math.round(
                  (collection.records / maxRecords) * 100
                );
                const updated = collection.updatedAt
                  ? dateFormat.format(new Date(collection.updatedAt))
                  : r.neverUpdated;
                const label = collectionLabel(collection.name);
                const isSelected =
                  selected?.appId === app.id &&
                  selected.name === collection.name;
                return (
                  <tr
                    key={`${app.id}-${collection.name}`}
                    className={`border-b border-[var(--border)]/60 last:border-0 ${
                      isSelected ? "bg-[var(--accent-soft)]/40" : ""
                    }`}
                  >
                    <th scope="row" className="px-2 py-2 text-left font-medium">
                      <button
                        type="button"
                        onClick={() => onSelect(app.id, collection.name)}
                        aria-pressed={isSelected}
                        aria-label={r.viewStructure.replace("{name}", label)}
                        className="rounded text-left font-medium text-[var(--text)] hover:text-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                      >
                        {label}
                      </button>
                    </th>
                    <td className="px-2 py-2 text-right font-mono text-xs text-[var(--text)]">
                      {number(collection.records)}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-xs text-[var(--muted)]">
                      {updated}
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex items-center gap-2">
                        <div
                          role="img"
                          aria-label={r.shareOfTotal.replace(
                            "{percent}",
                            String(percent)
                          )}
                          className="h-1.5 w-full min-w-[5rem] overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"
                        >
                          <span
                            className="block h-full rounded-full bg-[var(--accent)]"
                            style={{ width: `${percent}%` }}
                          />
                        </div>
                        <span className="w-10 text-right text-xs text-[var(--muted)]">
                          {percent}%
                        </span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          );
        })}
      </table>
    </div>
  );
};
