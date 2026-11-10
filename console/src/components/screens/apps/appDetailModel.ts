// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import type {
  Application,
  AuditEventEntry,
  CapabilityVersion,
  DirectoryPrincipal,
  StorageSummary,
  TrustGraph,
  TrustGraphEdge,
} from "../../../types";
import { displayPerson } from "../../../services/display";
import { shareStateOf, type ShareState } from "../grants/shareMeta";

export interface AppDetailSources {
  graph: TrustGraph | null;
  capabilities: CapabilityVersion[];
  storage: StorageSummary | null;
  audit: AuditEventEntry[];
  principals: DirectoryPrincipal[];
}

export interface AppShareRow {
  edge: TrustGraphEdge;
  state: ShareState;
}

export interface AppDetailModel {
  ownerUnit: string | null;
  registrant: string;
  approver: string | null;
  approvedAt: string | null;
  providerCapabilities: string[];
  consumerCapabilities: string[];
  shares: AppShareRow[];
  collections: number;
  files: number | null;
}

function personName(
  subject: string | null | undefined,
  principals: DirectoryPrincipal[]
): string {
  if (!subject) return "—";
  const principal = principals.find((item) => item.subject === subject);
  return principal?.displayName ?? displayPerson(subject);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

export function buildAppDetailModel(
  application: Application,
  sources: AppDetailSources
): AppDetailModel {
  const ownerPrincipal = sources.principals.find(
    (item) => item.subject === application.ownerSubject
  );
  const approval = [...sources.audit]
    .filter(
      (event) =>
        event.resourceType === "application" &&
        event.resourceId === application.appId &&
        event.event === "application.approved"
    )
    .sort((left, right) =>
      Date.parse(right.occurredAt) - Date.parse(left.occurredAt)
    )[0];

  const shares = (sources.graph?.edges ?? [])
    .filter(
      (edge) =>
        edge.providerAppId === application.appId ||
        edge.consumerAppId === application.appId
    )
    .map((edge) => ({ edge, state: shareStateOf(edge) }));

  const providerCapabilities = unique(
    sources.capabilities
      .filter(
        (item) => item.manifest.providerAppId === application.appId
      )
      .map((item) => item.manifest.title || item.manifest.capabilityId)
  );

  const consumerCapabilities = unique(
    shares
      .filter((row) => row.edge.consumerAppId === application.appId)
      .map((row) => row.edge.title ?? row.edge.capabilityId)
  );

  const storageApp = sources.storage?.applications.find(
    (item) => item.id === application.appId
  );

  return {
    ownerUnit: ownerPrincipal?.organization ?? null,
    registrant: personName(application.ownerSubject, sources.principals),
    approver: approval
      ? personName(approval.subject, sources.principals)
      : null,
    approvedAt: approval?.occurredAt ?? null,
    providerCapabilities,
    consumerCapabilities,
    shares,
    collections: storageApp?.collections.length ?? 0,
    files: storageApp?.files?.count ?? null,
  };
}
