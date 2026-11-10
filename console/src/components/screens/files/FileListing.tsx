// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useMemo } from "react";
import { Folder } from "lucide-react";
import type {
  StorageFileEntry,
  StorageFileStatus,
  StorageFolderEntry,
} from "../../../types";
import { useI18n } from "../../../locales/i18n";
import { Badge, type BadgeVariant } from "../../common/Badge";
import { FileTypeIcon } from "./FileTypeIcon";
import { formatBytes, formatTimestamp } from "./fileMeta";

const STATUS_VARIANT: Record<StorageFileStatus, BadgeVariant> = {
  clean: "success",
  quarantined: "warning",
  unknown: "default",
};

interface FileListingProps {
  folders: StorageFolderEntry[];
  files: StorageFileEntry[];
  view: "table" | "grid";
  onOpenFolder: (name: string) => void;
}

export const FileListing: React.FC<FileListingProps> = ({
  folders,
  files,
  view,
  onOpenFolder,
}) => {
  const { t, language } = useI18n();
  const f = t.files;
  const locale = language === "vi" ? "vi-VN" : "en-US";
  const number = (value: number) =>
    new Intl.NumberFormat(locale).format(value);
  const dateFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: "short",
        timeStyle: "short",
      }),
    [locale]
  );

  const statusLabel = (status: StorageFileStatus): string =>
    status === "clean"
      ? f.statusClean
      : status === "quarantined"
        ? f.statusQuarantined
        : f.statusUnknown;

  const typeLabel = (extension: string): string =>
    extension ? extension.toUpperCase() : f.unknownType;

  const updatedLabel = (value: string | null): string =>
    formatTimestamp(value, dateFormat, f.neverUpdated);

  if (view === "grid") {
    return (
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {folders.map((folder) => (
          <li key={`folder-${folder.name}`} className="min-w-0">
            <button
              type="button"
              onClick={() => onOpenFolder(folder.name)}
              aria-label={f.openFolder.replace("{name}", folder.name)}
              className="flex h-full w-full flex-col gap-2 rounded-md border border-[var(--border)] bg-[var(--card)] p-3 text-left transition-colors hover:border-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              <span className="flex min-w-0 items-center gap-2">
                <Folder
                  className="h-5 w-5 flex-shrink-0 text-[var(--accent)]"
                  aria-hidden="true"
                />
                <span className="min-w-0 break-words text-sm font-semibold text-[var(--text)]">
                  {folder.name}
                </span>
              </span>
              <span className="text-xs text-[var(--muted)]">
                {f.folderFiles.replace("{n}", number(folder.files))}
              </span>
              <span className="flex flex-wrap justify-between gap-2 text-xs text-[var(--muted)]">
                <span>{formatBytes(folder.bytes, locale)}</span>
                <span>{updatedLabel(folder.updatedAt)}</span>
              </span>
            </button>
          </li>
        ))}
        {files.map((file) => (
          <li key={`file-${file.name}`} className="min-w-0">
            <div className="flex h-full flex-col gap-2 rounded-md border border-[var(--border)] bg-[var(--card)] p-3">
              <div className="flex min-w-0 items-start gap-2">
                <FileTypeIcon
                  extension={file.extension}
                  className="mt-0.5 h-5 w-5 flex-shrink-0 text-[var(--muted)]"
                />
                <span className="min-w-0 break-words text-sm font-semibold text-[var(--text)]">
                  {file.name}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
                <span>{typeLabel(file.extension)}</span>
                <span>{formatBytes(file.bytes, locale)}</span>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Badge variant={STATUS_VARIANT[file.status]}>
                  {statusLabel(file.status)}
                </Badge>
                <span className="text-xs text-[var(--muted)]">
                  {updatedLabel(file.updatedAt)}
                </span>
              </div>
            </div>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[44rem] text-sm">
        <caption className="sr-only">{f.browserTitle}</caption>
        <thead>
          <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--muted)]">
            <th scope="col" className="px-2 py-2 font-semibold">
              {f.colName}
            </th>
            <th scope="col" className="px-2 py-2 font-semibold">
              {f.colType}
            </th>
            <th scope="col" className="px-2 py-2 text-right font-semibold">
              {f.colSize}
            </th>
            <th scope="col" className="px-2 py-2 font-semibold">
              {f.colStatus}
            </th>
            <th scope="col" className="px-2 py-2 font-semibold">
              {f.colUpdated}
            </th>
          </tr>
        </thead>
        <tbody>
          {folders.map((folder) => (
            <tr
              key={`folder-${folder.name}`}
              className="border-b border-[var(--border)]/60"
            >
              <th scope="row" className="px-2 py-2 text-left font-medium">
                <button
                  type="button"
                  onClick={() => onOpenFolder(folder.name)}
                  aria-label={f.openFolder.replace("{name}", folder.name)}
                  className="flex min-w-0 items-center gap-2 text-left text-[var(--text)] hover:text-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                >
                  <Folder
                    className="h-4 w-4 flex-shrink-0 text-[var(--accent)]"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 break-words">{folder.name}</span>
                </button>
                <span className="mt-0.5 block text-xs font-normal text-[var(--muted)]">
                  {f.folderFiles.replace("{n}", number(folder.files))}
                </span>
              </th>
              <td className="px-2 py-2 text-xs text-[var(--muted)]">
                {f.folderType}
              </td>
              <td className="whitespace-nowrap px-2 py-2 text-right text-xs text-[var(--text)]">
                {formatBytes(folder.bytes, locale)}
              </td>
              <td className="px-2 py-2 text-xs text-[var(--muted)]">—</td>
              <td className="whitespace-nowrap px-2 py-2 text-xs text-[var(--muted)]">
                {updatedLabel(folder.updatedAt)}
              </td>
            </tr>
          ))}
          {files.map((file) => (
            <tr
              key={`file-${file.name}`}
              className="border-b border-[var(--border)]/60 last:border-0"
            >
              <th scope="row" className="px-2 py-2 text-left font-medium">
                <span className="flex min-w-0 items-center gap-2">
                  <FileTypeIcon
                    extension={file.extension}
                    className="h-4 w-4 flex-shrink-0 text-[var(--muted)]"
                  />
                  <span className="min-w-0 break-words text-[var(--text)]">
                    {file.name}
                  </span>
                </span>
              </th>
              <td className="px-2 py-2 text-xs text-[var(--muted)]">
                {typeLabel(file.extension)}
              </td>
              <td className="whitespace-nowrap px-2 py-2 text-right text-xs text-[var(--text)]">
                {formatBytes(file.bytes, locale)}
              </td>
              <td className="px-2 py-2">
                <Badge variant={STATUS_VARIANT[file.status]}>
                  {statusLabel(file.status)}
                </Badge>
              </td>
              <td className="whitespace-nowrap px-2 py-2 text-xs text-[var(--muted)]">
                {updatedLabel(file.updatedAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
