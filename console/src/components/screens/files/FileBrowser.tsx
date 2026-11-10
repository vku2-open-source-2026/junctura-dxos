// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Folder,
  LayoutGrid,
  List,
} from "lucide-react";
import type {
  StorageApplication,
  StorageFileListing,
} from "../../../types";
import { ApiError, api } from "../../../services/apiClient";
import { useI18n } from "../../../locales/i18n";
import { Button } from "../../common/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../../common/Card";
import { EmptyState } from "../../common/EmptyState";
import { ErrorState } from "../../common/ErrorState";
import { LoadingSkeleton } from "../../common/LoadingSkeleton";
import { FileListing } from "./FileListing";
import {
  appendPath,
  pathFromSegments,
  pathSegments,
  sortFiles,
  sortFolders,
  type FileSortKey,
} from "./fileMeta";

interface FileBrowserProps {
  app: StorageApplication;
}

type BrowserError = "permission" | "generic" | null;

export const FileBrowser: React.FC<FileBrowserProps> = ({ app }) => {
  const { t, language } = useI18n();
  const f = t.files;
  const [path, setPath] = useState("/");
  const [listing, setListing] = useState<StorageFileListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<BrowserError>(null);
  const [retryToken, setRetryToken] = useState(0);
  const [view, setView] = useState<"table" | "grid">("table");
  const [sortKey, setSortKey] = useState<FileSortKey>("name");
  const [ascending, setAscending] = useState(true);

  const locale = language === "vi" ? "vi-VN" : "en-US";
  const number = (value: number) =>
    new Intl.NumberFormat(locale).format(value);
  const collator = useMemo(
    () => new Intl.Collator(locale, { sensitivity: "base", numeric: true }),
    [locale]
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setListing(null);
    api
      .getStorageFiles(app.id, path)
      .then((data) => {
        if (!cancelled) setListing(data);
      })
      .catch((failure: unknown) => {
        if (cancelled) return;
        setError(
          failure instanceof ApiError && failure.status === 403
            ? "permission"
            : "generic"
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [app.id, path, retryToken]);

  const segments = pathSegments(path);
  const folders = useMemo(
    () =>
      sortFolders(listing?.folders ?? [], sortKey, ascending, collator),
    [listing, sortKey, ascending, collator]
  );
  const files = useMemo(
    () => sortFiles(listing?.files ?? [], sortKey, ascending, collator),
    [listing, sortKey, ascending, collator]
  );
  const empty = listing !== null && folders.length === 0 && files.length === 0;

  return (
    <Card className="min-w-0">
      <CardHeader className="flex-wrap items-start gap-3">
        <div className="min-w-0">
          <CardTitle>{listing?.application.name || app.name}</CardTitle>
          <p className="mt-1 text-sm text-[var(--muted)]">{f.browserHint}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label={f.viewLabel}
            className="inline-flex overflow-hidden rounded border border-[var(--border)]"
          >
            <button
              type="button"
              onClick={() => setView("table")}
              aria-pressed={view === "table"}
              aria-label={f.viewTable}
              className={`p-1.5 ${
                view === "table"
                  ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                  : "text-[var(--muted)] hover:bg-[var(--accent-soft)]/50"
              }`}
            >
              <List className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => setView("grid")}
              aria-pressed={view === "grid"}
              aria-label={f.viewGrid}
              className={`p-1.5 ${
                view === "grid"
                  ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                  : "text-[var(--muted)] hover:bg-[var(--accent-soft)]/50"
              }`}
            >
              <LayoutGrid className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>

          <label className="flex items-center gap-1.5 text-sm text-[var(--muted)]">
            <span className="sr-only">{f.sortLabel}</span>
            <select
              value={sortKey}
              onChange={(event) =>
                setSortKey(event.target.value as FileSortKey)
              }
              aria-label={f.sortLabel}
              className="rounded border border-[var(--border)] bg-[var(--card)] px-2 py-1 text-sm text-[var(--text)]"
            >
              <option value="name">{f.sortName}</option>
              <option value="size">{f.sortSize}</option>
              <option value="date">{f.sortDate}</option>
            </select>
          </label>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => setAscending((current) => !current)}
            aria-label={ascending ? f.sortAscending : f.sortDescending}
            leftIcon={
              ascending ? (
                <ArrowUp className="h-4 w-4" aria-hidden="true" />
              ) : (
                <ArrowDown className="h-4 w-4" aria-hidden="true" />
              )
            }
          >
            <span className="sr-only">
              {ascending ? f.sortAscending : f.sortDescending}
            </span>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <nav
          aria-label={f.breadcrumbLabel}
          className="flex flex-wrap items-center gap-1 text-sm"
        >
          <button
            type="button"
            onClick={() => setPath("/")}
            aria-current={segments.length === 0 ? "page" : undefined}
            className={`rounded px-1.5 py-0.5 font-medium ${
              segments.length === 0
                ? "text-[var(--text)]"
                : "text-[var(--accent)] hover:underline"
            }`}
          >
            {f.rootCrumb}
          </button>
          {segments.map((segment, index) => {
            const last = index === segments.length - 1;
            return (
              <React.Fragment key={`${segment}-${index}`}>
                <ChevronRight
                  className="h-3.5 w-3.5 text-[var(--muted)]"
                  aria-hidden="true"
                />
                <button
                  type="button"
                  onClick={() =>
                    setPath(pathFromSegments(segments.slice(0, index + 1)))
                  }
                  aria-current={last ? "page" : undefined}
                  className={`max-w-[14rem] truncate rounded px-1.5 py-0.5 ${
                    last
                      ? "font-medium text-[var(--text)]"
                      : "text-[var(--accent)] hover:underline"
                  }`}
                >
                  {segment}
                </button>
              </React.Fragment>
            );
          })}
        </nav>

        {loading ? (
          <div>
            <p className="sr-only">{f.folderLoading}</p>
            <LoadingSkeleton rows={5} />
          </div>
        ) : error ? (
          <ErrorState
            title={
              error === "permission"
                ? f.folderPermissionTitle
                : f.folderErrorTitle
            }
            message={
              error === "permission"
                ? f.folderPermissionDesc
                : f.folderErrorDesc
            }
            onRetry={() => setRetryToken((token) => token + 1)}
          />
        ) : empty ? (
          <EmptyState
            title={f.folderEmptyTitle}
            description={f.folderEmptyDesc}
            icon={<Folder className="h-6 w-6" aria-hidden="true" />}
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-[var(--muted)]">
              <span>
                {f.folderSummary
                  .replace("{folders}", number(folders.length))
                  .replace("{files}", number(files.length))}
              </span>
              {listing?.truncated && <span>{f.truncated}</span>}
            </div>
            <FileListing
              folders={folders}
              files={files}
              view={view}
              onOpenFolder={(name) => setPath(appendPath(path, name))}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
};
