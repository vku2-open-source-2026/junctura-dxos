// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useEffect, useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { useI18n } from "../../locales/i18n";
import { usePlatformServices } from "../../services/platformStatus";
import {
  PANEL_FUNCTION_LIST,
  PLATFORM_FUNCTIONS,
  type PlatformFunctionDef,
} from "../../constants/platformFunctions";
import type { ModuleId, ScreenId } from "../../constants/modules";
import { STATUS_DOT, statusLabel } from "../screens/platform/status";

interface ServicePanelProps {
  open: boolean;
  onClose: () => void;
  onNavigate: (screen: ScreenId) => void;
  onOpenService: (serviceId: PlatformFunctionDef["id"]) => void;
  onOpenDocs: () => void;
}

export const ServicePanel: React.FC<ServicePanelProps> = ({
  open,
  onClose,
  onNavigate,
  onOpenService,
  onOpenDocs,
}) => {
  const { t } = useI18n();
  const c = t.platform;
  const { statuses, readyCount } = usePlatformServices();
  const [query, setQuery] = useState("");

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return PANEL_FUNCTION_LIST.filter((fn) => {
      if (!needle) return true;
      const text = c.functions[fn.id];
      const chips = PLATFORM_FUNCTIONS[fn.id].screens
        .map((screen) => t.modules[screen as ModuleId]?.label ?? "")
        .join(" ");
      return `${text.name} ${text.short} ${chips}`.toLowerCase().includes(needle);
    });
  }, [query, c, t]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  const openFunction = (fn: PlatformFunctionDef) => {
    if (fn.screens[0]) {
      onNavigate(fn.screens[0]);
    } else {
      onOpenService(fn.id);
    }
    onClose();
  };

  const openSubpage = (screen: ScreenId) => {
    onNavigate(screen);
    onClose();
  };

  return (
    <>
      <div
        className="fixed inset-0 z-30 bg-slate-900/40 backdrop-blur-xs"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        aria-label={c.panelTitle}
        className="fixed bottom-3 right-3 top-[4.75rem] z-40 flex w-[20rem] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--card)] shadow-2xl"
      >
        <div className="border-b border-[var(--border)] p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-[var(--text)]">
                {c.panelTitle}
                <span className="font-normal text-[var(--muted)]">
                  {" · "}
                  {c.panelRunning.replace("{n}", String(readyCount))}
                </span>
              </h2>
              <p className="mt-0.5 text-xs leading-relaxed text-[var(--muted)]">{c.panelHint}</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={c.closePanel}
              title={c.closePanel}
              className="flex-shrink-0 rounded-lg p-1.5 text-[var(--muted)] transition-colors hover:bg-slate-500/10 hover:text-[var(--text)]"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <label className="relative mt-3 block">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--muted)]"
              aria-hidden="true"
            />
            <span className="sr-only">{c.searchPlaceholder}</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={c.searchPlaceholder}
              className="h-9 w-full rounded-md border border-[var(--border)] bg-transparent pl-8 pr-3 text-sm text-[var(--text)] outline-none placeholder:text-[var(--muted)] focus:border-[var(--accent)]"
            />
          </label>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {matches.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-[var(--muted)]">
              {c.noResults}
            </p>
          ) : (
            <div className="space-y-1">
              {matches.map((fn) => {
                const Icon = fn.icon;
                const item = c.functions[fn.id];
                const status = statuses[fn.id];
                return (
                  <section
                    key={fn.id}
                    className="rounded-lg p-2 transition-colors hover:bg-slate-500/5"
                  >
                    <div className="flex items-start gap-3">
                      <span
                        className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg ${fn.color}`}
                      >
                        <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <button
                          type="button"
                          onClick={() => openFunction(fn)}
                          className="block max-w-full truncate text-left text-sm font-semibold text-[var(--text)] hover:text-[var(--accent)]"
                        >
                          {item.name}
                        </button>
                        <p className="text-xs leading-snug text-[var(--muted)]">
                          {item.short}
                        </p>
                        <p className="mt-1 inline-flex items-center gap-1.5 text-xs text-[var(--muted)]">
                          <span
                            className={`h-2 w-2 rounded-full ${STATUS_DOT[status]}`}
                            aria-hidden="true"
                          />
                          {statusLabel(c, status)}
                        </p>
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {fn.screens.map((screen) => (
                        <button
                          key={screen}
                          type="button"
                          onClick={() => openSubpage(screen)}
                          className="rounded-full border border-[var(--border)] px-2 py-0.5 text-xs font-medium text-[var(--text)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
                        >
                          {t.modules[screen as ModuleId]?.label ?? screen}
                        </button>
                      ))}
                      <a
                        href={`#/platform/${fn.id}`}
                        onClick={onClose}
                        className="text-xs font-medium text-[var(--muted)] underline-offset-2 hover:text-[var(--accent)] hover:underline"
                      >
                        {c.introLink}
                      </a>
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-[var(--border)] px-4 py-3 text-xs">
          <span className="font-medium text-[var(--muted)]">{c.tierLabel}</span>
          <button
            type="button"
            onClick={onOpenDocs}
            className="font-semibold text-[var(--accent)] hover:underline"
          >
            {c.docsApi}
          </button>
        </div>
      </aside>
    </>
  );
};
