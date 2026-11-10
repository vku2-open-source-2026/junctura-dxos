// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import { useI18n } from "../../locales/i18n";

type GlossaryKey = keyof ReturnType<typeof useI18n>["t"]["glossary"];

interface TermProps {
  term: GlossaryKey;
  children?: React.ReactNode;
  className?: string;
}

export const Term: React.FC<TermProps> = ({ term, children, className = "" }) => {
  const { t } = useI18n();
  const entry = t.glossary[term];

  return (
    <span className={`group relative inline-flex ${className}`}>
      <span
        tabIndex={0}
        className="cursor-help underline decoration-dotted decoration-1 underline-offset-2 focus:outline-none focus-visible:rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
        aria-label={`${entry.label}: ${entry.description}`}
      >
        {children ?? entry.label}
      </span>
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-0 z-50 mb-1.5 w-64 max-w-[min(16rem,80vw)] rounded-md border border-slate-200 bg-white p-2 text-left text-xs font-normal normal-case leading-relaxed text-slate-600 opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 dark:border-[#243843] dark:bg-[#13242D] dark:text-slate-300"
      >
        {entry.description}
      </span>
    </span>
  );
};
