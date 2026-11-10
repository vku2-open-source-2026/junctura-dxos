// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import type { PlatformStatus } from "../../../services/platformStatus";

export const STATUS_DOT: Record<PlatformStatus, string> = {
  ready: "bg-emerald-500 dark:bg-emerald-400",
  degraded: "bg-amber-500 dark:bg-amber-400",
  error: "bg-rose-600 dark:bg-rose-400",
  unknown: "bg-slate-400 dark:bg-slate-500",
};

export const STATUS_TEXT: Record<PlatformStatus, string> = {
  ready: "text-emerald-700 dark:text-emerald-300",
  degraded: "text-amber-700 dark:text-amber-300",
  error: "text-rose-700 dark:text-rose-300",
  unknown: "text-[var(--muted)]",
};

export function statusLabel(
  t: { statusReady: string; statusDegraded: string; statusError: string; statusUnknown: string },
  status: PlatformStatus
): string {
  if (status === "ready") return t.statusReady;
  if (status === "degraded") return t.statusDegraded;
  if (status === "error") return t.statusError;
  return t.statusUnknown;
}
