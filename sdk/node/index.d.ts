// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type CapabilityReference = { capabilityId: string; version: string; manifestDigest: string };
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

export function inputDigest(input: Json): string;
export class JuncturaError extends Error { status: number; code: string; requestId?: string; }
export function createJuncturaClient(options: { baseUrl: string; clientId: string; clientSecret: string; timeoutMs?: number; fetcher?: typeof fetch }): Readonly<{
  request(path: string, options?: RequestOptions): Promise<Response>;
  identity(): Promise<{ subject: string; tenantId: string; roles: string[]; [key: string]: unknown }>;
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
  putObject(id: string, bytes: BodyInit): Promise<unknown>;
  getObject(id: string): Promise<ArrayBuffer>;
  workflowDefinitions(): Promise<unknown>;
  startWorkflow(definitionId: string, input: Json, idempotencyKey?: string): Promise<unknown>;
  discover(query?: { limit?: number; cursor?: string }): Promise<unknown>;
  execute(target: ExecutionTarget, input: Json, idempotencyKey?: string, context?: ExecutionContext): Promise<Execution>;
  redeemTicket(invocation: { authorization: string | undefined; invocationId: string; input: Json }): Promise<TicketContext>;
  execution(id: string): Promise<Execution>;
  waitForExecution(id: string, options?: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal }): Promise<Execution>;
}>;
