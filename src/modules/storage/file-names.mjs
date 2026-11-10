// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Pure helpers shared by the read-only storage catalogue. File names are reduced
// to a shape that helps an operator recognise a file type without revealing the
// full name; storage paths are canonicalised before they reach the filer.
const segmenter = new Intl.Segmenter("vi", { granularity: "grapheme" });
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const controlPattern = /[\u0000-\u001f\u007f]/u;
const maxPathLength = 512;
const maxSegmentLength = 255;

export function graphemes(value) {
  return [...segmenter.segment(value)].map((part) => part.segment);
}

export function extensionOf(name) {
  if (typeof name !== "string") return "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot >= name.length - 1) return "";
  const value = name.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,16}$/.test(value) ? value : "";
}

export function maskFileName(name) {
  if (typeof name !== "string" || !name) return "";
  const dot = name.lastIndexOf(".");
  const hasExtension = dot > 0 && dot < name.length - 1;
  const base = hasExtension ? name.slice(0, dot) : name;
  const extension = hasExtension ? name.slice(dot) : "";
  const parts = graphemes(base);
  if (!parts.length) return `…${extension}`;
  if (parts.length <= 5) return `${parts[0]}…${extension}`;
  return `${parts.slice(0, 3).join("")}…${parts.slice(-2).join("")}${extension}`;
}

export function isObjectKeyName(name) {
  return typeof name === "string" && uuidPattern.test(name);
}

export function isSafeEntryName(name) {
  return typeof name === "string" && name.length >= 1 && name.length <= maxSegmentLength &&
    !controlPattern.test(name) && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\");
}

export function normalizeStoragePath(raw) {
  if (raw === undefined || raw === null || raw === "") return "";
  if (typeof raw !== "string" || raw.length > maxPathLength || controlPattern.test(raw) || raw.includes("\\")) return null;
  const trimmed = raw.replace(/^\/+|\/+$/g, "");
  if (!trimmed) return "";
  const segments = trimmed.split("/").map((segment) => segment.normalize("NFC"));
  for (const segment of segments) {
    if (!isSafeEntryName(segment)) return null;
  }
  const value = segments.join("/");
  return value.length <= maxPathLength ? value : null;
}

export function encodeStoragePath(path) {
  if (!path) return "";
  return path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}
