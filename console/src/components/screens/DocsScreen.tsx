// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useEffect, useState } from "react";
import { BookOpen, ChevronLeft, ChevronRight, Code2 } from "lucide-react";
import { useI18n } from "../../locales/i18n";
import type { DocsGroupId, DocsSectionId } from "../../types/docs";
import { PageHeader } from "../layout/PageHeader";
import { DocsBlocks } from "./DocsBlocks";
import { ApiDocsScreen } from "./ApiDocsScreen";

interface NavGroup {
  id: DocsGroupId;
  sections: DocsSectionId[];
}

const NAV_GROUPS: NavGroup[] = [
  { id: "start", sections: ["quickStart"] },
  { id: "roles", sections: ["roleAdmin", "roleAppManager", "roleAuditor"] },
  {
    id: "concepts",
    sections: [
      "conceptApplication",
      "conceptCapability",
      "conceptPermission",
      "conceptTwoPerson",
      "conceptConsent",
      "conceptEmergency",
      "conceptHashChain",
    ],
  },
  { id: "help", sections: ["tryIt", "faq"] },
];

const SECTION_ORDER: DocsSectionId[] = NAV_GROUPS.flatMap(
  (group) => group.sections
);

type DocsView = "guide" | "api";

function isSectionId(value: string): value is DocsSectionId {
  return (SECTION_ORDER as string[]).includes(value);
}

function sectionFromHash(): DocsSectionId {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const parts = raw.split("?")[0].split("/").filter(Boolean);
  const segment = parts[0] === "docs" ? parts[1] ?? "" : parts[0] ?? "";
  if (segment === "getting-started") return "quickStart";
  if (segment === "api-explorer") return "quickStart";
  return isSectionId(segment) ? segment : "quickStart";
}

function viewFromHash(): DocsView {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const parts = raw.split("?")[0].split("/").filter(Boolean);
  return parts[0] === "docs" && parts[1] === "api" ? "api" : "guide";
}

function operationFromHash(): string | null {
  const hash = window.location.hash;
  const queryIndex = hash.indexOf("?");
  if (queryIndex < 0) return null;
  return new URLSearchParams(hash.slice(queryIndex + 1)).get("op");
}

export const DocsScreen: React.FC = () => {
  const { t } = useI18n();
  const copy = t.docs.apiDocs;
  const [view, setView] = useState<DocsView>(viewFromHash);
  const [active, setActive] = useState<DocsSectionId>(sectionFromHash);

  useEffect(() => {
    const handleHashChange = () => {
      setView(viewFromHash());
      setActive(sectionFromHash());
    };
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  const selectSection = (section: DocsSectionId) => {
    setView("guide");
    setActive(section);
    window.history.replaceState(null, "", `#/docs/${section}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const selectView = (next: DocsView) => {
    setView(next);
    if (next === "api") {
      window.history.replaceState(null, "", "#/docs/api");
    } else {
      window.history.replaceState(null, "", `#/docs/${active}`);
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const section = t.docs.sections[active];
  const sectionIndex = SECTION_ORDER.indexOf(active);
  const previous = sectionIndex > 0 ? SECTION_ORDER[sectionIndex - 1] : null;
  const next =
    sectionIndex >= 0 && sectionIndex < SECTION_ORDER.length - 1
      ? SECTION_ORDER[sectionIndex + 1]
      : null;

  const primaryClass = (selected: boolean) =>
    `flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors ${
      selected
        ? "bg-[#E8F3F5] font-semibold text-[#176B80] dark:bg-[#1B303B] dark:text-[var(--accent)]"
        : "text-slate-600 hover:bg-slate-100/80 hover:text-stone-ink dark:text-slate-400 dark:hover:bg-[#1B303B]/50 dark:hover:text-slate-200"
    }`;

  return (
    <div>
      {view === "guide" && (
        <PageHeader
          title={t.docs.title}
          subtitle={t.docs.subtitle}
        />
      )}

      <div className="mb-4 flex gap-2 lg:hidden">
        <button
          type="button"
          onClick={() => selectView("guide")}
          aria-pressed={view === "guide"}
          className={primaryClass(view === "guide")}
        >
          <BookOpen className="h-4 w-4" aria-hidden="true" />
          {copy.navGuide}
        </button>
        <button
          type="button"
          onClick={() => selectView("api")}
          aria-pressed={view === "api"}
          className={primaryClass(view === "api")}
        >
          <Code2 className="h-4 w-4" aria-hidden="true" />
          {copy.navApi}
        </button>
      </div>

      {view === "guide" && (
        <div className="mb-4 lg:hidden">
          <label className="block">
            <span className="sr-only">{t.docs.navLabel}</span>
            <select
              value={active}
              onChange={(event) =>
                selectSection(event.target.value as DocsSectionId)
              }
              aria-label={t.docs.navLabel}
              className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-stone-ink focus:outline-none focus:ring-1 focus:ring-junctura-blue dark:border-[#243843] dark:bg-[#13242D] dark:text-slate-100"
            >
              {NAV_GROUPS.map((group) => (
                <optgroup key={group.id} label={t.docs.groups[group.id]}>
                  {group.sections.map((id) => (
                    <option key={id} value={id}>
                      {t.docs.sections[id].title}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <nav
          aria-label={t.docs.navLabel}
          className="hidden lg:block lg:sticky lg:top-6 lg:self-start"
        >
          <div className="space-y-4 rounded-md border border-slate-200/80 bg-white p-4 dark:border-[#243843] dark:bg-[#13242D]">
            <div>
              <div className="mb-1.5 px-2 text-sm font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                {copy.navGroup}
              </div>
              <ul className="space-y-0.5">
                <li>
                  <button
                    type="button"
                    onClick={() => selectView("guide")}
                    aria-current={view === "guide" ? "page" : undefined}
                    className={primaryClass(view === "guide")}
                  >
                    <BookOpen className="h-4 w-4" aria-hidden="true" />
                    {copy.navGuide}
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => selectView("api")}
                    aria-current={view === "api" ? "page" : undefined}
                    className={primaryClass(view === "api")}
                  >
                    <Code2 className="h-4 w-4" aria-hidden="true" />
                    {copy.navApi}
                  </button>
                </li>
              </ul>
            </div>

            {view === "guide" && (
              <div className="space-y-4 border-t border-slate-100 pt-3 dark:border-[#243843]/70">
                {NAV_GROUPS.map((group) => (
                  <div key={group.id}>
                    <h3 className="mb-1.5 px-2 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                      {t.docs.groups[group.id]}
                    </h3>
                    <ul className="space-y-0.5">
                      {group.sections.map((id) => {
                        const selected = active === id;
                        return (
                          <li key={id}>
                            <button
                              type="button"
                              onClick={() => selectSection(id)}
                              aria-current={selected ? "page" : undefined}
                              className={`w-full rounded px-2 py-1.5 text-left text-sm transition-colors ${
                                selected
                                  ? "bg-[#E8F3F5] font-semibold text-[#176B80] dark:bg-[#1B303B] dark:text-[var(--accent)]"
                                  : "text-slate-600 hover:bg-slate-100/80 hover:text-stone-ink dark:text-slate-400 dark:hover:bg-[#1B303B]/50 dark:hover:text-slate-200"
                              }`}
                            >
                              {t.docs.sections[id].title}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>
        </nav>

        <article className="min-w-0">
          {view === "api" ? (
            <ApiDocsScreen initialOperationId={operationFromHash()} />
          ) : (
            <>
              <div className="rounded-md border border-slate-200/80 bg-white p-5 dark:border-[#243843] dark:bg-[#13242D]">
                <h2 className="text-lg font-bold tracking-tight text-stone-ink dark:text-slate-100">
                  {section.title}
                </h2>
                {section.intro && (
                  <p className="mt-1.5 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
                    {section.intro}
                  </p>
                )}
                <div className="mt-5">
                  <DocsBlocks blocks={section.blocks} />
                </div>
              </div>

              <div className="mt-4 flex items-center justify-between gap-3">
                {previous ? (
                  <button
                    type="button"
                    onClick={() => selectSection(previous)}
                    className="inline-flex max-w-[48%] items-center gap-1.5 rounded border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:border-junctura-blue hover:text-junctura-blue dark:border-[#243843] dark:text-slate-300 dark:hover:border-[var(--accent)] dark:hover:text-[var(--accent)]"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
                    <span className="truncate">
                      {t.docs.previous}: {t.docs.sections[previous].title}
                    </span>
                  </button>
                ) : (
                  <span />
                )}
                {next ? (
                  <button
                    type="button"
                    onClick={() => selectSection(next)}
                    className="inline-flex max-w-[48%] items-center gap-1.5 rounded border border-slate-200 px-3 py-1.5 text-right text-sm text-slate-600 hover:border-junctura-blue hover:text-junctura-blue dark:border-[#243843] dark:text-slate-300 dark:hover:border-[var(--accent)] dark:hover:text-[var(--accent)]"
                  >
                    <span className="truncate">
                      {t.docs.next}: {t.docs.sections[next].title}
                    </span>
                    <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                ) : (
                  <span />
                )}
              </div>
            </>
          )}
        </article>
      </div>
    </div>
  );
};
