// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import { ArrowRight, RefreshCw } from "lucide-react";
import { useI18n } from "../../../locales/i18n";
import { usePlatformServices } from "../../../services/platformStatus";
import {
  PLATFORM_FUNCTION_LIST,
  type PlatformFunctionDef,
  type PlatformFunctionId,
} from "../../../constants/platformFunctions";
import { PageHeader } from "../../layout/PageHeader";
import { Badge } from "../../common/Badge";
import { Button } from "../../common/Button";
import { STATUS_DOT, STATUS_TEXT, statusLabel } from "./status";

interface PlatformOverviewProps {
  onOpenService: (serviceId: PlatformFunctionId) => void;
  onOpenDocs: () => void;
}

export const PlatformOverview: React.FC<PlatformOverviewProps> = ({
  onOpenService,
  onOpenDocs,
}) => {
  const { t, language } = useI18n();
  const c = t.platform;
  const { statuses, checking, checkedAt, refresh } = usePlatformServices();

  const checkedTime = checkedAt
    ? new Intl.DateTimeFormat(language === "vi" ? "vi-VN" : "en-GB", {
        hour: "2-digit",
        minute: "2-digit",
      }).format(checkedAt)
    : null;

  const renderGroup = (_label: string, items: PlatformFunctionDef[]) => (
    <section className="space-y-3">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {items.map((fn) => {
          const Icon = fn.icon;
          const item = c.functions[fn.id];
          const status = statuses[fn.id];
          return (
            <button
              key={fn.id}
              type="button"
              onClick={() => onOpenService(fn.id)}
              className="group flex h-full flex-col rounded-md border border-[var(--border)] bg-[var(--card)] p-5 text-left shadow-sm transition-all hover:border-[var(--accent)] hover:shadow-md"
            >
              <div className="flex items-start gap-3">
                <span className={`flex h-11 w-11 items-center justify-center rounded-md ${fn.color}`}>
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="text-base font-semibold text-[var(--text)]">{item.name}</h3>
                  <p className={`mt-1 flex items-center gap-1.5 text-sm font-semibold ${STATUS_TEXT[status]}`}>
                    <span className={`h-2 w-2 rounded-full ${STATUS_DOT[status]}`} aria-hidden="true" />
                    {statusLabel(c, status)}
                  </p>
                </div>
              </div>
              <p className="mt-3 flex-1 text-sm leading-relaxed text-[var(--muted)]">{item.short}</p>
              <span className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-[var(--accent)]">
                {c.whatForYou}
                <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={c.title}
        subtitle={c.subtitle}
        badges={<Badge variant="teal">{c.count}</Badge>}
        actions={
          <>
            <Button variant="outline" size="md" onClick={onOpenDocs}>{c.openDocs}</Button>
            <Button
              variant="outline"
              size="md"
              leftIcon={<RefreshCw className="h-4 w-4" />}
              isLoading={checking}
              onClick={() => void refresh()}
            >
              {checking ? c.checking : c.refresh}
            </Button>
          </>
        }
      />

      <div className="rounded-md border border-[var(--border)] bg-[var(--card)] p-4 text-sm text-[var(--muted)]">
        {c.overviewIntro}
        {checkedTime && <span className="ml-2">{c.lastChecked.replace("{time}", checkedTime)}</span>}
      </div>

      {renderGroup("", PLATFORM_FUNCTION_LIST)}
    </div>
  );
};
