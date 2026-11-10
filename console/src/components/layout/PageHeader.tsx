// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import { ArrowRight } from "lucide-react";
import { useI18n } from "../../locales/i18n";
import { platformFunctionForScreen } from "../../constants/platformFunctions";
import { hashPath, screenFromHash } from "../../services/appRouting";

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  badges?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}

export const PageHeader: React.FC<PageHeaderProps> = ({
  title,
  subtitle,
  badges,
  actions,
  className = "",
}) => {
  const { t } = useI18n();
  const screen = screenFromHash();
  const fn = hashPath()[0] === "platform" ? undefined : platformFunctionForScreen(screen);
  return (
    <div
      className={`pb-5 mb-6 border-b border-slate-200/80 dark:border-[#243843] flex flex-col md:flex-row md:items-center md:justify-between gap-4 ${className}`}
    >
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-stone-ink dark:text-slate-100 font-sans">
            {title}
          </h1>
          {badges && <div className="flex items-center gap-1.5">{badges}</div>}
        </div>
        {subtitle && (
          <p className="text-base text-slate-500 dark:text-slate-400 max-w-3xl leading-relaxed">
            {subtitle}
          </p>
        )}
        {fn && (
          <a
            href={`#/platform/${fn.id}`}
            className="inline-flex items-center gap-1 text-sm font-semibold text-[var(--accent)] hover:underline"
          >
            {t.platform.learnMore}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        )}
      </div>

      {actions && (
        <div className="flex flex-wrap items-center gap-2.5 flex-shrink-0">
          {actions}
        </div>
      )}
    </div>
  );
};
