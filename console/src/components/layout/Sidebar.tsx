// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import {
  ChevronLeft,
  ChevronRight,
  Code2,
  type LucideIcon,
} from "lucide-react";
import {
  SIDEBAR_ITEM_IDS,
  SIDEBAR_SCREEN_MAP,
  getModule,
  type ModuleId,
  type ScreenId,
} from "../../constants/modules";
import { PLATFORM_SIDEBAR_ITEM } from "../../constants/platformFunctions";
import { platformIdFromHash } from "../../services/appRouting";
import { useI18n } from "../../locales/i18n";
import { usePendingApprovals } from "../../services/pendingApprovals";
import { useSession } from "../../services/session";
import { JuncturaLogo } from "../common/JuncturaLogo";
import { SidebarAccount } from "./SidebarAccount";

interface SidebarProps {
  currentScreen: ScreenId;
  onNavigate: (screen: ScreenId) => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  showCollapse?: boolean;
  embedded?: boolean;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentScreen,
  onNavigate,
  isCollapsed,
  onToggleCollapse,
  showCollapse = true,
  embedded = false,
}) => {
  const { t } = useI18n();
  const { can } = useSession();
  const { items: pendingItems } = usePendingApprovals();
  const rail = isCollapsed && !embedded;
  const activeFunction = platformIdFromHash();
  const activeItem: ModuleId | "docs" | null =
    currentScreen === "docs"
      ? "docs"
      : currentScreen === "platform" && activeFunction
        ? PLATFORM_SIDEBAR_ITEM[activeFunction] ?? null
        : (SIDEBAR_SCREEN_MAP[currentScreen] ?? null);

  const canSee = (id: ScreenId): boolean => {
    const module = getModule(id);
    return !module?.perm || can(module.perm);
  };

  const itemClass = (active: boolean) =>
    `relative flex min-h-9 w-full items-center gap-3 rounded-lg px-3 text-sm transition-colors ${
      active
        ? "bg-[var(--accent-soft)] font-semibold text-[var(--accent)] before:absolute before:bottom-1.5 before:left-0 before:top-1.5 before:w-0.5 before:rounded-full before:bg-[var(--accent)] before:content-['']"
        : "font-medium text-slate-600 hover:bg-[var(--accent-soft)]/60 dark:text-slate-300"
    } ${rail ? "justify-center px-0" : ""}`;

  const renderItem = (
    id: ModuleId,
    label: string,
    Icon: LucideIcon,
    badgeCount = 0
  ) => {
    const active = activeItem === id;
    return (
      <button
        key={id}
        type="button"
        onClick={() => onNavigate(id)}
        aria-label={rail ? label : undefined}
        aria-current={active ? "page" : undefined}
        title={rail ? label : undefined}
        className={itemClass(active)}
      >
        <Icon className="h-[18px] w-[18px] flex-shrink-0" aria-hidden="true" />
        {!rail && <span className="min-w-0 flex-1 truncate text-left">{label}</span>}
        {badgeCount > 0 && !rail && (
          <span
            aria-label={`${badgeCount} ${t.modules.queue.label}`}
            className="flex h-4 min-w-4 items-center justify-center rounded-full bg-[#C58B62] px-1 text-xs font-semibold text-white"
          >
            {badgeCount}
          </span>
        )}
      </button>
    );
  };

  const renderDocsItem = () => {
    const label = t.platform.docsApi;
    const active = activeItem === "docs";
    return (
      <button
        type="button"
        onClick={() => onNavigate("docs")}
        aria-label={rail ? label : undefined}
        aria-current={active ? "page" : undefined}
        title={rail ? label : undefined}
        className={itemClass(active)}
      >
        <Code2 className="h-[18px] w-[18px] flex-shrink-0" aria-hidden="true" />
        {!rail && <span className="min-w-0 flex-1 truncate text-left">{label}</span>}
      </button>
    );
  };

  return (
    <aside
      className={
        embedded
          ? "flex h-full w-full flex-col bg-transparent"
          : `fixed bottom-3 left-3 top-3 z-40 flex select-none flex-col rounded-lg border border-[var(--border)] bg-[var(--card)] shadow-lg transition-[width] duration-300 ${
              isCollapsed ? "w-[4.5rem]" : "w-64"
            }`
      }
      aria-label={t.session.navigation}
    >
      <div
        className={`flex items-center border-b border-[var(--border)] p-3 ${
          rail ? "flex-col gap-2" : "justify-between"
        }`}
      >
        <button
          type="button"
          onClick={() => onNavigate("dashboard")}
          className="flex min-w-0 items-center text-left focus:outline-none"
          aria-label={t.modules.dashboard.label}
        >
          <JuncturaLogo size={30} showText={!rail} className={rail ? "justify-center" : ""} />
        </button>
        {showCollapse && (
          <button
            type="button"
            onClick={onToggleCollapse}
            className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-500/10 hover:text-[var(--text)]"
            aria-label={isCollapsed ? t.session.expandSidebar : t.session.collapseSidebar}
            title={isCollapsed ? t.session.expandSidebar : t.session.collapseSidebar}
          >
            {isCollapsed ? (
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            ) : (
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        )}
      </div>

      <nav className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-2">
        <div className="space-y-0.5">
          {SIDEBAR_ITEM_IDS.filter(canSee).map((id) => {
            const module = getModule(id);
            if (!module) return null;
            const count = module.badgeKey === "pending" ? pendingItems.length : 0;
            return renderItem(id, t.modules[id].label, module.icon, count);
          })}
        </div>

        <div className="mt-auto space-y-0.5 border-t border-[var(--border)] pt-2">
          {renderDocsItem()}
          {canSee("settings") && (
            <button
              type="button"
              onClick={() => onNavigate("settings")}
              aria-label={rail ? t.modules.settings.label : undefined}
              aria-current={activeItem === "settings" ? "page" : undefined}
              title={rail ? t.modules.settings.label : undefined}
              className={itemClass(activeItem === "settings")}
            >
              {React.createElement(getModule("settings")?.icon ?? Code2, {
                className: "h-[18px] w-[18px] flex-shrink-0",
                "aria-hidden": true,
              })}
              {!rail && (
                <span className="min-w-0 flex-1 truncate text-left">
                  {t.modules.settings.label}
                </span>
              )}
            </button>
          )}
        </div>
      </nav>

      <SidebarAccount onNavigate={onNavigate} isCollapsed={isCollapsed} embedded={embedded} />
    </aside>
  );
};
