// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ScreenId as ModuleScreenId } from "../constants/modules";

export type ScreenId = ModuleScreenId;

export type Language = "vi" | "en";
export type Theme = "light" | "dark" | "system";
export type TextSize = "sm" | "md" | "lg";

export interface HealthStatus {
  service: string;
  status: "ok" | "degraded" | "error" | "unknown";
  timestamp?: string;
  latencyMs?: number;
}

export interface ReadyStatus {
  status: "ready" | "not_ready" | "unknown";
  timestamp?: string;
  latencyMs?: number;
  dependencies?: {
    identity: boolean;
    data: boolean;
    objects: boolean;
    workflow: boolean;
  };
}

export interface UserIdentity {
  subject: string;
  tenantId: string;
  roles: string[];
  clientId?: string;
  issuer?: string;
  preferredUsername?: string;
}

export type IdentityStatus =
  | "loading"
  | "authenticated"
  | "missing"
  | "rejected"
  | "forbidden"
  | "unavailable"
  | "timeout";

export interface IdentityState {
  status: IdentityStatus;
  identity?: UserIdentity;
  message?: string;
}

export type ApplicationState = "pending" | "active" | "suspended" | "revoked";

export interface Application {
  appId: string;
  tenantId: string;
  ownerSubject: string;
  displayName: string;
  oauthClientId: string;
  providerOrigin: string;
  state: ApplicationState;
  revision: number;
  digest: string;
  createdAt: string;
  updatedAt: string;
  lastApprovalId?: string;
}

export interface Approval {
  approvalId: string;
  resourceType: "application" | "grant";
  resourceId: string;
  resourceDigest: string;
  resourceRevision: number;
  requesterSubject: string;
  requesterAppId: string;
  decision: "approve" | "deny";
  expiresAt: string;
  consumed: boolean;
  consumedAt?: string;
  revoked: boolean;
  revokeReason?: string;
  createdAt: string;
}

export interface StorageCollection {
  name: string;
  records: number;
  updatedAt: string | null;
}

export interface StorageFiles {
  count: number;
  bytes: number;
  quarantined: number;
  updatedAt: string | null;
}

export interface StorageApplication {
  id: string;
  name: string;
  state: ApplicationState;
  collections: StorageCollection[];
  files: StorageFiles | null;
}

export interface StorageSummary {
  applications: StorageApplication[];
  totals: {
    collections: StorageCollection[];
    files: StorageFiles | null;
  };
}

export type StorageFieldType =
  | "string"
  | "number"
  | "boolean"
  | "object"
  | "array"
  | "mixed"
  | "null";

export interface StorageField {
  name: string;
  type: StorageFieldType;
  fillRate: number;
}

export interface StorageCollectionStructure {
  name: string;
  records: number;
  updatedAt: string | null;
  fields: StorageField[];
}

export interface StorageCollections {
  application: { id: string; name: string };
  collections: StorageCollectionStructure[];
}

export type StorageFileStatus = "clean" | "quarantined" | "unknown";

export interface StorageFolderEntry {
  name: string;
  files: number;
  bytes: number;
  updatedAt: string | null;
}

export interface StorageFileEntry {
  name: string;
  extension: string;
  bytes: number;
  status: StorageFileStatus;
  updatedAt: string | null;
}

export interface StorageFileListing {
  application: { id: string; name: string };
  path: string;
  folders: StorageFolderEntry[];
  files: StorageFileEntry[];
  truncated: boolean;
}

export interface WorkflowDefinition {
  id: string;
  key: string;
  version: number;
  name: string;
  description?: string;
}

export interface WorkflowExecution {
  id: string;
  definitionId: string;
  definitionKey?: string;
  status: "running" | "completed" | "cancelled";
  startTime: string;
  endTime?: string;
  input?: Record<string, unknown>;
  activeTaskId?: string;
  activeTaskName?: string;
}

export interface WorkflowExecutionDefinition {
  id: string | null;
  key: string | null;
  name: string | null;
  version: number | null;
}

export interface WorkflowExecutionStep {
  name: string | null;
  assignee: string | null;
  groups: string[];
}

export interface WorkflowExecutionSummary {
  id: string;
  definition: WorkflowExecutionDefinition;
  status: WorkflowExecution["status"];
  startedAt: string | null;
  updatedAt: string | null;
  title: string | null;
  currentStep: WorkflowExecutionStep | null;
}

export interface WorkflowSummaryApplication {
  id: string;
  name: string;
}

export interface WorkflowSummaryStep {
  name: string;
  owner: string | null;
}

export interface WorkflowSummaryCounts {
  running: number;
  completed: number;
  cancelled: number;
}

export interface WorkflowSummaryDefinition {
  key: string;
  name: string;
  application: WorkflowSummaryApplication | null;
  steps: WorkflowSummaryStep[];
  counts: WorkflowSummaryCounts;
  updatedAt: string | null;
}

export interface WorkflowSummaryTotals extends WorkflowSummaryCounts {
  definitions: number;
}

export interface WorkflowSummary {
  definitions: WorkflowSummaryDefinition[];
  totals: WorkflowSummaryTotals;
}

export type CapabilityState = "draft" | "published" | "deprecated" | "revoked";

export interface CapabilityManifest {
  manifestVersion?: string;
  capabilityId: string;
  providerAppId: string;
  version: string;
  title: string;
  description?: string;
  timeoutMs?: number;
  sideEffects?: { kind?: string };
}

export interface CapabilityVersion {
  manifest: CapabilityManifest;
  state: CapabilityState;
  revision: number;
  digest: string;
}

export interface AuditChainBreak {
  chainSeq: number;
  eventId: string | null;
  reason: "content_modified" | "chain_link_mismatch" | "missing_entry" | "head_mismatch";
}

export interface AuditVerification {
  verified: boolean;
  entries: number;
  newlySealed: number;
  headHash: string | null;
  firstBreak: AuditChainBreak | null;
  verifiedAt: string;
}

export interface AuditEventEntry {
  eventId: string;
  occurredAt: string;
  event: string;
  outcome: string;
  tenantId?: string;
  schemaVersion?: string;
  resourceType?: string | null;
  resourceId?: string | null;
  revision?: number | null;
  actorAppId?: string | null;
  issuer?: string | null;
  subject?: string | null;
  managementClient?: string | null;
  reasonCode?: string | null;
  reason?: string | null;
}

export interface AuditEventPage {
  items: AuditEventEntry[];
  nextCursor: string | null;
}

export type TrustGrantState = "pending" | "active" | "expired" | "revoked";

export interface TrustGraphNode {
  appId: string;
  displayName: string;
  state: ApplicationState;
  owned: boolean;
}

export interface TrustGraphEdge {
  grantId: string;
  providerAppId: string;
  consumerAppId: string;
  capabilityId: string;
  version: string;
  title: string | null;
  operations: Array<"discover" | "invoke">;
  revision: number;
  state: TrustGrantState;
  createdAt: string;
  activatedAt: string | null;
  revokedAt: string | null;
  expiresAt: string;
}

export interface TrustGraph {
  scope: "tenant" | "owned";
  nodes: TrustGraphNode[];
  edges: TrustGraphEdge[];
  truncated: boolean;
  generatedAt: string;
}

export interface TrustGrant {
  grantId: string;
  tenantId: string;
  state: TrustGrantState;
  revision: number;
  digest: string;
  createdBy?: string;
  createdAt?: string;
  activatedAt?: string | null;
  revokedAt?: string | null;
}

export interface SubjectConsent {
  consentId: string;
  consumer: { appId: string; displayName: string | null };
  capabilityId: string;
  capabilityTitle: string | null;
  purposes: string[];
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  state: "active" | "expired" | "revoked";
}

export interface EmergencyAccess {
  executionId: string;
  state: "pending" | "justified" | "unjustified";
  accessedAt: string;
  purpose: string;
  justification: string;
  executionState: string;
  consumer: { appId: string; displayName: string | null };
  provider: { appId: string; displayName: string | null };
  capability: { capabilityId: string; version: string };
  note: string | null;
  reviewedAt: string | null;
}

export interface SecretMetadata {
  name: string;
  version: number | string;
  present: true;
}

export interface TrafficBucket {
  at: string;
  requests: number;
  errors4xx: number;
  errors5xx: number;
  avgLatencyMs: number;
  maxLatencyMs: number;
}

export interface TrafficTotals {
  requests: number;
  errors4xx: number;
  errors5xx: number;
  avgLatencyMs: number;
  maxLatencyMs: number;
}

export interface TrafficSeries {
  from: string;
  to: string;
  intervalSeconds: number;
  buckets: TrafficBucket[];
  totals: TrafficTotals;
}

export interface FeatureBucket {
  at: string;
  requests: number;
}

export interface FeatureMetric {
  feature: string;
  requests: number;
  errors4xx: number;
  errors5xx: number;
  avgLatencyMs: number;
  maxLatencyMs: number;
  series: FeatureBucket[];
}

export interface FeatureSeries {
  from: string;
  to: string;
  features: FeatureMetric[];
}

export interface RecentRequest {
  at: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
}

export type DirectoryPrincipalKind = "admin" | "application";

export interface DirectoryPrincipal {
  subject: string;
  issuer: string;
  managementClient: string;
  permissions: string[];
  enabled: boolean;
  displayName: string | null;
  organization: string | null;
  jobTitle: string | null;
  kind: DirectoryPrincipalKind | null;
}

export interface DirectoryPrincipalsPage {
  items: DirectoryPrincipal[];
  truncated: boolean;
}

export type DirectoryNodeKind = "platform" | "organization" | "application";

export interface DirectoryNode {
  id: string;
  name: string;
  kind: DirectoryNodeKind;
  children: DirectoryNode[];
}

export interface DirectoryRelation {
  from: string;
  to: string;
  label: string;
}

export interface DirectoryTree {
  root: DirectoryNode;
  relations: DirectoryRelation[];
  truncated: boolean;
}
