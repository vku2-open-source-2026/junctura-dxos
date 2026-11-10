// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useEffect, useRef, useState } from "react";
import {
  Check,
  Globe,
  Menu,
  Monitor,
  Moon,
  MoreHorizontal,
  Search,
  Sun,
  Zap,
} from "lucide-react";
import type { ScreenId, TextSize, Theme } from "../../types";
import { useI18n } from "../../locales/i18n";
import { useTheme } from "../../services/themeContext";
import { usePlatformServices } from "../../services/platformStatus";
import { PANEL_FUNCTION_IDS } from "../../constants/platformFunctions";
import { Breadcrumbs } from "./Breadcrumbs";
import { HeaderMobileMenu } from "./HeaderMobileMenu";
import { STATUS_DOT, statusLabel } from "../screens/platform/status";

type MenuId = "text" | "mobile" | null;

const PILL_CLASS =
  "inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full border border-[var(--border)] bg-[var(--card)] px-2 text-sm text-[var(--text)] transition-colors xl:px-3 hover:border-[var(--accent)]";

const THEME_ORDER: Theme[] = ["light", "dark", "system"];

interface HeaderProps {
  currentScreen: ScreenId;
  onNavigate: (screen: ScreenId) => void;
  onOpenMobileMenu: () => void;
  onOpenPalette: () => void;
  identityState: import("../../types").IdentityState;
  isPanelOpen: boolean;
  onTogglePanel: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  currentScreen,
  onOpenMobileMenu,
  onOpenPalette,
  isPanelOpen,
  onTogglePanel,
}) => {
  const { language, toggleLanguage, t } = useI18n();
  const { theme, isDark, setTheme, textSize, setTextSize } = useTheme();
  const { aggregate } = usePlatformServices();
  const [menu, setMenu] = useState<MenuId>(null);
  const rightRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const handleClick = (event: MouseEvent) => {
      if (!rightRef.current?.contains(event.target as Node)) setMenu(null);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [menu]);

  const statusText = statusLabel(t.platform, aggregate);

  const cycleTheme = () => {
    const next =
      THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
    setTheme(next);
  };

  const themeTitle =
    theme === "light"
      ? t.settings.darkTheme
      : theme === "dark"
        ? t.settings.systemTheme
        : t.settings.lightTheme;

  const textSizes: { value: TextSize; label: string }[] = [
    { value: "sm", label: t.settings.textSizeSmall },
    { value: "md", label: t.settings.textSizeMedium },
    { value: "lg", label: t.settings.textSizeLarge },
  ];

  return (
    <header className="sticky top-0 z-30 flex items-center justify-between gap-3 bg-[var(--bg)]/90 px-4 py-3 backdrop-blur-xs md:px-6">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <button
          type="button"
          onClick={onOpenMobileMenu}
          className="rounded-full p-2 text-[var(--muted)] hover:bg-slate-500/10 hover:text-[var(--text)] md:hidden"
          aria-label={t.session.openMenu}
        >
          <Menu className="h-5 w-5" aria-hidden="true" />
        </button>
        <Breadcrumbs currentScreen={currentScreen} />
      </div>

      <div
        ref={rightRef}
        className="flex flex-shrink-0 items-center gap-2 whitespace-nowrap"
      >
        <div className="relative hidden items-center gap-2 lg:flex">
          <button
            type="button"
            onClick={onOpenPalette}
            aria-label={t.palette.openLabel}
            title={t.palette.openLabel}
            className={`${PILL_CLASS} text-[var(--muted)]`}
          >
            <Search className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{t.header.search}</span>
            <kbd className="hidden rounded border border-[var(--border)] px-1 text-xs xl:inline">
              Ctrl K
            </kbd>
          </button>

          <button
            type="button"
            onClick={onTogglePanel}
            aria-expanded={isPanelOpen}
            title={statusText}
            className={`${PILL_CLASS} ${
              isPanelOpen ? "border-[var(--accent)]" : ""
            }`}
          >
            <Zap className="h-3.5 w-3.5 text-[var(--accent)]" aria-hidden="true" />
            <span>{t.header.servicesLabel}</span>
            <span className="font-semibold">
              {PANEL_FUNCTION_IDS.length}
            </span>
            <span
              className={`h-2 w-2 rounded-full ${STATUS_DOT[aggregate]}`}
              aria-hidden="true"
            />
          </button>

          <button
            type="button"
            onClick={toggleLanguage}
            aria-label={t.session.toggleLanguage}
            title={t.session.switchLanguage}
            className={`${PILL_CLASS} font-bold uppercase`}
          >
            <Globe className="h-3.5 w-3.5" aria-hidden="true" />
            {language}
          </button>

          <button
            type="button"
            onClick={cycleTheme}
            aria-label={t.session.toggleTheme}
            title={themeTitle}
            className={PILL_CLASS}
          >
            {theme === "system" ? (
              <Monitor className="h-4 w-4" aria-hidden="true" />
            ) : isDark ? (
              <Sun className="h-4 w-4 text-amber-400" aria-hidden="true" />
            ) : (
              <Moon className="h-4 w-4" aria-hidden="true" />
            )}
          </button>

          <div className="relative">
            <button
              type="button"
              onClick={() => setMenu(menu === "text" ? null : "text")}
              aria-haspopup="menu"
              aria-expanded={menu === "text"}
              aria-label={t.settings.textSizeLabel}
              title={t.settings.textSizeLabel}
              className={`${PILL_CLASS} font-semibold`}
            >
              Aa
            </button>
            {menu === "text" && (
              <div
                role="menu"
                aria-label={t.settings.textSizeLabel}
                className="absolute right-0 top-full z-50 mt-2 w-40 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--card)] p-1 shadow-xl"
              >
                {textSizes.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={textSize === option.value}
                    onClick={() => {
                      setTextSize(option.value);
                      setMenu(null);
                    }}
                    className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm text-[var(--text)] hover:bg-slate-500/10"
                  >
                    {option.label}
                    {textSize === option.value && (
                      <Check
                        className="h-4 w-4 text-[var(--accent)]"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="relative lg:hidden">
          <button
            type="button"
            onClick={() => setMenu(menu === "mobile" ? null : "mobile")}
            aria-label={t.header.openControls}
            aria-expanded={menu === "mobile"}
            className={PILL_CLASS}
          >
            <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
          </button>
          {menu === "mobile" && (
            <HeaderMobileMenu
              onClose={() => setMenu(null)}
              onOpenPalette={onOpenPalette}
              onTogglePanel={onTogglePanel}
              isPanelOpen={isPanelOpen}
            />
          )}
        </div>
      </div>
    </header>
  );
};
