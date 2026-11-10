// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useState } from "react";
import { AppWindow, ChevronUp } from "lucide-react";
import { useI18n } from "../../../locales/i18n";
import {
  PLATFORM_CORE_FUNCTIONS,
  PLATFORM_EXTENDED_FUNCTIONS,
  type PlatformFunctionId,
} from "../../../constants/platformFunctions";

type Selected = PlatformFunctionId | "tier2";

export const PlatformLayersDiagram: React.FC = () => {
  const { t } = useI18n();
  const c = t.landing;
  const [selected, setSelected] = useState<Selected>("tier2");
  const selectedText =
    selected === "tier2"
      ? c.layerTier2Desc
      : t.platform.functions[selected].short;
  const selectedLabel =
    selected === "tier2" ? c.layerTier2 : t.platform.functions[selected].name;

  const pick = (next: Selected) => ({
    onMouseEnter: () => setSelected(next),
    onFocus: () => setSelected(next),
    onClick: () => setSelected(next),
  });

  const block = (label: string, description: string, tier: Selected, index: number) => (
    <button
      key={tier}
      type="button"
      {...pick(tier)}
      aria-pressed={selected === tier}
      className={`rounded-md border px-3 py-2 text-left transition-all ${
        selected === tier
          ? "border-[var(--accent)] bg-[var(--card)] shadow-md"
          : "border-slate-200 bg-white/70 hover:border-slate-300 dark:border-[#243843] dark:bg-[#13242D]/70"
      }`}
      style={{ animationDelay: `${index * 40}ms` }}
    >
      <span className="block text-sm font-semibold text-stone-ink dark:text-slate-100">{label}</span>
      <span className="mt-0.5 block text-xs leading-snug text-slate-500 dark:text-slate-400">{description}</span>
    </button>
  );

  return (
    <div className="rounded-md border border-slate-200/80 bg-white p-4 shadow-sm dark:border-[#243843] dark:bg-[#13242D] sm:p-6">
      <div className="mx-auto max-w-2xl">
        <button
          type="button"
          {...pick("tier2")}
          aria-pressed={selected === "tier2"}
          className={`flex w-full items-center justify-center gap-2 rounded-md border px-4 py-3 text-sm font-semibold transition-all ${
            selected === "tier2"
              ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)] shadow-md"
              : "border-slate-200 bg-slate-50 text-stone-ink dark:border-[#243843] dark:bg-[#1B303B] dark:text-slate-100"
          }`}
        >
          <AppWindow className="h-4 w-4" aria-hidden="true" />
          {c.layerTier2}
          <ChevronUp className="h-3.5 w-3.5 opacity-60" aria-hidden="true" />
        </button>

        <div className="flex flex-col items-center py-1.5" aria-hidden="true">
          <span className="h-4 w-px bg-slate-300 dark:bg-slate-600" />
          <span className="rounded-full bg-[var(--accent-soft)] px-2.5 py-0.5 text-[0.625rem] font-bold uppercase tracking-wide text-[var(--accent)]">
            {c.layersGateway}
          </span>
          <span className="h-4 w-px bg-slate-300 dark:bg-slate-600" />
        </div>

        <div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {PLATFORM_EXTENDED_FUNCTIONS.map((fn, index) =>
              block(t.platform.functions[fn.id].name, t.platform.functions[fn.id].short, fn.id, index)
            )}
          </div>
        </div>

        <div className="mt-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {PLATFORM_CORE_FUNCTIONS.map((fn, index) =>
              block(t.platform.functions[fn.id].name, t.platform.functions[fn.id].short, fn.id, index + 3)
            )}
          </div>
        </div>
      </div>

      <div className="mx-auto mt-4 max-w-2xl rounded-md bg-slate-50 p-3 text-sm dark:bg-slate-900/50" role="status" aria-live="polite">
        <span className="text-[0.625rem] font-bold uppercase tracking-wider text-slate-400">{c.layersCardLabel}</span>
        <p className="font-semibold text-stone-ink dark:text-slate-100">{selectedLabel}</p>
        <p className="text-slate-600 dark:text-slate-300">{selectedText}</p>
      </div>
      <p className="mt-2 text-center text-xs text-slate-500 dark:text-slate-400">{c.layersHint}</p>
    </div>
  );
};
