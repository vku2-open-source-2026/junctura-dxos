// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0

export type MaskKind =
  | "auto"
  | "digest"
  | "uuid"
  | "email"
  | "urn"
  | "client"
  | "origin"
  | "id";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function head(value: string, length: number): string {
  return value.slice(0, length);
}

function tail(value: string, length: number): string {
  return value.slice(-length);
}

export function maskDigest(value: string): string {
  const hex = value.replace(/^sha256:/i, "");
  if (hex.length <= 8) return `sha256 · ${hex}`;
  return `sha256 · ${head(hex, 4)}…${tail(hex, 4)}`;
}

export function maskUuid(value: string): string {
  const compact = value.replace(/-/g, "");
  if (compact.length < 8) return `ID · ${value}`;
  return `ID …${tail(compact, 4)}`;
}

export function maskEmail(value: string): string {
  const at = value.indexOf("@");
  if (at <= 0) return `Email · …${tail(value, 4)}`;
  return `${head(value, 1)}***@…`;
}

export function maskUrn(value: string): string {
  const compact = value.replace(/[^a-z0-9]/gi, "");
  return `URN …${tail(compact, 4)}`;
}

export function maskOrigin(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//…${tail(url.hostname, 4)}`;
  } catch {
    return `Origin · …${tail(value, 4)}`;
  }
}

export function maskClient(value: string): string {
  const compact = value.replace(/[^a-z0-9]/gi, "");
  return `Client · …${tail(compact, 4)}`;
}

export function maskValue(value: string, kind: MaskKind = "auto"): string {
  if (!value) return "—";
  switch (kind) {
    case "digest":
      return maskDigest(value);
    case "uuid":
      return maskUuid(value);
    case "email":
      return maskEmail(value);
    case "urn":
      return maskUrn(value);
    case "client":
      return maskClient(value);
    case "origin":
      return maskOrigin(value);
    case "id":
      return `ID …${tail(value.replace(/-/g, ""), 4)}`;
    default:
      break;
  }
  if (/^sha256:/i.test(value)) return maskDigest(value);
  if (UUID_PATTERN.test(value)) return maskUuid(value);
  if (value.includes("@")) return maskEmail(value);
  if (/^urn:/i.test(value)) return maskUrn(value);
  if (/^https?:\/\//i.test(value)) return maskOrigin(value);
  if (value.length > 12) return `${head(value, 4)}…${tail(value, 4)}`;
  return value;
}
