<!-- SPDX-FileCopyrightText: 2026 Junctura Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Layer 1 API contracts

The implemented machine-readable source is
[Foundation OpenAPI 3.1](contracts/foundation-api.openapi.json). See
[validation, boundaries and tested HTTP examples](FOUNDATION_OPENAPI.md).

All routes are reached through the local gateway at `PUBLIC_URL` (default
`http://127.0.0.1:8080`). Versioned Core routes use `/v1` and `/v2`. This stack is a local
foundation: HTTP is restricted to loopback, and no production deployment is
configured. Configure TLS, trusted proxies and secrets before any approved
deployment beyond the local environment.

Application-private records and objects use the implemented
[v2 resource contract](RESOURCE_AUTHORIZATION.md): authoritative backend client
bindings, owner-only writes, exact owner-approved read shares and live app-state
checks. V1 data/object routes below are a separate deprecated legacy namespace,
restricted to `LEGACY_RESOURCE_CLIENTS` (empty by default outside local Compose).
They never read v2 tables or bytes. Migrate existing data deliberately; do not
infer ownership or silently fall back to v1. Identity and workflow contracts stay
at v1, and workflow variables remain tenant-scoped.

## Identity and gateway

- `GET /health` and `HEAD /health`: existing process-liveness contract.
- `GET /ready`: dependency-aware readiness, `200` or `503`; separate from liveness.
  Checks OIDC discovery/issuer, an RLS-scoped data query, object filer metadata
  plus a registered storage volume, and the authenticated workflow engine.
  It does not prove every future operation or a complete disaster recovery.
- `GET /v1/identity`: authenticated `{subject, tenantId, roles}` plus
  `preferredUsername` when the caller's own token carries a safe
  `preferred_username` claim.
- `/identity/realms/junctura/.well-known/openid-configuration`: upstream Keycloak
  discovery. Use its standard OIDC authorization, token, refresh and logout APIs.

Gateway auth-request and Core independently introspect bearer tokens through
Keycloak's confidential `junctura-core` client. Require active, unexpired tokens,
the configured issuer, audience `junctura-core`, realm role `core-reader`, and
`tenant_id` matching an authoritative `tenant_memberships` group. Caller tenant
headers are ignored. Provider errors fail closed. No custom JWT verifier,
password database or email-only login is implemented.

The imported realm contains two local service-account tenants and a read-only
account, all using random secrets from ignored `.env`. `junctura-local` is a public
authorization-code client requiring S256 PKCE, with exactly one loopback callback:
`http://127.0.0.1:9876/callback`. The technical `local-user` fixture belongs to
tenant A; its random password stays in `.env`. Registration is disabled. These
fixtures are not production account provisioning or business entities.

Group memberships and role grants are administrator-owned. A tenant attribute
alone never grants membership. Core returns only its supported reader/writer
roles. No caller may assign a tenant via a request payload/header.

Unknown routes return `404`; denied credentials return `401/403`. Gateway-level
denials can use Nginx's standard error representation; Core errors use JSON
`{error: code}`. Identity dependency failure returns `503`. The gateway enforces
request-size/time bounds and a per-source rate limit; upstream URLs are fixed
configuration, not caller input. Internal auth and service ports are unpublished.

## Running the local checks

`npm run setup` creates ignored random credentials and refuses to overwrite an
existing file. `docker compose up --build --detach --wait --wait-timeout 240`
starts real services. `npm run test:integration` verifies discovery, real token
issuance, two tenant identities, spoofed-header denial and a complete PKCE
authorization-code/login/logout flow using the upstream provider.
It also interrupts/recreates local dependencies and verifies recovery. Run only
against a local test stack, sequentially with `npm run test:recovery` and
`npm run test:audit`.

Keycloak imports the realm only into an empty database. Editing the JSON does
not migrate an existing realm. Use reviewed administrator changes for an
existing realm; never delete a data volume to apply a configuration edit.

## Structured data

| Route | Methods | Contract |
| --- | --- | --- |
| `/v1/data/{collection}` | GET | `{items: [...]}`, optional `limit` 1–100, default 100 |
| `/v1/data/{collection}` | POST | Body `{data: {...}}`; returns `201` with generated UUID |
| `/v1/data/{collection}/{id}` | GET, PATCH, DELETE | Read, replace `data`, or delete an owned record; `404` for an inaccessible ID |

Collections match `[a-z][a-z0-9_-]{0,62}`; IDs are UUIDs. JSON request bodies are
limited to 64 KiB, with `Content-Type: application/json`. Unknown fields and
query parameters are rejected. Writes require `core-writer`; all access requires
`core-reader`. Reads expose only ID, collection, JSON data and creation time.
This is generic structured storage; no app-specific schema/business rules exist.

Core issues a short-lived, tenant-scoped internal assertion for PostgREST with
audience `junctura-data` and role `junctura_api`. Caller tokens are never treated as
internal database credentials. PostgreSQL FORCE ROW LEVEL SECURITY enforces
tenant claims for reads and writes, including direct service-level queries.
The assertion secret stays inside Compose; there is no anonymous PostgREST role
or published database/data API port.

`data-migrate` applies `infra/postgres/001-data.sql` transactionally and idempotently
without dropping data. Existing migrations must not be edited after release;
add a new reviewed migration for schema changes. Named volumes survive
`docker compose down`. Never use `down -v` on persistent project data.

## Unstructured objects

| Route | Methods | Contract |
| --- | --- | --- |
| `/v1/objects` | POST | Upload bytes with a generated UUID; returns `201 {id,size}` |
| `/v1/objects/{uuid}` | PUT | Upload/replace at a caller-chosen UUID; `201` created or `200` replaced |
| `/v1/objects/{uuid}` | GET, DELETE | Read or delete an owned object; inaccessible/missing IDs return `404` |

Uploads require `application/octet-stream`, 1 byte–5 MiB, and `core-writer`.
Files are opaque bytes; original filenames, executable scripts and MIME-based
rendering are not part of the API. Downloads always use octet-stream,
`Content-Disposition: attachment`, `nosniff` and `no-store`. GET requires reader
permission; DELETE requires writer permission. Other query parameters, object
path formats and content types are rejected.

SeaweedFS filer/volume/master data and LevelDB filer metadata live in a named
volume. Core constructs the private storage path from verified tenant identity
and a validated UUID; a caller cannot provide a path or storage endpoint. Only
Core shares the private objects network with SeaweedFS; no filer/admin port is
published. The adapter is the authenticated object-service boundary.

Use PUT with a stable UUID and identical bytes for retryable writes. POST creates
a new identifier and is not automatically retried; an ambiguous POST timeout
must not be treated as proof no object was stored. No upstream call is blindly
retried. This is single-node local persistence, not a replicated storage cluster.

## Workflow engine

| Route | Methods | Contract |
| --- | --- | --- |
| `/v1/workflows/definitions` | GET | Up to 100 latest operator-installed definitions for the verified tenant: `{items:[{id,key,version,name}]}` |
| `/v1/workflows/executions` | POST | `{definitionId,input?:{...}}` plus a lowercase UUID `Idempotency-Key`; `201` created or `200` replayed |
| `/v1/workflows/executions/{id}` | GET | Durable `{id,definitionId,status,input}` from engine history |
| `/v1/workflows/executions/{id}/complete` | POST | Empty JSON object; completes an execution with exactly one active user task; repeat completion returns its completed state |
| `/v1/workflows/executions/{id}` | DELETE | Cancels a running execution; repeated cancellation returns `204`; a completed execution returns `409` |

Writes require `core-writer`, reads require `core-reader`. Definition ownership
is verified before starting. Every history/task lookup is scoped to the verified
tenant; foreign definition/execution IDs return `404`. Input is JSON with a
64 KiB request limit and maximum nesting depth of 32. Caller tenant fields and
unknown query/body fields are rejected. Internal engine URLs/credentials are
never returned. Status is `running`, `completed` or `cancelled`.

Flowable REST owns BPMN execution, tasks, variables and history in a separate
database/role. Its private REST boundary uses a random administrative credential;
only Core and the one-shot operator initializer share the engine network with
the database. No Flowable port is published. The initializer installs one
original technical checkpoint definition per local fixture tenant if missing.
The checkpoint is a start event, one user task and an end event; it has no
business rules or external side effects. Operator-reviewed BPMN versions can be
installed through the private engine interface; public callers cannot upload
BPMN, scripts or arbitrary network targets. Single-task completion is the current
adapter contract; more complex task interaction requires a separately reviewed
contract. Other installed definitions can still be started, observed and cancelled.

The SQL ledger has a unique `(tenant_id, key)` reservation under RLS. Exactly
one reservation owner may call engine start. Retries with different input or
definition return `409`; object-key order does not change input identity.
If the engine result was not recorded, Core reconciles by the tenant-scoped
business key in durable engine history and records the existing execution ID.
If no unique outcome is established, it returns `409 execution_pending_reconciliation`
and never starts another execution for that key. Operators must resolve a stuck
reservation after checking engine history and in-flight work; there is no blind
automatic retry, reservation expiry or ledger deletion. Keep definitions,
history and ledger for the supported retry window. This prevents duplicate
start calls; it is not a promise of exactly-once external business effects.

Flowable performs its upstream schema initialization in its own database on
first boot. Review migrations and backups before changing the pinned engine
version. Junctura ledger changes use additive, versioned SQL migrations.

## Internal protected audit contract

Authority and control-plane mutations append `app_private.audit` rows in the same
transaction. Migration 005 derives actor/tenant metadata, validates event/outcome
and redacts free text; failure to append rolls back the mutation. The internal
`core.audit_query(jsonb)` function accepts only `since`, `until`, `limit` and
`cursor`, requires a principal with `audit.read`, and is executable only by
`junctura_audit_api`; application roles cannot read or write the table directly.

Core serves it read-only as `GET /v1/audit-events` (Capability OpenAPI
`listAuditEvents`) for verified management principals with `audit.read`, after a
reviewed authorization mapping and pagination policy (see [AUDIT.md](AUDIT.md)).
It is not a Foundation route and is never exposed through PostgREST.

## Traffic metrics

| Route | Methods | Contract |
| --- | --- | --- |
| `/v1/metrics/traffic` | GET | One-minute buckets for the last `minutes` (default 60, max 1440): `{from,to,intervalSeconds,buckets:[{at,requests,errors4xx,errors5xx,avgLatencyMs,maxLatencyMs}],totals}` |
| `/v1/metrics/requests` | GET | Newest first request log, `limit` default 20 and max 100: `{items:[{at,method,path,status,durationMs}]}` |
| `/v1/metrics/features` | GET | Per-feature one-minute buckets for the last `minutes` (default 60, max 1440): `{from,to,features:[{feature,requests,errors4xx,errors5xx,avgLatencyMs,maxLatencyMs,series:[{at,requests}]}]}` sorted by requests descending |

These counters are real observations of requests that reached Core, recorded as
each response finishes. They live only in the running process: there is no
database write, no migration and no persistence, and every value resets when
Core restarts. They are per instance, not an aggregated cluster view. The
metrics routes themselves are counted like any other request, so reading them
slightly increases the numbers.

The `minutes` and `limit` query parameters are strict: unknown, repeated,
non-integer or out-of-range values return `400`, and non-GET methods return
`405` with `Allow: GET`. All three routes require a verified management
principal with `audit.read`, matching `GET /v1/audit-events`, and send
`Cache-Control: no-store`. Buckets are chronological and include empty minutes
as zeros; `totals` sums the returned window. The request log keeps at most the
newest 200 entries and stores only the normalized path. Query strings,
fragments, headers, bodies, tokens, subjects and recognizable UUID/token path
segments are never retained.

`features` assigns each normalized request path to one fixed feature using
whole-segment prefixes: `data` (`/v1/data`, `/v2/data`), `files` (`/v1/objects`,
`/v2/objects`), `workflows` (`/v1/workflows`), `approvals` (`/v1/approvals`),
`sharing` (`/v1/trust`, `/v2/resource-shares`), `capabilities`
(`/v1/capabilities`, `/v1/capability-executions`, `/v1/compositions`),
`applications` (`/v1/applications`), `consents` (`/v1/me/consents`,
`/v1/me/data-access`, `/v1/emergency-accesses`), `secrets` (`/v2/secrets`) and
`audit` (`/v1/audit-events`). Directory, health, identity, metrics and any
unrecognized path are grouped as `other`. Only features observed in the window
are returned; each carries its own per-minute request series and the same
latency and error semantics as the traffic route. The feature view is read-only
and intended for operator oversight; it changes no workflow state.

## Tenant directory

| Route | Methods | Contract |
| --- | --- | --- |
| `/v1/directory/principals` | GET | Enrolled management principals of the caller tenant and issuer: `{items:[{subject,issuer,managementClient,permissions,enabled,displayName,organization,jobTitle,kind}],truncated}`; profile fields are `null` when unset and `kind` is `admin`, `application` or `null` |
| `/v1/directory/organizations` | GET | Real tenant tree from registered applications and current trust grants: `{root:{id,name,kind,children},relations:[{from,to,label}],truncated}` |

Both routes require a verified management principal with `audit.read` in its own
tenant, read only from the local tables through the private
`junctura_directory_api` role (migration 022), and send `Cache-Control: no-store`.
They never call the Keycloak admin API and never return client secrets, tokens or
request bodies. `principals` lists at most 1000 rows ordered by subject; the
database compares the verified caller's `management_client` with the stored
principal, so only enrolled principals can ask. Migration 023 adds nullable,
bounded, control-character-free `display_name`, `organization`, `job_title` and
`kind` (`admin` or `application`) columns to `app_private.principals`; the API
returns them as `displayName`, `organization`, `jobTitle` and `kind`, each `null`
when unset. These are presentation fields seeded by the local operator script,
not identity-provider claims and never secrets.

`organizations` builds the tree from the caller's tenant and issuer: the root is
the tenant (`kind: platform`), children are the applications registered in this
tenant (`kind: application`), and `relations` are the active, unexpired direct
trust grants between those applications (migration 024); proposals awaiting
approval and revoked or expired grants are not shown. A relation label is the real
published capability title, falling back to the exact `capabilityId`; no label is
invented. Each list is bounded (1000 applications, 500 relations) and `truncated`
reports whether more exist. There is no separate organization table yet, so the
tree shows applications directly under the tenant. Display names come from the
applications themselves; other principals are identified by `subject`, while the
caller can read its own `preferredUsername` from `/v1/identity`.

## Storage summary and workflow history

| Route | Methods | Contract |
| --- | --- | --- |
| `/v1/storage/summary` | GET | Per application and tenant totals for structured record counts and object metadata: `{applications:[{id,name,state,collections:[{name,records,updatedAt}],files:{count,bytes,quarantined,updatedAt}}],totals:{collections,files}}` |
| `/v1/storage/files` | GET | One directory level of an application's private file tree: `{application:{id,name},path,folders:[{name,files,bytes,updatedAt}],files:[{name,extension,bytes,status,updatedAt}],truncated}`. Requires `application`; optional `path` defaults to the root. File names are partially masked (`maskFileName`); folder names and sizes are metadata only. |
| `/v1/storage/collections` | GET | Inferred structure of each collection owned by the application: `{application:{id,name},collections:[{name,records,updatedAt,fields:[{name,type,fillRate}]}]}`. Requires `application`. Types are `string`, `number`, `boolean`, `object`, `array`, `mixed` or `null`; `fillRate` is 0–100 from at most the 200 newest records. |
| `/v1/workflows/executions` | GET | Tenant workflow history, newest first: `{items:[{id,definition:{id,key,name,version},status,startedAt,updatedAt,title,currentStep}],limit}` |
| `/v1/workflows/summary` | GET | Read-only workflow dashboard: `{definitions:[{key,name,application:{id,name}|null,steps:[{name,owner}],counts:{running,completed,cancelled},updatedAt}],totals:{definitions,running,completed,cancelled}}` |

These routes require a verified management principal with `audit.read`, are
read-only and send `Cache-Control: no-store`. The storage routes call
`core.storage_summary(jsonb)` through the private `junctura_storage_api` role
(migration 025) or `core.storage_collections(jsonb)` through
`junctura_storage_collections_api` (migration 026). The workflow list first
checks `audit.read` through `core.workflow_audit_access(jsonb)` and the private
`junctura_workflow_audit_api` role. The database enforces the tenant and
permission; Core only asserts the private roles.

The storage summary deliberately returns aggregates only. Structured counts come
from `core.app_records` per owning application and from legacy `core.records`
for the tenant total. File counts, bytes, quarantine count and last modification
time come from reduced SeaweedFS filer metadata under the tenant's private
paths; object IDs, versions, original names, download paths and bytes are never
returned. If the object filer is not configured, `files` is `null`; if it is
configured but unavailable, the request fails closed with `503`.

The file browser reads the same application-prefixed filer tree and returns one
level at a time. Folder names are structural and shown in full (unsafe names are
skipped); file names are reduced by the pure `maskFileName` helper in
`src/modules/storage/`: it keeps the first three and last two grapheme clusters
of the base name with `…` in between, keeps the extension, and for bases of five
clusters or fewer keeps only the first cluster. Grapheme segmentation prevents
splitting Vietnamese diacritics or combining marks. Object-key directories left
by older flat uploads are never listed. Files under the published application
prefix are `clean`; a quarantine prefix would be `quarantined`; anything the
core cannot classify is `unknown`. Bytes, object keys, versions, internal paths
and record values are never returned.

The collection structure function infers field names and JSON types from at most
the 200 newest records of each collection, then returns only the name, type and
fill rate. It never returns a record, a sample value, a JSON path or object key.
Fill rate counts sampled records where the field is present and not `null`;
multiple JSON types for one field collapse to `mixed`, and an all-`null` field is
typed `null`. Collections are owned by the requested application only.

The workflow list accepts only `limit` (1–100, default 20) and
`status=running|completed|cancelled`; other or repeated parameters return
`400`. It reads Flowable history scoped to the caller tenant, excludes the
internal `junctura_c4a_single` definition, and returns the active task name and
candidate groups for running executions. `title` is a safe business label built
only from the record code and workflow kind; patient names, identifiers, record
contents and workflow variables are not included in the list response.

The workflow summary is a strictly read-only dashboard. It reads the three
business BPMN definitions shipped in `src/modules/workflow/definitions/`, their
named user tasks and candidate groups, then aggregates tenant-scoped Flowable
history into running, completed and cancelled counts. `steps` de-duplicates
names, so a repeated “Hoàn tất” task appears once, and the end event is not a
step. The owning product is a reviewed code-level declaration: Chuyển tuyến
bệnh nhân → Trạm y tế, Xác minh đơn thuốc → Nhà thuốc, Xác minh chi phí bảo hiểm
→ Bảo hiểm. Other installed non-technical definitions, and definitions that only
exist in history, are returned with `application: null` rather than guessed.
`cancelled` is the only unsuccessful outcome; the summary never returns patient
data, variables, record codes or task IDs and cannot start, complete, approve or
stop a workflow. The technical `junctura_checkpoint` fixture is marked
`technical: true` in code (display name “Kiểm tra kỹ thuật”) and, together with
the C4A engine definition, is excluded from the summary. No query parameters are
accepted, only `GET` is allowed and responses are `Cache-Control: no-store`.
Permission, database or engine failures fail closed with `503`.

## Capability extension APIs

The [Capability specification](CAPABILITY_EXTENSIONS_V1.md) and [extension OpenAPI](contracts/capability-api-v1.openapi.json) mark implemented subsets separately from future execution. [C1 Registry](CAPABILITY_REGISTRY.md) and [bounded C2 direct Trust/discovery](CAPABILITY_DIRECT_TRUST.md) are implemented. C3 is an offline module; human delegation and resolver HTTP endpoints remain unimplemented. [C4A](CAPABILITY_EXECUTION.md) and [C4B](CAPABILITY_COMPOSITION.md) implement bounded opt-in execution, disabled by default. Foundation OpenAPI retains the base application-approval subset; extension OpenAPI describes the additional capability-version/grant decisions. The five foundational contracts and public identity claims stay unchanged.

## Application Registration

POST /v1/applications, GET /v1/applications/{appId}, POST /v1/applications/{appId}/approve and POST /v1/applications/{appId}/state use operator enrollment and explicit tenant permissions. `/v1/approvals` create/get/revoke dispatches application, capability-version and direct grant decisions to their private authority boundaries. Grant creation/get/activate/revoke use `/v1/trust/grants`; consumers discover exact published versions through the existing capability GET/list routes. Errors include error plus requestId at Core; gateway denials retain their existing representation. Opt-in invocation and composition routes are described in [C4B](CAPABILITY_COMPOSITION.md); they remain absent from the default gateway.
