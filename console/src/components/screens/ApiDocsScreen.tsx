// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useEffect, useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";
import {
  API_DOC_GROUPS,
  matchesApiDoc,
  type ApiDocsGroupId,
} from "../../constants/apiDocsData";
import type { ApiDocEndpoint } from "../../constants/apiReferenceData";
import { api } from "../../services/apiClient";
import { useI18n } from "../../locales/i18n";
import { Badge } from "../common/Badge";
import { Button } from "../common/Button";
import { Card } from "../common/Card";
import { EmptyState } from "../common/EmptyState";
import { SearchFilterBar } from "../common/SearchFilterBar";
import { ApiDocsRow } from "./ApiDocsRow";

function fill(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replace(`{${key}}`, String(value)),
    template,
  );
}

function operationFromHash(): string | null {
  const hash = window.location.hash;
  const queryIndex = hash.indexOf("?");
  if (queryIndex < 0) return null;
  return new URLSearchParams(hash.slice(queryIndex + 1)).get("op");
}

function currentBaseUrl(): string {
  const configured = api.getBaseUrl().replace(/\/+$/, "");
  if (!configured || configured === "/") return window.location.origin;
  if (configured.startsWith("http://") || configured.startsWith("https://")) {
    return configured;
  }
  return `${window.location.origin}${configured.startsWith("/") ? "" : "/"}${configured}`;
}

interface ApiDocsScreenProps {
  initialOperationId?: string | null;
}

export const ApiDocsScreen: React.FC<ApiDocsScreenProps> = ({
  initialOperationId = null,
}) => {
  const { t, language } = useI18n();
  const copy = t.docs.apiDocs;
  const [query, setQuery] = useState("");
  const [baseUrl] = useState(currentBaseUrl);
  const [baseCopied, setBaseCopied] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(
    initialOperationId ?? operationFromHash(),
  );

  useEffect(() => {
    const handleHashChange = () => setExpanded(operationFromHash());
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  useEffect(() => {
    if (!operationFromHash()) {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, []);

  useEffect(() => {
    if (!expanded) return;
    const row = document.getElementById(`api-doc-${expanded}`);
    if (typeof row?.scrollIntoView === "function") {
      row.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [expanded]);

  const groups = useMemo(
    () =>
      API_DOC_GROUPS.map((group) => ({
        id: group.id,
        endpoints: group.endpoints.filter((endpoint) =>
          matchesApiDoc(endpoint, query, language),
        ),
      })).filter((group) => group.endpoints.length > 0),
    [query, language],
  );

  const resultCount = groups.reduce(
    (total, group) => total + group.endpoints.length,
    0,
  );

  const groupLabel = (id: ApiDocsGroupId): string => copy.groups[id];

  const toggleEndpoint = (endpoint: ApiDocEndpoint) => {
    const next = expanded === endpoint.operationId ? null : endpoint.operationId;
    setExpanded(next);
    window.history.replaceState(
      null,
      "",
      next
        ? `#/docs/api?op=${encodeURIComponent(next)}`
        : "#/docs/api",
    );
  };

  const scrollToGroup = (id: ApiDocsGroupId) => {
    const target = document.getElementById(`api-docs-group-${id}`);
    if (typeof target?.scrollIntoView === "function") {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const handleCopyBase = async () => {
    try {
      await navigator.clipboard.writeText(baseUrl);
      setBaseCopied(true);
      setTimeout(() => setBaseCopied(false), 2000);
    } catch {
      // Clipboard may be unavailable; the value remains visible for manual copy.
    }
  };

  return (
    <div className="space-y-4">
      <header>
        <p className="text-xs font-semibold uppercase tracking-wider text-[#176B80] dark:text-[var(--accent)]">
          {copy.eyebrow}
        </p>
        <h1 className="mt-1 text-3xl font-bold tracking-tight text-stone-ink dark:text-slate-100 md:text-4xl">
          {copy.title}
        </h1>
        <p className="mt-1.5 max-w-3xl text-base leading-relaxed text-slate-500 dark:text-slate-400">
          {copy.subtitle}
        </p>
      </header>

      <Card>
        <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-sm font-semibold text-stone-ink dark:text-slate-100">
              {copy.baseUrlTitle}
            </h2>
            <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
              {copy.baseUrlDesc}
            </p>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <code className="min-w-0 flex-1 break-words rounded border border-slate-200 bg-slate-50 px-2.5 py-1.5 font-mono text-sm text-stone-ink dark:border-[#243843] dark:bg-[#1B303B] dark:text-slate-200 sm:flex-none">
              {baseUrl}
            </code>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void handleCopyBase()}
              aria-label={copy.copyBaseUrl}
              leftIcon={
                baseCopied ? (
                  <Check className="h-3.5 w-3.5 text-teal-500" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )
              }
            >
              {baseCopied ? t.common.copied : t.common.copy}
            </Button>
          </div>
        </div>
      </Card>

      <SearchFilterBar
        searchQuery={query}
        onSearchChange={setQuery}
        placeholder={copy.searchPlaceholder}
        rightAction={
          <Badge variant="outline">
            {fill(copy.results, { count: resultCount })}
          </Badge>
        }
      />

      {groups.length > 0 && (
        <nav
          aria-label={copy.groupNav}
          className="sticky top-16 z-20 -mx-1 overflow-x-auto border-y border-slate-200/70 bg-[var(--bg)]/95 px-1 py-2 backdrop-blur dark:border-[#243843]"
        >
          <div className="flex w-max gap-1.5">
            {groups.map((group) => (
              <button
                key={group.id}
                type="button"
                onClick={() => scrollToGroup(group.id)}
                className="whitespace-nowrap rounded-full border border-slate-200 bg-white px-3 py-1 text-sm font-medium text-slate-600 transition-colors hover:border-[#176B80] hover:text-[#176B80] dark:border-[#243843] dark:bg-[#13242D] dark:text-slate-300 dark:hover:border-[var(--accent)] dark:hover:text-[var(--accent)]"
              >
                {groupLabel(group.id)} ·{" "}
                {fill(copy.groupCount, { count: group.endpoints.length })}
              </button>
            ))}
          </div>
        </nav>
      )}

      {groups.length === 0 ? (
        <EmptyState title={copy.emptyTitle} description={copy.emptyDesc} />
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <section
              key={group.id}
              id={`api-docs-group-${group.id}`}
              aria-labelledby={`api-docs-heading-${group.id}`}
              className="scroll-mt-24 space-y-2.5"
            >
              <div className="flex items-center justify-between gap-3">
                <h2
                  id={`api-docs-heading-${group.id}`}
                  className="text-base font-semibold text-stone-ink dark:text-slate-100"
                >
                  {groupLabel(group.id)}
                </h2>
                <span className="flex-shrink-0 text-sm text-slate-400 dark:text-slate-500">
                  {fill(copy.groupCount, { count: group.endpoints.length })}
                </span>
              </div>
              <div className="space-y-2">
                {group.endpoints.map((endpoint) => (
                  <ApiDocsRow
                    key={`${endpoint.method}-${endpoint.path}`}
                    endpoint={endpoint}
                    expanded={expanded === endpoint.operationId}
                    onToggle={() => toggleEndpoint(endpoint)}
                    baseUrl={baseUrl}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
};
