// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useReducer } from "react";
import { ArrowRight, Check, RotateCcw } from "lucide-react";
import { useI18n } from "../../locales/i18n";
import { Button } from "../common/Button";
import {
  LIFECYCLE_STATES,
  appLifecycleReducer,
  initialAppLifecycleState,
} from "./appLifecycleModel";
import { APP_LIFECYCLE_STRINGS } from "./appLifecycle.i18n";

export const AppLifecycleSim: React.FC<{ className?: string }> = ({ className = "" }) => {
  const { language } = useI18n();
  const s = APP_LIFECYCLE_STRINGS[language];
  const [state, dispatch] = useReducer(appLifecycleReducer, undefined, initialAppLifecycleState);
  const currentIndex = LIFECYCLE_STATES.indexOf(state.status);
  const selfBlocked = state.status === "pending" && state.actor === "requester";

  return (
    <section className={`rounded-md border border-[var(--border)] bg-[var(--card)] p-5 ${className}`}>
      <header className="mb-4">
        <h3 className="text-lg font-semibold text-[var(--text)]">{s.title}</h3>
        <p className="text-sm text-slate-600 dark:text-slate-300">{s.subtitle}</p>
      </header>

      <ol className="mb-4 grid grid-cols-1 gap-1 sm:grid-cols-5" aria-label={s.title}>
        {LIFECYCLE_STATES.map((status, index) => {
          const active = state.status === status;
          const done = index < currentIndex;
          return (
            <li
              key={status}
              aria-current={active ? "step" : undefined}
              className={`relative flex items-center gap-2 rounded-md border px-2.5 py-2 text-sm ${
                active
                  ? "border-[var(--accent)] bg-[var(--accent)]/10 font-semibold text-[var(--accent)]"
                  : done
                    ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200"
                    : "border-slate-200 text-slate-500 dark:border-slate-700 dark:text-slate-400"
              }`}
            >
              <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-current text-xs font-bold">
                {done ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : index + 1}
              </span>
              <span className="min-w-0 text-xs leading-tight">{s.states[status]}</span>
              {index < LIFECYCLE_STATES.length - 1 && (
                <ArrowRight className="absolute -right-2 top-1/2 hidden h-3.5 w-3.5 -translate-y-1/2 text-slate-400 sm:block" aria-hidden="true" />
              )}
            </li>
          );
        })}
      </ol>

      <div className="grid gap-4 lg:grid-cols-[1fr_17rem]">
        <div className="space-y-3">
          <div className="rounded-md border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900/40">
            <p className="text-sm font-semibold text-[var(--text)]">{s.appName}</p>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{s.stateHelp[state.status]}</p>
            <svg viewBox="0 0 360 70" className="mt-3 h-auto w-full" role="img" aria-label={s.diagramLabel(s.states[state.status])}>
              <rect x="8" y="14" width="124" height="42" rx="10" className="fill-slate-100 stroke-slate-300 dark:fill-slate-800 dark:stroke-slate-600" />
              <text x="70" y="40" textAnchor="middle" fontSize="12" fontWeight="600" className="fill-slate-700 dark:fill-slate-200">{s.appName}</text>
              <line x1="136" y1="35" x2="222" y2="35" stroke={state.status === "suspended" ? "#DC2626" : "#0F9F8F"} strokeWidth="2.5" strokeDasharray={state.status === "suspended" ? "7 5" : undefined} />
              {state.status === "suspended" && <circle cx="179" cy="35" r="7" fill="#DC2626" />}
              <rect x="226" y="14" width="124" height="42" rx="10" className="fill-[#172F3D] dark:fill-[#2F4A57]" />
              <text x="288" y="40" textAnchor="middle" fontSize="12" fontWeight="600" fill="#fff">{s.junctura}</text>
            </svg>
            {state.status === "suspended" && (
              <p className="mt-1 text-xs font-semibold text-rose-700 dark:text-rose-300">{s.blockedCalls}</p>
            )}
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">{s.logTitle}</p>
          {state.log.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">{s.logEmpty}</p>
          ) : (
            <ul className="space-y-1">
              {state.log.map((entry) => (
                <li key={entry.id} className={`rounded-md px-2.5 py-1.5 text-sm ${entry.kind === "selfApprovalBlocked" ? "bg-rose-50 text-rose-800 dark:bg-rose-950/30 dark:text-rose-200" : "bg-slate-50 text-slate-700 dark:bg-slate-800/60 dark:text-slate-200"}`}>
                  {s.log[entry.kind]}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="space-y-3">
          <fieldset>
            <legend className="text-sm font-semibold text-[var(--text)]">{s.actorTitle}</legend>
            <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={s.actorTitle}>
              {(["requester", "approver"] as const).map((actor) => (
                <button
                  key={actor}
                  type="button"
                  aria-pressed={state.actor === actor}
                  onClick={() => dispatch({ type: "setActor", actor })}
                  className={`rounded-full border px-3 py-1 text-sm ${state.actor === actor ? "border-rose-600 bg-rose-600 text-white" : "border-slate-300 text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"}`}
                >
                  {s.actors[actor]}
                </button>
              ))}
            </div>
          </fieldset>

          <div className="flex flex-col gap-2">
            {state.status === "proposed" && <Button size="sm" variant="primary" onClick={() => dispatch({ type: "propose" })}>{s.propose}</Button>}
            {state.status === "pending" && (
              <>
                <Button
                  size="sm"
                  variant="teal"
                  disabled={selfBlocked}
                  aria-describedby={selfBlocked ? "lifecycle-self-blocked" : undefined}
                  onClick={() => dispatch({ type: "approve", byRequester: state.actor === "requester" })}
                >
                  {s.approve}
                </Button>
                {selfBlocked && <p id="lifecycle-self-blocked" className="text-xs text-rose-700 dark:text-rose-300">{s.selfBlocked}</p>}
              </>
            )}
            {state.status === "active" && <Button size="sm" variant="outline" onClick={() => dispatch({ type: "suspend" })}>{s.suspend}</Button>}
            {state.status === "suspended" && <Button size="sm" variant="primary" onClick={() => dispatch({ type: "reactivate" })}>{s.reactivate}</Button>}
            {state.status !== "revoked" && <Button size="sm" variant="destructive" onClick={() => dispatch({ type: "revoke" })}>{s.revoke}</Button>}
            <Button size="sm" variant="ghost" leftIcon={<RotateCcw className="h-4 w-4" aria-hidden="true" />} onClick={() => dispatch({ type: "reset" })}>{s.reset}</Button>
          </div>
        </div>
      </div>
    </section>
  );
};

export default AppLifecycleSim;
