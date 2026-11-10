// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import type { TrustGraphEdge } from "../types";
import { api } from "./apiClient";

export function approvalExpiry(now = Date.now()): string {
  return new Date(now + 10 * 60 * 1000).toISOString();
}

export async function approveGrantProposal(
  edge: TrustGraphEdge,
  requesterFallback: string
): Promise<void> {
  const grant = await api.getTrustGrant(edge.grantId);
  const approval = await api.createApproval({
    resourceType: "grant",
    resourceId: grant.grantId,
    resourceDigest: grant.digest,
    resourceRevision: grant.revision,
    requesterSubject: grant.createdBy ?? requesterFallback,
    requesterAppId: edge.providerAppId,
    decision: "approve",
    expiresAt: approvalExpiry(),
  });
  await api.activateTrustGrant(
    grant.grantId,
    approval.approvalId,
    grant.revision
  );
}

export async function rejectGrantProposal(
  edge: TrustGraphEdge,
  reason: string
): Promise<void> {
  const trimmed = reason.trim();
  if (!trimmed) throw new Error("reason_required");
  await api.revokeTrustGrant(edge, trimmed);
}
