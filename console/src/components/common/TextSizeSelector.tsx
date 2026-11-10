// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import { useI18n } from "../../locales/i18n";
import { useTheme } from "../../services/themeContext";
import type { TextSize } from "../../types";

interface TextSizeSelectorProps {
  compact?: boolean;
  className?: string;
}

const OPTIONS: { value: TextSize; preview: string }[] = [
  { value: "sm", preview: "text-sm" },
  { value: "md", preview: "text-base" },
  { value: "lg", preview: "text-lg" },
];

export const TextSizeSelector: React.FC<TextSizeSelectorProps> = ({
  compact = false,
  className = "",
}) => {
  const { t } = useI18n();
  const { textSize, setTextSize } = useTheme();
  const s = t.settings;

  const labels: Record<TextSize, string> = {
    sm: s.textSizeSmall,
    md: s.textSizeMedium,
    lg: s.textSizeLarge,
  };

  if (compact) {
    return (
      <label
        className={`flex items-center gap-1.5 rounded-md px-1.5 py-1 text-slate-600 transition-colors hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800 ${className}`}
        title={s.textSizeLabel}
      >
        <span
          aria-hidden="true"
          className="hidden text-sm font-bold leading-none sm:inline"
        >
          Aa
        </span>
        <select
          value={textSize}
          onChange={(event) => setTextSize(event.target.value as TextSize)}
          aria-label={s.textSizeLabel}
          className="cursor-pointer rounded border border-slate-200 bg-transparent py-0.5 pl-1 pr-0.5 text-sm font-medium text-slate-600 focus:outline-none focus-visible:ring-1 focus-visible:ring-[#176B80] dark:border-[#243843] dark:text-slate-200"
        >
          {OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {labels[option.value]}
            </option>
          ))}
        </select>
      </label>
    );
  }

  return (
    <div className={className}>
      <span className="mb-1 block text-sm font-semibold text-stone-ink dark:text-slate-200">
        {s.textSizeLabel}
      </span>
      <p className="mb-2 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
        {s.textSizeHint}
      </p>
      <div
        role="group"
        aria-label={s.textSizeLabel}
        className="flex flex-wrap gap-3"
      >
        {OPTIONS.map((option) => {
          const active = textSize === option.value;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => setTextSize(option.value)}
              aria-pressed={active}
              className={`flex items-center gap-2 rounded-md border px-3.5 py-2 text-sm font-medium transition-all cursor-pointer ${
                active
                  ? "border-[#176B80] bg-[#E8F3F5] text-[#176B80] shadow-sm dark:border-[var(--accent)] dark:bg-[#1B303B] dark:text-[var(--accent)]"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-[#243843] dark:bg-[#1B303B]/40 dark:text-slate-300 dark:hover:bg-[#1B303B]"
              }`}
            >
              <span
                aria-hidden="true"
                className={`${option.preview} font-bold leading-none`}
              >
                Aa
              </span>
              <span>{labels[option.value]}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
