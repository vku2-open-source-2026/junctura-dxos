// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import { Globe, Moon, Sun } from "lucide-react";
import { useI18n } from "../../locales/i18n";
import { useTheme } from "../../services/themeContext";
import { TextSizeSelector } from "./TextSizeSelector";

interface PublicControlsProps {
  className?: string;
}

export const PublicControls: React.FC<PublicControlsProps> = ({
  className = "",
}) => {
  const { language, toggleLanguage, t } = useI18n();
  const { isDark, toggleTheme } = useTheme();

  return (
    <div className={`flex items-center gap-1 ${className}`}>
      <TextSizeSelector compact />
      <button
        type="button"
        onClick={toggleLanguage}
        className="flex items-center gap-1 rounded-md p-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
        title={t.session.switchLanguage}
        aria-label={t.session.toggleLanguage}
      >
        <Globe className="h-4 w-4" aria-hidden="true" />
        <span className="text-xs font-bold uppercase">{language}</span>
      </button>
      <button
        type="button"
        onClick={toggleTheme}
        className="rounded-md p-2 text-slate-600 transition-colors hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
        title={isDark ? t.session.lightTheme : t.session.darkTheme}
        aria-label={t.session.toggleTheme}
      >
        {isDark ? (
          <Sun className="h-4 w-4 text-amber-400" aria-hidden="true" />
        ) : (
          <Moon className="h-4 w-4" aria-hidden="true" />
        )}
      </button>
    </div>
  );
};
