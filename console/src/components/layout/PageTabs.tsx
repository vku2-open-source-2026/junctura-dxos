// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import {
  DASHBOARD_SCREEN_IDS,
  SYSTEM_SCREEN_IDS,
  type ModuleId,
  type ScreenId,
} from "../../constants/modules";
import { PLATFORM_FUNCTION_LIST } from "../../constants/platformFunctions";
import { useI18n } from "../../locales/i18n";

interface PageTabsProps {
  currentScreen: ScreenId;
  onNavigate: (screen: ScreenId) => void;
}

function tabsForScreen(screen: ScreenId): ScreenId[] | null {
  if ((DASHBOARD_SCREEN_IDS as readonly ScreenId[]).includes(screen)) {
    return [...DASHBOARD_SCREEN_IDS];
  }
  if (SYSTEM_SCREEN_IDS.includes(screen)) return SYSTEM_SCREEN_IDS;
  const fn = PLATFORM_FUNCTION_LIST.find((item) => item.screens.includes(screen));
  return fn && fn.screens.length >= 2 ? fn.screens : null;
}

export const PageTabs: React.FC<PageTabsProps> = ({
  currentScreen,
  onNavigate,
}) => {
  const { t } = useI18n();
  const tabs = tabsForScreen(currentScreen);
  if (!tabs || tabs.length < 2) return null;

  return (
    <nav
      aria-label={t.pageTabs.label}
      className="mb-5 flex gap-5 overflow-x-auto border-b border-[var(--border)]"
    >
      {tabs.map((screen) => {
        const active = screen === currentScreen;
        const label = t.modules[screen as ModuleId]?.label ?? screen;
        return (
          <button
            key={screen}
            type="button"
            onClick={() => onNavigate(screen)}
            aria-current={active ? "page" : undefined}
            className={`-mb-px whitespace-nowrap border-b-2 px-0.5 py-2 text-sm font-medium transition-colors ${
              active
                ? "border-[var(--accent)] text-[var(--accent)]"
                : "border-transparent text-[var(--muted)] hover:border-[var(--border)] hover:text-[var(--text)]"
            }`}
          >
            {label}
          </button>
        );
      })}
    </nav>
  );
};
