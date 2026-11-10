// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import type {
  StorageFileEntry,
  StorageFolderEntry,
} from "../../../types";

export type FileSortKey = "name" | "size" | "date";

export type FileKind =
  | "text"
  | "image"
  | "sheet"
  | "archive"
  | "audio"
  | "video"
  | "other";

export function formatBytes(bytes: number, locale: string): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );
  const value = bytes / 1024 ** index;
  return `${new Intl.NumberFormat(locale, {
    maximumFractionDigits: value < 10 ? 1 : 0,
  }).format(value)} ${units[index]}`;
}

export function formatTimestamp(
  value: string | null,
  dateFormat: Intl.DateTimeFormat,
  fallback: string
): string {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return dateFormat.format(date);
}

export function fileKind(extension: string): FileKind {
  const ext = extension.toLowerCase();
  if (["txt", "md", "pdf", "doc", "docx", "rtf", "odt"].includes(ext)) {
    return "text";
  }
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tif", "tiff"].includes(ext)) {
    return "image";
  }
  if (["csv", "xls", "xlsx", "ods"].includes(ext)) return "sheet";
  if (["zip", "rar", "7z", "tar", "gz", "bz2"].includes(ext)) return "archive";
  if (["mp3", "wav", "ogg", "m4a", "flac"].includes(ext)) return "audio";
  if (["mp4", "mov", "avi", "mkv", "webm"].includes(ext)) return "video";
  return "other";
}

function compareNullableDate(a: string | null, b: string | null): number {
  const left = a ? new Date(a).getTime() : 0;
  const right = b ? new Date(b).getTime() : 0;
  return left - right;
}

export function sortFolders(
  folders: StorageFolderEntry[],
  key: FileSortKey,
  ascending: boolean,
  collator: Intl.Collator
): StorageFolderEntry[] {
  const direction = ascending ? 1 : -1;
  return [...folders].sort((a, b) => {
    let result = 0;
    if (key === "name") result = collator.compare(a.name, b.name);
    else if (key === "size") result = a.bytes - b.bytes;
    else result = compareNullableDate(a.updatedAt, b.updatedAt);
    if (result === 0) result = collator.compare(a.name, b.name);
    return result * direction;
  });
}

export function sortFiles(
  files: StorageFileEntry[],
  key: FileSortKey,
  ascending: boolean,
  collator: Intl.Collator
): StorageFileEntry[] {
  const direction = ascending ? 1 : -1;
  return [...files].sort((a, b) => {
    let result = 0;
    if (key === "name") result = collator.compare(a.name, b.name);
    else if (key === "size") result = a.bytes - b.bytes;
    else result = compareNullableDate(a.updatedAt, b.updatedAt);
    if (result === 0) result = collator.compare(a.name, b.name);
    return result * direction;
  });
}

export function pathSegments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

export function appendPath(path: string, name: string): string {
  const segments = pathSegments(path);
  return `/${[...segments, name].join("/")}`;
}

export function pathFromSegments(segments: string[]): string {
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}
