// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type CapabilityReference = { capabilityId: string; version: string; manifestDigest: string };
export type CapabilityCatalogItem = {
  capabilityId: string; versionId: string; providerAppId: string; version: string; digest: string;
  state: 'published'; visibility: 'tenant' | 'units' | 'applications' | 'hidden';
  title: string; description: string; publishedAt: string; myAccess: 'none' | 'requested' | 'granted';
  manifest?: JsonObject;
};
export type CapabilityAccessRequestCreate = { capabilityId: string; version: string; purpose: string };
export type CapabilityAccessRequestState = 'pending' | 'withdrawn' | 'declined' | 'accepted';
export type CapabilityAccessRequest = CapabilityAccessRequestCreate & {
  requestId: string; providerAppId: string; consumerAppId: string; manifestDigest: string;
  state: CapabilityAccessRequestState; reason: string | null; grantId: string | null;
  createdAt: string; updatedAt: string;
};
export type ExecutionTarget = { kind: 'capability'; capability: CapabilityReference }
  | { kind: 'composition'; compositionId: string; version: string; compositionDigest: string };
export type Execution = { executionId: string; state: 'accepted' | 'running' | 'auth_required' | 'succeeded' | 'failed' | 'timed_out' | 'outcome_unknown' | 'cancelled'; output?: Json; [key: string]: unknown };
export type ExecutionContext = { purpose: string; dataSubject?: string; emergency?: boolean; justification?: string };
export type RequestOptions = { method?: string; json?: Json; body?: BodyInit; contentType?: string; ifMatch?: string; idempotencyKey?: string; lockId?: string; signal?: AbortSignal };
export type TicketContext = { active: false } | { active: true; context: { tenantId: string; executionId: string; purpose?: string; dataSubject?: string; emergency?: boolean; [key: string]: unknown }; [key: string]: unknown };

export type VersionedRecord = { id: string; collection: string; created_at: string; version: number; data: JsonObject };
export type CompatibilityRecord = { id: string; collection: string; created_at: string; data: JsonObject };
export type VersionedRecordResult = { record: VersionedRecord; etag: string | null };
export type CompatibilityRecordResult = { record: CompatibilityRecord; etag: string | null };
export type VersionedRecordPage = { items: VersionedRecord[]; nextCursor: string | null };
export type CompatibilityRecordPage = { items: CompatibilityRecord[]; nextCursor: string | null };
export type CollectionSchemaWrite = {
  schema: JsonObject;
  indexed: string[];
  uniqueKey: string | null;
  searchable: string[];
  sensitive: string[];
  auditActions?: { action: string; sensitivity: 'standard' | 'restricted'; visibleToSubject: boolean }[];
};
export type CollectionSchemaRegistration = CollectionSchemaWrite & { collection: string; auditActions: { action: string; sensitivity: 'standard' | 'restricted'; visibleToSubject: boolean }[] };
export type RecordIncrement = { op: 'increment'; field: string; by: number; min?: number; max?: number };
export type RecordBatchOperation =
  | { op: 'create'; collection: string; data: JsonObject }
  | { op: 'replace'; collection: string; id: string; data: JsonObject; ifMatch: string }
  | { op: 'delete'; collection: string; id: string; ifMatch: string }
  | { op: 'increment'; collection: string; id: string; operations: RecordIncrement[]; ifMatch?: string };
export type RecordBatchResult = { results: { op: 'create' | 'replace' | 'delete' | 'increment'; id: string; version: number | null }[] };
export type RecordLock = { lockId: string; lockedUntil: string };
export type RecordAggregate = { count: number; groups: { key: (string | number | boolean | null)[]; count: number }[] };
export type RecordImportResult = { created: number };
export type ExactResourceShareTarget = {
  resourceType: 'record' | 'object';
  resourceId: string;
  granteeAppId: string;
  granteeAppGroup?: never;
  action: 'read';
  expiresAt: string;
};
export type GroupResourceShareTarget = {
  resourceType: 'record';
  resourceId: string;
  granteeAppGroup: string;
  granteeAppId?: never;
  action: 'read';
  expiresAt: string;
};
export type ResourceShareTarget = ExactResourceShareTarget | GroupResourceShareTarget;
export type ExactResourceShareResult = { shareId: string; resourceType: 'record' | 'object'; resourceId: string; granteeAppId: string; action: 'read'; expiresAt: string };
export type GroupResourceShareResult = { shareId: string; resourceType: 'record'; resourceId: string; granteeAppGroup: string; action: 'read'; expiresAt: string };
export type ResourceShareResult = ExactResourceShareResult | GroupResourceShareResult;
export type RecordListFilter = {
  limit?: number;
  order?: 'asc' | 'desc';
  cursor?: string;
  sort?: string;
  where?: Record<string, string>;
  ownerAppId?: string;
};
export type RecordAggregateFilter = { count?: true; groupBy?: string[]; where?: Record<string, string>; ownerAppId?: string };
export type VerifiedIdentity = {
  subject: string;
  tenantId: string;
  roles: string[];
  units: string[];
  groups: string[];
  subjectId?: string;
  preferredUsername?: string;
};
export type RecordRef = { collection: string; id: string };
export type ObjectMetadata = { id: string; size: number; recordRef: RecordRef | null; tags: string[] };
export type ObjectMetadataPage = { items: ObjectMetadata[]; nextCursor: string | null };
export type SearchHit = { type: 'record'; recordRef: RecordRef } | { type: 'object'; objectId: string };
export type SearchPage = { items: SearchHit[]; nextCursor: string | null };
export type ObjectUpload = { file: Blob | Uint8Array | ArrayBuffer | string; recordRef?: RecordRef | null; tags?: string[] };
export type ObjectListFilter = { recordRef?: RecordRef; tag?: string; limit?: number; cursor?: string };
export type CapabilitySubjectAccessEntry = {
  source: 'capability'; accessId: string; executionId: string; accessedAt: string; purpose: string;
  flaggedAt: string | null; state: string; emergency: boolean; review: 'pending' | 'justified' | 'unjustified' | null;
  consumer: { appId: string; displayName: string | null }; provider: { appId: string; displayName: string | null };
  capability: { capabilityId: string; version: string; title: string | null };
};
export type AppSubjectAccessEntry = {
  source: 'application'; accessId: string; accessedAt: string; purpose: string; flaggedAt: string | null;
  app: { appId: string; displayName: string | null }; action: string; outcome: 'success' | 'denied' | 'failed';
};
export type SubjectAccessPage = {
  entries: (CapabilitySubjectAccessEntry | AppSubjectAccessEntry)[]; nextCursor: string | null;
  truncated: boolean; generatedAt: string;
};

export type DirectoryPage = { items: unknown[]; nextCursor: string | null };
export type DirectoryUnitType = { unitType: string; name: string };
export type DirectoryUnit = { unit: string; unitType: string; name: string };
export type DirectoryGroup = { unit: string; group: string; name: string };
export type DirectoryMember = { unit: string; subject: string; groups: string[] };
export type SubjectConsent = {
  consentId: string;
  consumer: { appId: string; displayName: string | null };
  capabilityId: string;
  capabilityTitle: string | null;
  purposes: string[];
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  state: 'active' | 'revoked' | 'expired';
};
export type ConsentCreate = { consumerAppId: string; capabilityId: string; purposes: string[]; expiresAt: string };
export type AuditResourceRef =
  | { type: 'record'; collection: string; id: string }
  | { type: 'object' | 'workflowExecution'; id: string };
export type AuditActor = { kind: 'application' } | { kind: 'user'; subject: string };
export type AppAuditWrite = {
  action: string;
  subjectId?: string;
  resourceRef: AuditResourceRef;
  outcome: 'success' | 'denied' | 'failed';
  purpose: string;
  meta?: Record<string, string | number | boolean | null>;
};
export type AppAuditReceipt = { eventId: string; appId: string; occurredAt: string; actor: AuditActor };
export type AppAuditEntry = Omit<AppAuditReceipt, 'actor'> & Pick<AppAuditWrite, 'action' | 'outcome'> &
  Partial<Pick<AppAuditReceipt, 'actor'> & Pick<AppAuditWrite, 'subjectId' | 'resourceRef' | 'purpose' | 'meta'>> &
  { source: 'application'; unit: string | null; sensitivity: 'standard' | 'restricted' };
export type PlatformAuditEntry = {
  eventId: string; occurredAt: string; tenantId: string; schemaVersion: number; event: string;
  resourceType: string; resourceId: string | null; revision: number | null; actorAppId: string | null;
  issuer: string; subject: string; managementClient: string | null;
  outcome: string; reasonCode: string | null; reason: string | null;
};
export type AuditFilter = { app?: 'self'; action?: string; subjectId?: string; unit?: string; from?: string; to?: string };
export type AuditPage = { items: (PlatformAuditEntry | AppAuditEntry)[]; nextCursor: string | null };
export type WorkflowStart = {
  definitionId: string;
  input?: JsonObject;
  unit?: string;
  taskUnits?: Record<string, string>;
  dueAt?: string;
  taskDueAt?: Record<string, string>;
};
export type WorkflowExecution = {
  id: string;
  definitionId: string;
  status: 'running' | 'completed' | 'cancelled';
  input: JsonObject;
};
export type WorkflowExecutionWithDeadline = WorkflowExecution & { dueAt: string | null };
export type WorkflowTaskClaim = { taskId: string; claimedBy: string; claimedUntil: string };
export type WorkflowTask = {
  taskId: string;
  executionId: string;
  definitionKey: string;
  stepKey: string;
  name: string;
  unit: string;
  candidateGroups: string[];
  dueAt: string | null;
  overdue: boolean;
  claimedBy: string | null;
  claimedUntil: string | null;
};
export type WorkflowPageOptions = { limit?: number; cursor?: string; userToken?: string };
export type WorkflowTaskFilter = WorkflowPageOptions & { definitionKey?: string; unit?: string; candidateGroup?: string; overdue?: boolean };
export type WorkflowTaskCompletion = {
  taskId: string;
  variables?: Record<string, string | number | boolean>;
  records?: { collection: string; data: JsonObject }[];
};
export type WorkflowPendingCompletion = { taskId: string; completionStatus: 'pending'; execution: WorkflowExecutionWithDeadline };
export type WorkflowHistoryEntry = {
  taskId: string;
  stepKey: string;
  actorSubject: string;
  unit: string;
  group: string;
  decision: string | null;
  reason: string | null;
  completedAt: string;
};

export function inputDigest(input: Json): string;
export class JuncturaError extends Error { status: number; code: string; requestId?: string; }
export function createJuncturaClient(options: { baseUrl: string; clientId: string; clientSecret: string; timeoutMs?: number; fetcher?: typeof fetch }): Readonly<{
  request(path: string, options?: RequestOptions): Promise<Response>;
  identity(): Promise<VerifiedIdentity>;
  listDirectoryUnitTypes(page?: { limit?: number; cursor?: string }): Promise<DirectoryPage>;
  putDirectoryUnitType(unitType: string, name: string): Promise<DirectoryUnitType>;
  deleteDirectoryUnitType(unitType: string): Promise<void>;
  listDirectoryUnits(page?: { limit?: number; cursor?: string }): Promise<DirectoryPage>;
  putDirectoryUnit(unit: string, body: { unitType: string; name: string }): Promise<DirectoryUnit>;
  deleteDirectoryUnit(unit: string): Promise<void>;
  listDirectoryGroups(unit: string, page?: { limit?: number; cursor?: string }): Promise<DirectoryPage>;
  putDirectoryGroup(unit: string, group: string, name: string): Promise<DirectoryGroup>;
  deleteDirectoryGroup(unit: string, group: string): Promise<void>;
  listDirectoryMembers(unit: string, page?: { limit?: number; cursor?: string }): Promise<DirectoryPage>;
  putDirectoryMember(unit: string, subject: string, groups: string[]): Promise<DirectoryMember>;
  deleteDirectoryMember(unit: string, subject: string): Promise<void>;
  consent(userToken: string): Readonly<{
    list(): Promise<{ consents: SubjectConsent[] }>;
    create(consent: ConsentCreate, idempotencyKey?: string): Promise<SubjectConsent>;
    revoke(consentId: string): Promise<SubjectConsent>;
  }>;
  subjectAccess(userToken: string): Readonly<{
    list(options?: { limit?: number; cursor?: string }): Promise<SubjectAccessPage>;
    flag(accessId: string, reason: 'unrecognized' | 'other'): Promise<{ accessId: string; flaggedAt: string }>;
    emergencyFeedback(executionId: string, feedback: { decision: 'recognized' | 'unrecognized' | 'other'; message?: string }):
      Promise<{ executionId: string; submittedAt: string }>;
  }>;
  createRecord(collection: string, data: Json): Promise<{ id: string; data: Json; [key: string]: unknown }>;
  getRecord(collection: string, id: string): Promise<{ id: string; data: Json; [key: string]: unknown }>;
  listRecords(collection: string, query?: { limit?: number; order?: 'asc' | 'desc'; cursor?: string }): Promise<{ items: { id: string; collection: string; data: Json; created_at: string }[]; nextCursor: string | null }>;
  registerCollectionSchema(collection: string, schema: CollectionSchemaWrite): Promise<CollectionSchemaRegistration>;
  createVersionedRecord(collection: string, data: JsonObject, options?: { idempotencyKey?: string }): Promise<VersionedRecordResult>;
  getVersionedRecord(collection: string, id: string): Promise<VersionedRecordResult | CompatibilityRecordResult>;
  replaceVersionedRecord(collection: string, id: string, data: JsonObject, options: { ifMatch: string; idempotencyKey?: string }): Promise<VersionedRecordResult | CompatibilityRecordResult>;
  incrementRecord(collection: string, id: string, operations: RecordIncrement[], options?: { ifMatch?: string; idempotencyKey?: string }): Promise<VersionedRecordResult>;
  deleteVersionedRecord(collection: string, id: string, ifMatch: string): Promise<void>;
  upsertRecordByKey(collection: string, key: string, data: JsonObject, options?: { ifMatch?: string; idempotencyKey?: string }): Promise<VersionedRecordResult & { created: boolean }>;
  writeRecordBatch(operations: RecordBatchOperation[], options?: { idempotencyKey?: string }): Promise<RecordBatchResult>;
  listFilteredRecords(collection: string, query?: RecordListFilter): Promise<VersionedRecordPage | CompatibilityRecordPage>;
  aggregateRecords(collection: string, query?: RecordAggregateFilter): Promise<RecordAggregate>;
  lockRecord(collection: string, id: string, options?: { ttlSeconds?: number; lockId?: string; idempotencyKey?: string }): Promise<RecordLock>;
  releaseRecordLock(collection: string, id: string, lockId: string): Promise<void>;
  exportAppRecords(query?: { collection?: string }): Promise<Response>;
  importAppRecords(ndjson: string | Uint8Array | ArrayBuffer | ReadableStream<Uint8Array> | Blob, options?: { idempotencyKey?: string }): Promise<RecordImportResult>;
  shareResourceWithAppOrGroup(target: ResourceShareTarget, idempotencyKey?: string): Promise<ResourceShareResult>;
  putObject(id: string, bytes: BodyInit, idempotencyKey?: string): Promise<ObjectMetadata>;
  uploadObject(upload: ObjectUpload, idempotencyKey?: string): Promise<ObjectMetadata>;
  listObjectsByMetadata(filters?: ObjectListFilter): Promise<ObjectMetadataPage>;
  searchReadableResources(query: string, options?: { limit?: number; cursor?: string }): Promise<SearchPage>;
  getObject(id: string): Promise<ArrayBuffer>;
  appendAppAuditEvent(body: AppAuditWrite, options?: { idempotencyKey?: string; userToken?: string }): Promise<AppAuditReceipt>;
  queryAppAuditEvents(options?: AuditFilter & { since?: string; until?: string; limit?: number; cursor?: string; userToken?: string }): Promise<AuditPage>;
  exportAppAuditEvents(options?: AuditFilter & { userToken?: string; signal?: AbortSignal }): Promise<Response>;
  streamAuthorizedEvents(options?: { userToken?: string; signal?: AbortSignal }): Promise<Response>;
  workflowDefinitions(): Promise<unknown>;
  startWorkflow(definitionId: string, input: Json, idempotencyKey?: string): Promise<unknown>;
  startWorkflowWithDeadlines(body: WorkflowStart, options?: { idempotencyKey?: string; userToken?: string }): Promise<WorkflowExecution & { dueAt?: string | null }>;
  getWorkflowWithDeadline(executionId: string, options?: { userToken?: string }): Promise<WorkflowExecutionWithDeadline>;
  listWorkflowTasks(filters?: WorkflowTaskFilter): Promise<{ items: WorkflowTask[]; nextCursor: string | null }>;
  claimWorkflowTask(taskId: string, options?: { ttlSeconds?: number; userToken?: string }): Promise<WorkflowTaskClaim>;
  releaseWorkflowTask(taskId: string, options?: { userToken?: string }): Promise<void>;
  completeWorkflowTask(executionId: string, body: WorkflowTaskCompletion, options: { idempotencyKey: string; userToken?: string }): Promise<WorkflowPendingCompletion>;
  cancelWorkflowWithPendingCheck(executionId: string, options?: { userToken?: string }): Promise<void>;
  listWorkflowTaskHistory(executionId: string, page?: WorkflowPageOptions): Promise<{ items: WorkflowHistoryEntry[]; nextCursor: string | null }>;
  discover(query?: { limit?: number; cursor?: string }): Promise<unknown>;
  listCapabilityCatalog(options?: { limit?: number; cursor?: string; userToken?: string }):
    Promise<{ items: CapabilityCatalogItem[]; nextCursor: string | null }>;
  createCapabilityAccessRequest(body: CapabilityAccessRequestCreate, idempotencyKey?: string): Promise<CapabilityAccessRequest>;
  listCapabilityAccessRequests(options?: {
    direction?: 'incoming' | 'outgoing'; state?: CapabilityAccessRequestState; limit?: number; cursor?: string; userToken?: string;
  }): Promise<{ items: CapabilityAccessRequest[]; nextCursor: string | null }>;
  getCapabilityAccessRequest(requestId: string, options?: { userToken?: string }): Promise<CapabilityAccessRequest>;
  withdrawCapabilityAccessRequest(requestId: string): Promise<CapabilityAccessRequest>;
  declineCapabilityAccessRequest(requestId: string, reason: string, options?: { userToken?: string }): Promise<CapabilityAccessRequest>;
  acceptCapabilityAccessRequest(requestId: string, options?: { userToken?: string }): Promise<CapabilityAccessRequest>;
  execute(target: ExecutionTarget, input: Json, idempotencyKey?: string, context?: ExecutionContext): Promise<Execution>;
  redeemTicket(invocation: { authorization: string | undefined; invocationId: string; input: Json }): Promise<TicketContext>;
  execution(id: string): Promise<Execution>;
  waitForExecution(id: string, options?: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal }): Promise<Execution>;
}>;
