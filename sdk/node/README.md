<!-- SPDX-FileCopyrightText: 2026 Junctura Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# @junctura/server-client

Server-side Node.js client for [Junctura DX-OS](https://github.com/vku2-open-source-2026/junctura-dxos),
the headless platform that lets independent applications share data and capabilities
under consent and audit.

- No runtime dependencies; Node.js 24.
- OIDC client credentials kept in memory only; tokens are never persisted or logged.
- Mutations are never retried automatically; errors never echo response bodies or secrets.

## Install

```sh
npm install @junctura/server-client
```

## Use as a consumer

```js
import { createAppBootstrap, createJuncturaClient } from "@junctura/server-client";

const loadBundle = createAppBootstrap({
  url: process.env.JUNCTURA_OPENBAO_URL,
  roleId: process.env.JUNCTURA_OPENBAO_ROLE_ID,
  secretId: process.env.JUNCTURA_OPENBAO_SECRET_ID,
});
const junctura = createJuncturaClient(await loadBundle());

// Call a capability another application shares, stating why and for whom.
const subjectId = "<person's identity-provider subject>";
const execution = await junctura.execute(target, { requestId: "R-001" }, undefined, {
  purpose: "service_delivery",
  dataSubject: subjectId,
});
const result = await junctura.waitForExecution(execution.executionId);
```

Core stores the app's Gateway origin, OIDC issuer and endpoints, and client credentials
in OpenBao. Get the app's private AppRole settings from your operator. The loader caches the
bundle in memory for 30 seconds by default. Use `cacheMs: 0` for a fresh login and
read on each load. After a confirmed rotation, create a new client using
`createJuncturaClient(await loadBundle({ refresh: true }))`.

### Bootstrap errors

| `JuncturaError.code` | Condition |
| --- | --- |
| `openbao_unavailable` | The OpenBao connection failed, timed out, hit a rate limit or returned a server error. |
| `openbao_login_failed` | AppRole login was rejected. Check the role, SecretID expiry and auth mount. |
| `connection_bundle_forbidden` | OpenBao rejected the KV read. Check the AppRole policy and token lifetime. |
| `connection_bundle_missing` | The KV entry is missing. Check app activation and the configured mount. |
| `invalid_openbao_response` | The response body or AppRole login metadata was invalid. |
| `invalid_connection_bundle` | Bundle fields, app identity or OIDC endpoints failed validation. |

Invalid local options throw a `TypeError`. Keep the returned bundle and bootstrap
credentials out of logs and frontend code.

`dataSubject` is the person's identity-provider subject. Junctura checks that person's
consent, seals the call into the audit chain and shows it to them later. Emergency
access adds `emergency: true` and a `justification` and is reviewed afterwards.

Use `listCapabilityCatalog({ limit, cursor })` to browse published versions and their
`myAccess` status. To request a version, call
`createCapabilityAccessRequest({ capabilityId, version, purpose }, idempotencyKey)`.
Reuse the UUID key if you retry the same submission. Use `listCapabilityAccessRequests`,
`getCapabilityAccessRequest` and `withdrawCapabilityAccessRequest` to track requests.
Provider owners can pass their OIDC token as `{ userToken }` to list incoming requests,
decline a request or accept it. Acceptance returns the ID of a pending grant for an
independent approver to review.

## Use as a provider

Junctura invokes a provider with a single-use ticket. Redeem it before doing any work:

```js
const redeemed = await junctura.redeemTicket({
  authorization: request.headers.authorization,
  invocationId: body.invocationId,
  input: body.input,
});
if (!redeemed.active) return reply(403);
const { purpose, dataSubject, emergency } = redeemed.context;
```

## API

| Method | Purpose |
| --- | --- |
| `identity()` | The application's verified identity |
| `createRecord(collection, data)`, `getRecord(collection, id)` | Application records |
| `listRecords(collection, { limit, order, cursor })` | Application records as `{ items, nextCursor }`; limit 1–100 (default 100), order `asc` (default) or `desc`; pass `nextCursor` with the same order until null |
| `registerCollectionSchema(collection, schema)` | Register or replace an app collection schema and index configuration |
| `createVersionedRecord(collection, data, { idempotencyKey })`, `getVersionedRecord(collection, id)` | Versioned records as `{ record, etag }`; keep `etag` exactly for the next write |
| `replaceVersionedRecord(collection, id, data, { ifMatch, idempotencyKey })` | Replace complete record data with a required `If-Match` |
| `incrementRecord(collection, id, operations, { ifMatch, idempotencyKey })` | Atomic numeric increments; `ifMatch` is optional |
| `deleteVersionedRecord(collection, id, ifMatch)` | Conditional delete with a required `If-Match` |
| `upsertRecordByKey(collection, key, data, { ifMatch, idempotencyKey })` | Create or replace by the registered unique key; returns `{ record, etag, created }` |
| `writeRecordBatch(operations, { idempotencyKey })` | Atomic batch of create, replace, delete and increment operations |
| `listFilteredRecords(collection, { limit, order, cursor, sort, where, ownerAppId })` | Filter by indexed fields and sort by one indexed field |
| `aggregateRecords(collection, { groupBy, where, ownerAppId })` | Count readable records, optionally grouped by up to two fields or UTC days |
| `lockRecord(collection, id, { ttlSeconds, lockId, idempotencyKey })`, `releaseRecordLock(collection, id, lockId)` | Acquire, renew or release an expiring record lock |
| `exportAppRecords({ collection })` | Stream the owner's records as NDJSON |
| `importAppRecords(ndjson, { idempotencyKey })` | Import NDJSON records in one transaction |
| `shareResourceWithAppOrGroup(target, idempotencyKey?)` | Share one record with an app group or exact app |
| `putObject(id, bytes)`, `getObject(id)` | Malware-scanned object storage |
| `workflowDefinitions()`, `startWorkflow(id, input, key?)` | BPMN workflows |
| `startWorkflowWithDeadlines(body, options?)`, `getWorkflowWithDeadline(id, options?)` | Workflow deadlines and per-step unit overrides |
| `listWorkflowTasks(filters?)`, `claimWorkflowTask(taskId, options?)`, `releaseWorkflowTask(taskId, options?)` | Group inbox and expiring claims |
| `completeWorkflowTask(id, body, options)`, `listWorkflowTaskHistory(id, page?)`, `cancelWorkflowWithPendingCheck(id, options?)` | Complete a selected task, read confirmed history or cancel an execution |

Generate one UUID for each task completion and pass it as `options.idempotencyKey`.
Reuse that key and the same body for every retry to obtain the first recorded response.
| `discover({ limit, cursor })` | Capabilities this application may call |
| `execute(target, input, key?, context?)`, `execution(id)`, `waitForExecution(id)` | Capability calls |
| `redeemTicket({ authorization, invocationId, input })` | Provider ticket redemption |
| `inputDigest(input)` | Canonical SHA-256 of a JSON input |
| `request(path, options)` | Any other versioned public API path |

Versioned writes return the response `ETag` exactly as the server sent it. Pass that value back
unchanged on replace or delete; do not construct or reformat it:

```js
const { record, etag } = await junctura.getVersionedRecord("entries", id);
const updated = await junctura.replaceVersionedRecord("entries", id, { ...record.data, status: "closed" }, { ifMatch: etag });
await junctura.deleteVersionedRecord("entries", id, updated.etag);
```

Full contract: [OpenAPI](https://github.com/vku2-open-source-2026/junctura-dxos/tree/main/docs/contracts).

## License

Apache-2.0. See `LICENSE` and `NOTICE`.


### Application access

Use a management `userToken` with `listApplications`, `getApplication`, `updateApplication`,
`listApplicationAssignments`, `assignApplicationAccess` and `revokeApplicationAccess`.
Pass the ETag from `getApplication` as `ifMatch` when updating metadata.
Use `listApplicationOidcKeys` for rotation history and `rotateApplicationOidcKey` to rotate.
Pass the original `idempotencyKey` to retry a rotation. Rotation responses contain receipts,
and the app can reload its updated connection bundle from OpenBao.
