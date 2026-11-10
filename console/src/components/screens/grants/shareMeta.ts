// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import type { AuditEventEntry, TrustGraphEdge } from "../../../types";
import { displayAppName } from "../../../services/display";
import type { BadgeVariant } from "../../common/Badge";

export type ShareState =
  | "pending"
  | "active"
  | "rejected"
  | "revoked"
  | "expired";

export const SHARE_STATE_ORDER: ShareState[] = [
  "pending",
  "active",
  "rejected",
  "revoked",
  "expired",
];

export const SHARE_BADGE: Record<ShareState, BadgeVariant> = {
  pending: "warning",
  active: "teal",
  rejected: "destructive",
  revoked: "outline",
  expired: "default",
};

export const SHARE_LABEL_KEY = {
  pending: "stateProposed",
  active: "stateActive",
  rejected: "stateRejected",
  revoked: "stateRevoked",
  expired: "stateExpired",
} as const;

/**
 * The API has four grant states. A grant revoked before it was ever activated
 * is a rejected proposal; one revoked after activation is a revoked share.
 */
export function shareStateOf(edge: TrustGraphEdge): ShareState {
  if (edge.state === "revoked") {
    return edge.activatedAt ? "revoked" : "rejected";
  }
  return edge.state;
}

export const capabilityName = (edge: TrustGraphEdge): string =>
  edge.title ?? edge.capabilityId;

export const appName = (
  names: Map<string, string>,
  appId: string
): string => names.get(appId) ?? displayAppName(appId);

export interface ShareActors {
  approver: string | null;
  approvedAt: string | null;
  decider: string | null;
  decidedAt: string | null;
  reason: string | null;
}

function newest(
  events: AuditEventEntry[],
  name: string
): AuditEventEntry | null {
  let found: AuditEventEntry | null = null;
  for (const event of events) {
    if (event.event !== name) continue;
    if (!found || Date.parse(event.occurredAt) >= Date.parse(found.occurredAt)) {
      found = event;
    }
  }
  return found;
}

export function auditByResource(
  events: AuditEventEntry[]
): Map<string, AuditEventEntry[]> {
  const map = new Map<string, AuditEventEntry[]>();
  for (const event of events) {
    if (!event.resourceId) continue;
    const list = map.get(event.resourceId) ?? [];
    list.push(event);
    map.set(event.resourceId, list);
  }
  return map;
}

export function resolveActors(
  edge: TrustGraphEdge,
  events: AuditEventEntry[],
  personName: (subject: string | null | undefined) => string
): ShareActors {
  const activated = newest(events, "grant.activated");
  const revoked = newest(events, "grant.revoked");
  if (shareStateOf(edge) === "pending") {
    return {
      approver: null,
      approvedAt: null,
      decider: null,
      decidedAt: null,
      reason: null,
    };
  }
  if (shareStateOf(edge) === "active" || shareStateOf(edge) === "expired") {
    return {
      approver: activated ? personName(activated.subject) : null,
      approvedAt: activated?.occurredAt ?? edge.activatedAt,
      decider: null,
      decidedAt: null,
      reason: null,
    };
  }
  return {
    approver: activated ? personName(activated.subject) : null,
    approvedAt: activated?.occurredAt ?? edge.activatedAt,
    decider: revoked ? personName(revoked.subject) : null,
    decidedAt: revoked?.occurredAt ?? edge.revokedAt,
    reason: revoked?.reason ?? null,
  };
}
