// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import { Globe, Monitor, Moon, Search, Sun, Zap } from "lucide-react";
import type { TextSize, Theme } from "../../types";
import { useI18n } from "../../locales/i18n";
import { useTheme } from "../../services/themeContext";
import { usePlatformServices } from "../../services/platformStatus";
import { STATUS_DOT } from "../screens/platform/status";

const THEME_ORDER: Theme[] = ["light", "dark", "system"];

interface HeaderMobileMenuProps {
  onClose: () => void;
  onOpenPalette: () => void;
  onTogglePanel: () => void;
  isPanelOpen: boolean;
}

export const HeaderMobileMenu: React.FC<HeaderMobileMenuProps> = ({
  onClose,
  onOpenPalette,
  onTogglePanel,
  isPanelOpen,
}) => {
  const { language, toggleLanguage, t } = useI18n();
  const { theme, isDark, setTheme, textSize, setTextSize } = useTheme();
  const { aggregate } = usePlatformServices();

  const textSizes: { value: TextSize; label: string }[] = [
    { value: "sm", label: t.settings.textSizeSmall },
    { value: "md", label: t.settings.textSizeMedium },
    { value: "lg", label: t.settings.textSizeLarge },
  ];

  const cycleTheme = () => {
    const next =
      THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
    setTheme(next);
  };

  return (
    <div
      role="menu"
      aria-label={t.header.openControls}
      className="absolute right-0 top-full z-50 mt-2 w-[18rem] max-w-[calc(100vw-1.5rem)] space-y-2 rounded-lg border border-[var(--border)] bg-[var(--card)] p-3 shadow-2xl"
    >
      <button
        type="button"
        onClick={() => {
          onClose();
          onOpenPalette();
        }}
        className="flex w-full items-center gap-2 rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--text)]"
      >
        <Search className="h-4 w-4" aria-hidden="true" />
        {t.header.search}
      </button>
      <button
        type="button"
        onClick={onTogglePanel}
        aria-expanded={isPanelOpen}
        className="flex w-full items-center justify-between rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--text)]"
      >
        <span className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-[var(--accent)]" aria-hidden="true" />
          {t.header.servicesLabel}
        </span>
        <span className="flex items-center gap-1.5 text-xs text-[var(--muted)]">
          <span
            className={`h-2 w-2 rounded-full ${STATUS_DOT[aggregate]}`}
            aria-hidden="true"
          />
        </span>
      </button>
      <label className="block text-xs font-semibold text-[var(--muted)]">
        {t.settings.textSizeLabel}
        <select
          value={textSize}
          onChange={(event) => setTextSize(event.target.value as TextSize)}
          className="mt-1 h-9 w-full rounded-lg border border-[var(--border)] bg-transparent px-2 text-sm text-[var(--text)]"
        >
          {textSizes.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={toggleLanguage}
          aria-label={t.session.toggleLanguage}
          className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border border-[var(--border)] text-sm font-bold uppercase text-[var(--text)]"
        >
          <Globe className="h-4 w-4" aria-hidden="true" />
          {language}
        </button>
        <button
          type="button"
          onClick={cycleTheme}
          aria-label={t.session.toggleTheme}
          className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border border-[var(--border)] text-sm text-[var(--text)]"
        >
          {theme === "system" ? (
            <Monitor className="h-4 w-4" aria-hidden="true" />
          ) : isDark ? (
            <Sun className="h-4 w-4 text-amber-400" aria-hidden="true" />
          ) : (
            <Moon className="h-4 w-4" aria-hidden="true" />
          )}
          {t.header.theme}
        </button>
      </div>
    </div>
  );
};
