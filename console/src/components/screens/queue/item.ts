// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import type { PendingApprovalItem } from "../../../services/pendingApprovals";
import type { useI18n } from "../../../locales/i18n";

export type QueueStrings = ReturnType<typeof useI18n>["t"]["queue"];
export type QueueFilter = "all" | "application" | "grant";
export type Decision = "approve" | "reject";

export const titleOf = (item: PendingApprovalItem): string =>
  item.kind === "application"
    ? item.displayName
    : item.grant.title ?? item.grant.capabilityId;

export const requesterOf = (item: PendingApprovalItem): string =>
  item.kind === "application"
    ? item.appId
    : `${item.grant.providerAppId} → ${item.grant.consumerAppId}`;

export const purposeOf = (
  item: PendingApprovalItem,
  q: QueueStrings
): string =>
  item.kind === "application"
    ? q.applicationPurpose
    : item.grant.capabilityId;

export const expiresOf = (
  item: PendingApprovalItem,
  q: QueueStrings,
  locale: string
): string =>
  item.kind === "application"
    ? q.noExpiry
    : new Date(item.grant.expiresAt).toLocaleDateString(locale);

export const beforeOf = (item: PendingApprovalItem, q: QueueStrings): string =>
  item.kind === "application" ? q.statePending : q.statePending;

export const afterOf = (item: PendingApprovalItem, q: QueueStrings): string =>
  item.kind === "application" ? q.stateActive : q.stateActive;

export const kindLabel = (item: PendingApprovalItem, q: QueueStrings): string =>
  item.kind === "application" ? q.kindApplication : q.kindGrant;

export const requestedAtOf = (
  item: PendingApprovalItem,
  locale: string
): string => new Date(item.createdAt).toLocaleDateString(locale);
