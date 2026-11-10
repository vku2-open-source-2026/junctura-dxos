// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import { useI18n } from "../../../locales/i18n";
import {
  SHARE_LABEL_KEY,
  SHARE_STATE_ORDER,
  type ShareState,
} from "./shareMeta";

export type ShareFilter = ShareState | "all";

interface ShareTabsProps {
  total: number;
  counts: Record<ShareState, number>;
  value: ShareFilter;
  onChange: (value: ShareFilter) => void;
}

export const ShareTabs: React.FC<ShareTabsProps> = ({
  total,
  counts,
  value,
  onChange,
}) => {
  const { t } = useI18n();
  const g = t.grants;
  const states: ShareFilter[] = ["all", ...SHARE_STATE_ORDER];

  return (
    <div
      role="tablist"
      aria-label={g.tabsLabel}
      className="flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-[#243843]"
    >
      {states.map((state) => {
        const active = value === state;
        const label = state === "all" ? g.tabAll : g[SHARE_LABEL_KEY[state]];
        const count = state === "all" ? total : counts[state];
        return (
          <button
            key={state}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(state)}
            className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              active
                ? "border-[var(--accent)] text-[var(--accent)]"
                : "border-transparent text-slate-500 hover:text-stone-ink dark:text-slate-400 dark:hover:text-slate-200"
            }`}
          >
            {label} ({count})
          </button>
        );
      })}
    </div>
  );
};
