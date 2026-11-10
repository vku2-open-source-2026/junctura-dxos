// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useEffect, useState } from "react";
import { ArrowRight, BookOpen, ChevronLeft, Eye, EyeOff, RefreshCw } from "lucide-react";
import { useI18n } from "../../../locales/i18n";
import { usePlatformServices } from "../../../services/platformStatus";
import { useSession } from "../../../services/session";
import {
  PLATFORM_FUNCTIONS,
  type PlatformFunctionId,
} from "../../../constants/platformFunctions";
import {
  getModule,
  type ModuleId,
  type ScreenId,
} from "../../../constants/modules";
import { PageHeader } from "../../layout/PageHeader";
import { Badge, type BadgeVariant } from "../../common/Badge";
import { Button } from "../../common/Button";
import { STATUS_DOT, statusLabel } from "./status";
import { WorkflowSim } from "../../explainers/WorkflowSim";
import { AppLifecycleSim } from "../../explainers/AppLifecycleSim";

interface PlatformDetailProps {
  serviceId: PlatformFunctionId;
  onBack: () => void;
  onNavigate: (screen: ScreenId) => void;
  onOpenDocs: () => void;
}

const EXPLAINERS: Partial<Record<PlatformFunctionId, React.FC<{ className?: string }>>> = {
  workflows: WorkflowSim,
  "app-management": AppLifecycleSim,
};

function introStorageKey(id: PlatformFunctionId): string {
  return `junctura_platform_intro_hidden_${id}`;
}

function readIntroHidden(id: PlatformFunctionId): boolean {
  try {
    return localStorage.getItem(introStorageKey(id)) === "1";
  } catch {
    return false;
  }
}

export const PlatformDetail: React.FC<PlatformDetailProps> = ({
  serviceId,
  onBack,
  onNavigate,
  onOpenDocs,
}) => {
  const { t } = useI18n();
  const c = t.platform;
  const { can } = useSession();
  const fn = PLATFORM_FUNCTIONS[serviceId];
  const item = c.functions[serviceId];
  const Icon = fn.icon;
  const Explain = EXPLAINERS[serviceId];
  const { statuses, checking, refresh, health, ready, checkedAt } =
    usePlatformServices();
  const status = statuses[serviceId];
  const [introHidden, setIntroHidden] = useState(() => readIntroHidden(serviceId));

  useEffect(() => {
    setIntroHidden(readIntroHidden(serviceId));
  }, [serviceId]);

  const toggleIntro = () => {
    setIntroHidden((previous) => {
      const next = !previous;
      try {
        localStorage.setItem(introStorageKey(serviceId), next ? "1" : "0");
      } catch {
        // The current tab still remembers the choice.
      }
      return next;
    });
  };

  const statusVariant: BadgeVariant =
    status === "ready"
      ? "teal"
      : status === "degraded"
        ? "warning"
        : status === "error"
          ? "destructive"
          : "outline";

  const screens = fn.screens.filter((screen) => {
    const module = getModule(screen);
    return !module?.perm || can(module.perm);
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <button
            type="button"
            onClick={onBack}
            aria-label={c.title}
            className="mt-1 rounded-md border border-[var(--border)] p-2 text-[var(--muted)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </button>
          <span className={`flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-md ${fn.color}`}>
            <Icon className="h-7 w-7" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <PageHeader
              title={item.name}
              subtitle={item.short}
              badges={
                <>
                  <Badge variant={statusVariant}>{statusLabel(c, status)}</Badge>
                </>
              }
              className="mb-0 border-0 pb-0"
            />
          </div>
        </div>
        <div className="flex flex-shrink-0 flex-wrap items-center gap-2">
          {Explain && <Button
            variant="outline"
            size="md"
            leftIcon={introHidden ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
            onClick={toggleIntro}
          >
            {introHidden ? c.showExplainer : c.hideExplainer}
          </Button>}
          <Button
            variant="outline"
            size="md"
            isLoading={checking}
            leftIcon={<RefreshCw className="h-4 w-4" />}
            onClick={() => void refresh()}
          >
            {checking ? c.checking : c.refresh}
          </Button>
        </div>
      </div>

      {Explain && !introHidden && (
        <div>
          <Explain />
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <section className="rounded-md border border-[var(--border)] bg-[var(--card)] p-5">
            <h2 className="text-sm font-semibold text-[var(--text)]">{c.whatTitle}</h2>
            <p className="mt-1 text-sm leading-relaxed text-[var(--muted)]">{item.what}</p>
          </section>

          {screens.length > 0 && (
            <section className="rounded-md border border-[var(--border)] bg-[var(--card)] p-5">
              <h2 className="text-sm font-semibold text-[var(--text)]">{c.youCanDo}</h2>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {screens.map((screen) => {
                  const module = getModule(screen);
                  const RelatedIcon = module?.icon ?? BookOpen;
                  const label =
                    screen === "docs"
                      ? t.docs.title
                      : t.modules[screen as ModuleId]?.label ?? screen;
                  return (
                    <button
                      key={screen}
                      type="button"
                      onClick={() => onNavigate(screen)}
                      className="flex items-center gap-2 rounded-md border border-[var(--border)] px-3 py-2 text-left text-sm text-[var(--text)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
                    >
                      <RelatedIcon className="h-4 w-4" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate">{c.openSubpage.replace("{name}", label)}</span>
                      <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          <section className="rounded-md border border-amber-200 bg-amber-50/50 p-5 dark:border-amber-900/50 dark:bg-amber-950/20">
            <h2 className="text-sm font-semibold text-amber-900 dark:text-amber-200">{c.careTitle}</h2>
            <p className="mt-1 text-sm leading-relaxed text-amber-900/80 dark:text-amber-200/80">{item.care}</p>
          </section>
        </div>

        <div className="space-y-4">
          <div className="rounded-md border border-[var(--border)] bg-[var(--card)] p-5">
            <h2 className="text-sm font-semibold text-[var(--text)]">{c.statsTitle}</h2>
            <div className="mt-3 space-y-3">
              <div className="flex items-baseline justify-between gap-3 border-b border-[var(--border)] pb-2">
                <p className="text-sm text-[var(--muted)]">{c.healthLabel}</p>
                <p className="text-lg font-semibold text-[var(--text)]">
                  {health?.status ?? "unknown"}
                </p>
              </div>
              <div className="flex items-baseline justify-between gap-3 border-b border-[var(--border)] pb-2">
                <p className="text-sm text-[var(--muted)]">{c.readyLabel}</p>
                <p className="text-lg font-semibold text-[var(--text)]">
                  {ready?.status ?? "unknown"}
                </p>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-sm text-[var(--muted)]">{c.latencyLabel}</p>
                <p className="text-lg font-semibold text-[var(--text)]">
                  {health?.latencyMs !== undefined
                    ? `${health.latencyMs} ms`
                    : "—"}
                </p>
              </div>
            </div>
            <p className="mt-4 flex items-center gap-1.5 text-sm text-[var(--muted)]">
              <span className={`h-2 w-2 rounded-full ${STATUS_DOT[status]}`} aria-hidden="true" />
              {statusLabel(c, status)}
              {checkedAt && (
                <span className="ml-1">
                  {c.lastChecked.replace(
                    "{time}",
                    checkedAt.toLocaleTimeString()
                  )}
                </span>
              )}
            </p>
          </div>

          <button
            type="button"
            onClick={onOpenDocs}
            className="text-sm font-medium text-[var(--accent)] hover:underline"
          >
            {c.developerLink}
          </button>
        </div>
      </div>
    </div>
  );
};
