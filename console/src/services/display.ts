// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import type { UserIdentity } from "../types";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPAQUE_ID_PATTERN =
  /^(urn:|tenant-|[0-9a-f]{16,}$|[a-z0-9]+[._:-][a-z0-9._:-]+$)/i;

export const SYSTEM_PERSON = "Người dùng hệ thống";

function looksLikeRawId(value: string): boolean {
  return (
    UUID_PATTERN.test(value) ||
    OPAQUE_ID_PATTERN.test(value) ||
    value.includes("/")
  );
}

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim();
}

/**
 * Converts a subject into a label an administrator can understand. Raw
 * identifiers are never shown as names.
 */
export function displayPerson(
  subjectOrId: string | null | undefined,
  identity?: UserIdentity | null
): string {
  const value = normalize(subjectOrId);
  if (!value) return SYSTEM_PERSON;

  if (identity?.subject && identity.subject === value) {
    return SYSTEM_PERSON;
  }

  if (!looksLikeRawId(value)) return value;

  return SYSTEM_PERSON;
}

/** Returns a friendly application label for a name, never the raw id. */
export function displayAppName(appIdOrName: string | null | undefined): string {
  const value = normalize(appIdOrName);
  if (!value) return "Ứng dụng không xác định";
  return looksLikeRawId(value) ? "Ứng dụng không xác định" : value;
}
