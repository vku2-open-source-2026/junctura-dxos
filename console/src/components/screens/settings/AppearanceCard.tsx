// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import { Globe, Laptop, Moon, Sun } from "lucide-react";
import { useI18n } from "../../../locales/i18n";
import { useTheme } from "../../../services/themeContext";
import { Card, CardContent, CardHeader, CardTitle } from "../../common/Card";
import { TextSizeSelector } from "../../common/TextSizeSelector";

export const AppearanceCard: React.FC = () => {
  const { t, language, setLanguage } = useI18n();
  const { theme, setTheme } = useTheme();
  const s = t.settings;

  const languageButtonClass = (active: boolean) =>
    `px-4 py-2 rounded-md border text-sm font-semibold transition-all cursor-pointer ${
      active
        ? "bg-[#176B80] text-white border-[#176B80] shadow-sm"
        : "bg-white dark:bg-[#1B303B]/40 border-slate-200 dark:border-[#243843] text-slate-700 dark:text-slate-300 hover:bg-slate-50"
    }`;

  const themeButtonClass = (active: boolean) =>
    `flex items-center gap-2 px-3.5 py-1.5 rounded-md border text-sm font-medium cursor-pointer ${
      active
        ? "bg-slate-100 dark:bg-slate-800 border-slate-400 text-stone-ink dark:text-slate-100 font-semibold"
        : "border-slate-200 dark:border-[#243843] text-slate-600 dark:text-slate-400"
    }`;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Globe className="h-5 w-5 text-teal-600 dark:text-teal-400" />
          <CardTitle>{s.appearanceSectionTitle}</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-sm leading-relaxed text-slate-500 dark:text-slate-400">
          {s.appearanceSectionDesc}
        </p>

        <div>
          <span className="mb-2 block text-sm font-semibold text-stone-ink dark:text-slate-200">
            {s.languageLabel}
          </span>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => setLanguage("vi")}
              className={languageButtonClass(language === "vi")}
            >
              {s.languageVi}
            </button>
            <button
              type="button"
              onClick={() => setLanguage("en")}
              className={languageButtonClass(language === "en")}
            >
              {s.languageEn}
            </button>
          </div>
        </div>

        <div>
          <span className="mb-2 block text-sm font-semibold text-stone-ink dark:text-slate-200">
            {s.themeLabel}
          </span>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => setTheme("light")}
              className={themeButtonClass(theme === "light")}
            >
              <Sun className="h-4 w-4 text-amber-500" />
              <span>{s.lightTheme}</span>
            </button>
            <button
              type="button"
              onClick={() => setTheme("dark")}
              className={themeButtonClass(theme === "dark")}
            >
              <Moon className="h-4 w-4 text-sky-400" />
              <span>{s.darkTheme}</span>
            </button>
            <button
              type="button"
              onClick={() => setTheme("system")}
              className={themeButtonClass(theme === "system")}
            >
              <Laptop className="h-4 w-4" />
              <span>{s.systemTheme}</span>
            </button>
          </div>
        </div>

        <TextSizeSelector className="border-t border-slate-100 pt-4 dark:border-[#243843]/70" />
      </CardContent>
    </Card>
  );
};
