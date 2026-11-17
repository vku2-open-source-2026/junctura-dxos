<!-- SPDX-FileCopyrightText: 2026 Junctura Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Core API

The local gateway is `PUBLIC_URL` (default `http://127.0.0.1:8080`); versioned Core routes use `/v1` and `/v2`.
Machine-readable contracts are [Foundation OpenAPI](contracts/foundation-api.openapi.json) and [Capability OpenAPI](contracts/capability-api-v1.openapi.json). Compose publishes HTTP on loopback only.
Configure TLS, trusted proxies and secrets before exposure beyond the local environment; see [SECURITY.md](SECURITY.md).

## Contract and checks

Foundation OpenAPI 3.1.1 describes **30 paths and 44 operations**: health/readiness, identity/OIDC integration,
application registration/approvals, legacy and private resources, read shares and workflow lifecycle.
It covers a subset of the route index below. Capability OpenAPI separately marks implemented registry, trust and
opt-in execution/composition subsets and design-only operations. Do not assume every operation exists.
The `/identity/` prefix delegates to Keycloak; vendor administration and dynamic login actions remain upstream-owned.
Operator database, filer and engine interfaces and `/internal/auth` are not public Foundation endpoints.

Authorization boundaries apply independently of schema validation:

- Core verifies live OIDC issuer, audience, expiry, roles and tenant membership. Caller app/tenant/client/owner headers confer no authority.
- V2 resolves an active registration and exact operator-enrolled backend subject server-side. Only owners write;
  an owner-approved share permits reading one resource until expiry/revocation, with no write or delegation rights.
- Inactive consumers lose v2 entry; suspended/revoked owners block shared reads. In-flight work may finish.
  Keycloak client administration is separate from application state.
- Browsers use an application backend, which owns human and domain authorization. Forwarded human headers and descriptors grant no impersonation.
- V1 data/objects are a deprecated, separate tenant namespace behind `LEGACY_RESOURCE_CLIENTS`
  (empty by default outside Compose). They never read v2 tables or bytes; migrate deliberately without guessed ownership or fallback.
- Workflows and their variables remain tenant-scoped; do not put application-private content in variables.

Record pagination accepts only `limit` 1–100 (default 100), without cursor/offset; `/v1/applications` has no GET operation.
Workflow definition listing is capped at 100 without public pagination. Foundation JSON writes are limited to 64 KiB;
object uploads to 1 byte–5 MiB; Nginx separately bounds request bodies at 10 MiB. Smaller limits can apply to extensions.
Core errors use `{error: code}`; control-plane handlers also include `requestId` and set `X-Request-Id`.
Gateway denials may use Nginx HTML or JSON without a JSON request ID. HEAD has no response body.
Nginx can append a second `nosniff` value; the contract accepts it. Revision tags are opaque.
Registration administration uses enrolled permissions, not a blanket writer role.
OpenAPI cannot prove live ownership, independent human approval, origin control, relative expiry, workflow depth
or exactly-once effects. Real-service tests exercise semantics; wire byte limits are checked separately from decoded schemas.

Use Node 24 and Python 3.10+ with the pinned development validators. Package scripts invoke **`python`**;
that command must resolve to the intended Python interpreter. CI installs `requirements-contracts.txt`.

```sh
python -m pip install -r requirements-contracts.txt
npm run check
npm run check:contracts
npm run test:contract-validator
npm test
```

`scripts/check-contracts.py` checks local references, schemas, unique operation IDs, parameters, roles and resource boundaries.
Its independently reviewed route/method inventory must match Foundation; it does not discover JavaScript routes automatically.
It also checks composition route/source/status mappings. The official OpenAPI metaschema is downloaded into memory
and verified against a pinned SHA-256; network failure or a changed digest fails the check without fallback.
Validator self-tests deliberately corrupt schemas, routes, references, authentication, statuses, media and headers.

Run live suites **sequentially** against an isolated local development stack; integration/recovery/audit suites can interrupt dependencies:

```sh
docker compose config --quiet
docker compose up --build --detach --wait --wait-timeout 240
npm run test:integration
npm run test:applications
npm run test:flowable-worker
npm run test:recovery
npm run test:audit
```

The integration and application suites validate observed HTTP in memory after fixture cleanup and require positive
coverage of each Foundation operation assigned to the suite. Failed requests validate response contracts, not success request schemas.
The observer omits credential headers, redacts known OAuth fields and retains only binary lengths; diagnostics omit payload values.
Tests check byte round trips and authorization; integration also covers tenant spoofing, PKCE login/logout and dependency recovery.
CI runs structural and live checks; validators add no production dependency.
Coverage does not prove every proxy timeout, rate-limit burst, provider UI branch or vendor protocol behavior.

## Route index

Every versioned route requires `core-reader`. Below, **writer** means an additional `core-writer` role;
**management** means an enabled operator-enrolled principal with the stated tenant permission and verified client binding.
Methods are included with each family; action suffixes are described in the linked reference.

| Route family (methods) | Purpose | Additional permission/boundary | Reference |
| --- | --- | --- | --- |
| `/health` (GET, HEAD), `/ready` (GET) | Liveness and dependency readiness | Public | Identity and gateway below |
| `/v1/identity` (GET) | Caller's verified identity | None | Identity and gateway below |
| `/identity/` (upstream methods) | Keycloak OIDC passthrough | Keycloak protocol/client policy | Identity and gateway below |
| `/v1/data/*` (GET, POST, PATCH, DELETE) | Legacy tenant records | Legacy client allowlist; writer for mutations | Structured data below |
| `/v2/data/*` (GET, POST, PATCH, DELETE) | Application-private records | Active bound backend; owner/writer for mutations; exact read shares | Structured data below; [SECURITY.md](SECURITY.md) |
| `/v1/objects` and `/*` (GET, POST, PUT, DELETE) | Legacy tenant bytes | Legacy client allowlist; writer for mutations | Unstructured objects below |
| `/v2/objects` and `/*` (GET, POST, PUT, DELETE) | Application-private bytes | Active bound backend; owner/writer for mutations; exact read shares | Unstructured objects below; [SECURITY.md](SECURITY.md) |
| `/v2/resource-shares` (POST), `/{shareId}` (DELETE) | Create/revoke exact read shares | Active owner backend and writer | [SECURITY.md](SECURITY.md) |
| `/v2/secrets/{name}` (GET, PUT, DELETE) | Secret metadata/write/delete; GET never returns plaintext | Active bound backend; writer for PUT/DELETE | [OPERATIONS.md](OPERATIONS.md) |
| `/v1/workflows/*` (GET, POST, DELETE) | Definitions and execution lifecycle/oversight | Writer for lifecycle mutations; management `audit.read` for list/summary | Workflow engine; Storage summary and workflow history below |
| `/v1/applications` (POST), `/{appId}` (GET), `/{appId}/approve`, `/{appId}/state` (POST) | Register, inspect, activate and change application state | Enrolled owner/admin visibility; `applications.register` / `applications.approve` | [CAPABILITIES.md](CAPABILITIES.md) |
| `/v1/approvals` (POST), `/{approvalId}` (GET), `/{approvalId}/revoke` (POST) | Application, capability, grant and enabled composition decisions | Resource-specific independent approval/visibility; grant writes also require writer | [CAPABILITIES.md](CAPABILITIES.md) |
| `/v1/capabilities` (GET), `/{capabilityId}/versions/*` (GET, POST, PUT) | Registry and authorized discovery | Management `capabilities.write` / `capabilities.publish`; consumers need exact discover grant | [CAPABILITIES.md](CAPABILITIES.md) |
| `/v1/trust/grants` (POST), `/{grantId}` (GET), `/{grantId}/activate`, `/{grantId}/revoke` (POST) | Direct trust lifecycle | Management `trust.write` / `trust.approve`; mutations require writer | [CAPABILITIES.md](CAPABILITIES.md) |
| `/v1/trust/graph` (GET) | Visible applications and direct grants | Management `trust.write` (own providers) or `trust.approve` (tenant) | [CAPABILITIES.md](CAPABILITIES.md) |
| `/v1/capability-executions` (POST), `/{executionId}` (GET) | Opt-in C4A/C4B invocation and status | Bound consumer, exact invocation authority; writer for submission | [CAPABILITIES.md](CAPABILITIES.md) |
| `/v1/capability-authorizations/introspect` (POST) | Opt-in provider ticket redemption | Writer, exact bound provider and valid ticket/context | [CAPABILITIES.md](CAPABILITIES.md) |
| `/v1/compositions` and `/*` (GET, POST, PUT) | Opt-in C4B registry/lifecycle | `config.compositionRuntime`; management `compositions.write` / `compositions.publish` | [CAPABILITIES.md](CAPABILITIES.md) |
| `/v1/me/consents` (GET, POST), `/{consentId}/revoke` (POST) | Manage the caller's own consents | Verified subject/client; no writer requirement | [SECURITY.md](SECURITY.md) |
| `/v1/me/data-access` (GET) | Capability calls naming the caller as data subject | Verified subject/client; own tenant/issuer/subject only | [SECURITY.md](SECURITY.md) |
| `/v1/emergency-accesses` (GET), `/{executionId}/review` (POST) | Review emergency invocations | Management `trust.approve`; writer for review | [SECURITY.md](SECURITY.md) |
| `/v1/audit-events` (GET), `/v1/audit-events/verify` (POST) | Protected event query and chain verification | Management `audit.read`; no writer requirement | Internal protected audit contract below; [SECURITY.md](SECURITY.md) |
| `/v1/metrics/traffic`, `/requests`, `/features` (GET) | Per-tenant, process-local traffic observations | Management `audit.read`; verified client ID | Traffic metrics below |
| `/v1/directory/principals`, `/organizations` (GET) | Tenant principal/application directory | Management `audit.read` | Tenant directory below |
| `/v1/storage/summary`, `/files`, `/collections` (GET) | Storage aggregates and reduced metadata | Management `audit.read` | Storage summary and workflow history below |

Nginx proxies all `^/v[12]/` paths after authentication. With both `config.executionRuntime` and
`config.compositionRuntime` absent (default `C4A_ENABLED=false`, `C4B_ENABLED=false`), invocation/introspection
paths fall through to Core `404`. Composition registry paths likewise return `404` without `config.compositionRuntime`.
With only composition enabled, capability-target submission returns `422 capability_runtime_disabled`.
Authentication or gateway errors can precede these responses. See [CAPABILITIES.md](CAPABILITIES.md) for supported opt-in operations.

## Identity and gateway

- `GET/HEAD /health` checks process liveness. `GET /ready` returns `200` or `503`, checking OIDC discovery/issuer
  and configured data RLS access, filer metadata/registered volume, ClamAV, secrets service and authenticated workflow engine.
  Readiness does not prove every future operation or complete disaster recovery.
- `GET /v1/identity` returns `{subject,tenantId,roles}` and optional `preferredUsername` from the caller's own
  safe `preferred_username` claim (well-formed, nonblank, at most 255 code points, without C0/DEL controls).
- `/identity/realms/junctura/.well-known/openid-configuration` provides upstream discovery;
  use standard OIDC authorization, token/refresh, userinfo, keys and logout APIs.

Gateway auth-request and Core independently introspect bearer tokens through confidential client `junctura-core`.
Tokens must be active, unexpired, from the configured issuer, have audience `junctura-core`, role `core-reader`,
and a `tenant_id` present in authoritative `tenant_memberships`. Caller tenant headers are ignored; provider failures
fail closed with `503`. Core returns only supported reader/writer roles. Group membership and role grants are administrator-owned;
a tenant attribute alone grants no membership. Core has no custom JWT verifier or password database.

The imported realm supplies two service-account tenants, a read-only account and tenant-A `local-user` with random
credentials from ignored `.env`. Registration is disabled. Public client `junctura-local` requires authorization-code
S256 PKCE and permits exactly `http://127.0.0.1:9876/callback`. These are local fixtures, not account provisioning.
Keycloak imports only into an empty database; edit existing realms through reviewed administration, never by deleting a volume.
`npm run setup` creates ignored random credentials and refuses to overwrite an existing `.env`; see [GETTING_STARTED.md](GETTING_STARTED.md).

Unknown routes return `404`; invalid/denied credentials return `401/403`. Nginx limits versioned requests per source
address to 100 requests/second with burst 50 (`429`), body reads to 10 seconds, upstream connect to 3 seconds,
and upstream send/read to 15 seconds. Upstream URLs are fixed configuration. Auth subrequests and provider ports are unpublished.

## Structured data

| Route | Methods | Contract |
| --- | --- | --- |
| `/v1/data/{collection}` | GET | `{items:[...]}`; optional `limit` 1–100, default 100 |
| `/v1/data/{collection}` | POST | `{data:{...}}`; `201` with generated UUID |
| `/v1/data/{collection}/{id}` | GET, PATCH, DELETE | Read, replace `data`, or delete a tenant record; inaccessible IDs return `404` |

Collections match `^[a-z][a-z0-9_-]{0,62}$`; IDs are lowercase UUIDs. JSON writes require `application/json`, at most
64 KiB and exactly one object-valued `data` field. Unknown envelope fields/query parameters are rejected.
All access requires reader; mutations require writer. Responses expose only ID, collection, JSON data and creation time. There are no application-specific schemas or business rules.

V2 has the same methods/envelopes under `/v2/data`, with server-resolved owner application, owner-only writes and
exact resource read shares. Active registration/backend binding and live app state are checked; see [SECURITY.md](SECURITY.md).
V1 remains tenant storage behind the explicit legacy allowlist; no ownership migration is automatic.

Core signs 30-second tenant assertions for PostgREST (`aud=junctura-data`, role `junctura_api` for legacy records;
`junctura_resource_api` for v2). Caller tokens are not database credentials. PostgreSQL FORCE ROW LEVEL SECURITY
checks tenant/resource claims. The signing secret stays private; no anonymous PostgREST role or data/database port is published.
`data-migrate` applies versioned SQL transactionally, retaining data and recording checksums; changed applied migrations
are refused. Add reviewed migrations for schema changes. Named volumes survive `docker compose down`; never use `down -v` on persistent data.

## Unstructured objects

| Route | Methods | Contract |
| --- | --- | --- |
| `/v1/objects` | POST | Generated UUID upload; `201 {id,size}` |
| `/v1/objects/{uuid}` | PUT | Caller-chosen UUID upload/replace; `201` created or `200` replaced |
| `/v1/objects/{uuid}` | GET, DELETE | Read/delete a tenant object; inaccessible or missing IDs return `404` |

Uploads require writer, `application/octet-stream` and 1 byte–5 MiB. GET requires reader; DELETE requires writer.
Query parameters, invalid paths and unsupported upload content types are rejected. Bytes are opaque; original filenames
and MIME-based rendering are not API inputs. Downloads use octet-stream, attachment disposition, `nosniff` and `no-store`.
V2 uses the same methods/envelopes under `/v2/objects`, resolving ownership server-side, allowing only owner writes
and exact read shares. See [SECURITY.md](SECURITY.md) for resource authorization.

Both versions quarantine uploads, scan bytes with ClamAV and publish only a clean result. Detection returns
`422 malware_detected`; scanner transport/protocol/timeout failures return `503`. Quarantine cleanup is best effort.
See [OPERATIONS.md](OPERATIONS.md) for scanner operation and secrets management.
SeaweedFS master/volume/filer data and LevelDB filer metadata persist in a named volume. Core constructs private paths
from verified tenant, validated UUID and v2 owner/version; callers cannot supply storage paths or endpoints.
Only Core connects to SeaweedFS on the private objects network; filer/admin ports are unpublished.
Use a stable UUID and identical bytes for retryable PUTs. POST creates a new ID and is not automatically retried;
reconcile an ambiguous outcome before retrying. No upstream call is blindly retried. Storage is single-node local persistence.

## Workflow engine

| Route | Methods | Contract |
| --- | --- | --- |
| `/v1/workflows/definitions` | GET | Up to 100 latest tenant definitions: `{items:[{id,key,version,name}]}`; excludes `junctura_c4a_single` |
| `/v1/workflows/executions` | POST | `{definitionId,input?:{...}}` and lowercase UUID `Idempotency-Key`; `201` created or `200` replayed |
| `/v1/workflows/executions/{id}` | GET | Durable engine history: `{id,definitionId,status,input}` |
| `/v1/workflows/executions/{id}/complete` | POST | Empty JSON object; completes exactly one active user task; already-completed executions return their state |
| `/v1/workflows/executions/{id}` | DELETE | Cancel running execution; repeated cancellation `204`; completed execution `409` |

Reads require reader; writes require writer. Foreign tenant definition/execution IDs return `404`.
Input uses a 64 KiB JSON request limit and nesting depth at most 32; unknown envelope/query fields are rejected. Caller fields cannot select the tenant. Engine URLs/credentials are not returned. Status is `running`, `completed` or `cancelled`.
The internal C4A definition cannot be started or inspected through this lifecycle API.

Flowable owns BPMN execution, tasks, variables and history in a separate database/role, using a private REST boundary
and random administrative credential. Core and the one-shot initializer share the engine network; no engine port is published. The initializer installs the technical `junctura_checkpoint` per selected tenant: start, one user task, end, without
business rules or external effects. Public callers cannot upload BPMN, scripts or network targets. The completion adapter
supports one active user task; other installed definitions can still be started, observed and cancelled.

The RLS-protected SQL ledger uniquely reserves `(tenant_id,key)`; only the reservation owner calls engine start.
Changing definition/input on retry returns `409`; object-key order does not change input identity.
If no result was recorded, Core reconciles by tenant-scoped business key in durable engine history.
Without one unique outcome it returns `409 execution_pending_reconciliation` and never starts again for that key.
Operators resolve stuck reservations after checking history/in-flight work; there is no expiry, deletion or blind retry.
Retain definitions, history and ledger for the retry window. Duplicate start prevention does not guarantee exactly-once external effects.
Flowable initializes its own schema on first boot; review migrations/backups before engine upgrades. Ledger changes use versioned SQL.

## Business workflow definitions

Applications maintain business BPMN outside the Core image. Operators set `WORKFLOW_DEFINITIONS_DIR` to their directory; unset/empty uses [infra/workflows](../infra/workflows/README.md), which contains no business BPMN.
[Example workflows](../examples/workflows/README.md) are not deployed by default. `workflow-init` mounts the directory read-only at `/definitions/business` and recursively collects `*.bpmn20.xml`;
the technical checkpoint mount is separate. `WORKFLOW_TENANTS` defaults to `tenant-a,tenant-b`, trims comma-separated
items and requires each to match `^[a-z0-9][a-z0-9-]{0,62}$`; empty/invalid items abort initialization.

Every business file must pass [definition-policy.mjs](../src/modules/workflow/definition-policy.mjs)
before any business or technical definition is deployed:

- XML must be a string of at most **262144 UTF-8 bytes**. `DOCTYPE` and `ENTITY` declarations are forbidden anywhere.
- Exactly one process is allowed, with `isExecutable="true"`, ID `^[a-z][a-z0-9_]{2,63}$` and name of 1–120 characters
  without C0/C1 controls. `junctura_c4a_single` and `junctura_checkpoint` are reserved IDs.
- Allowed element local names: `definitions`, `process`, `documentation`, `extensionElements`, `startEvent`, `endEvent`,
  `userTask`, `sequenceFlow`, `exclusiveGateway`, `parallelGateway`, `conditionExpression`, `laneSet`, `lane`, `flowNodeRef`.
  Diagram prefixes `bpmndi:`, `omgdc:`, `omgdi:`, `dc:`, `di:` are allowed; `junctura:` permits only `owner` and `group`.
  The allowlist rejects service/script tasks, subprocesses, calls and execution/task listeners.
- Every namespace declaration must use a known prefix and canonical URI; aliases/rebinding return `namespace_forbidden`:
  default/`bpmn` → `http://www.omg.org/spec/BPMN/20100524/MODEL`;
  `bpmndi` → `http://www.omg.org/spec/BPMN/20100524/DI`;
  `omgdc`/`dc` → `http://www.omg.org/spec/DD/20100524/DC`; `omgdi`/`di` → `http://www.omg.org/spec/DD/20100524/DI`;
  `flowable` → `http://flowable.org/bpmn`; `xsi` → `http://www.w3.org/2001/XMLSchema-instance`;
  `junctura` → `https://junctura.studio/schema/bpmn/1`.
- Attribute prefixes are limited to `flowable:` and `xsi:` (apart from namespace declarations).
  `expressionLanguage`, `typeLanguage`, `language`, `flowable:class`, `flowable:expression`, `flowable:delegateExpression`,
  `flowable:resultVariable`, `flowable:async`, `flowable:formKey` and `flowable:skipExpression` are forbidden.
  Attribute values containing `${` or `#{` are forbidden, including assignee/candidate-user expressions.
  XML character references are decoded before value checks. A condition accepts only optional `xsi:type="tFormalExpression"`.
- Conditions compare one variable with `==` or `!=`, for example `${decision == 'approved'}`.
  Variable regex: `[a-z][a-zA-Z0-9_]{0,40}`. Literals: `true`, `false`, an optional minus sign followed by 1–9 digits,
  or single-quoted strings of 0–64 characters excluding single quotes, dollar signs, backslashes and braces.
  Whitespace and a CDATA wrapper are allowed; method calls, empty conditions and missing closing tags are forbidden.
- `flowable:candidateGroups` is comma-separated; every trimmed item matches `^[a-z][a-z0-9-]{1,63}$`.

Rejection reports one line per problem with file name, rule and detail, without XML contents; exit status is 1 and
nothing is deployed for that run. This is a tag/attribute safety scan; Flowable still validates XML/BPMN schemas.
After configuring `.env`, run `docker compose run --rm workflow-init`.
For every key/tenant, the initializer queries the latest definition: new keys deploy; existing keys skip only when
original resource XML exactly equals the supplied file; changed XML creates a new deployment.
The final line reports business/technical file counts, tenants and deployments. Engine failures use a generic message without private configuration.

### Workflow display metadata

Applications supply labels in deployed BPMN, without Core business tables or local business-definition fallback.
Bind `junctura` on `definitions` and declare metadata directly in the process's own `extensionElements`:

```xml
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:flowable="http://flowable.org/bpmn"
             xmlns:junctura="https://junctura.studio/schema/bpmn/1"
             targetNamespace="https://example.invalid/workflows">
  <process id="process_a" name="Process A" isExecutable="true">
    <extensionElements>
      <junctura:owner id="group-a" name="Lead group" />
      <junctura:group id="group-a" name="Group A" />
      <junctura:group id="group-b" name="Group B" />
    </extensionElements>
    <startEvent id="start" />
    <sequenceFlow id="to_step" sourceRef="start" targetRef="step" />
    <userTask id="step" name="Step 1" flowable:candidateGroups="group-a,group-b" />
    <sequenceFlow id="to_end" sourceRef="step" targetRef="end" />
    <endEvent id="end" />
  </process>
</definitions>
```

Owner/group IDs match `^[a-z][a-z0-9-]{1,63}$`; display names contain 1–200 characters without C0/DEL controls.
Declare a named group for each task candidate group. Valid owner metadata supplies summary `application:{id,name}`;
otherwise it is `null`. Named user tasks become steps in document order, deduplicated by name. A step's `owner` is
the first candidate group with a valid declared name, otherwise `null`; raw group IDs are never used as labels.
Task-level extensions and metadata outside the process's own extensions are ignored. Attribute order and either quote style work.

Core loads original XML through Flowable `GET repository/process-definitions/{id}/resourcedata` and caches successful
parses by immutable definition ID (200 entries; oldest evicted first). Resource load/parse failure affects only that
definition (`steps:[]`, `application:null`) and can retry later. History-only definitions have empty metadata.
Technical definitions are excluded; definition-list/history failures propagate. Label changes require a new deployment. Execution titles use definition name plus valid `input.reference` matching `^[A-Z][A-Z0-9-]{0,31}$`, e.g. `Process A REF-0002`.
Without a valid reference, use only the name; without a name, `null`. No other input field contributes to the title.

## Traffic metrics

| Route | Methods | Contract |
| --- | --- | --- |
| `/v1/metrics/traffic` | GET | Per-tenant; requires `audit.read`. `minutes` default 60, range 1–1440; `{from,to,intervalSeconds,buckets:[{at,requests,errors4xx,errors5xx,avgLatencyMs,maxLatencyMs}],totals}` |
| `/v1/metrics/requests` | GET | Per-tenant; requires `audit.read`. `limit` default 20, range 1–100; newest first `{items:[{at,method,path,status,durationMs}]}` |
| `/v1/metrics/features` | GET | Per-tenant; requires `audit.read`. Same `minutes` bounds; `{from,to,features:[{feature,requests,errors4xx,errors5xx,avgLatencyMs,maxLatencyMs,series:[{at,requests}]}]}`, descending request count |

Counters record Core responses as they finish for the tenant verified by authorization, per process, resetting at restart without persistence or cluster aggregation. Authorized metric reads also count. Requests without a verified tenant, gateway rejections, `/health`, `/ready` and `401` responses are not counted.
All three require a verified client ID after OIDC validation and management `audit.read` in the caller's tenant/issuer, checked through `core.workflow_audit_access` using the private `junctura_workflow_audit_api` role. Missing permission returns `403 metrics_permission_required`; no client ID returns `403 verified_client_required`; missing data configuration or database failure returns `503 metrics_unavailable`.
Unknown/repeated/noninteger/out-of-range parameters return `400`; other methods return `405` with `Allow: GET`; responses use `no-store`.
Minute buckets are chronological, including zero minutes; totals cover the returned window. Each tenant's recent log holds 200 entries. At most 256 tenant stores are retained; adding another drops the least recently written store. Only normalized paths are retained: no query/fragment, headers, bodies or identity claims; UUID/numeric/token-like segments are replaced.
Features use fixed whole-segment prefixes: data, files, workflows, approvals, sharing (trust/shares), capabilities
(registry/executions/compositions), applications, consents (including access/emergency), secrets and audit.
Directory, identity, metrics and unrecognized paths map to `other`; only observed features appear. See
[metrics.mjs](../src/modules/metrics/metrics.mjs) for the exact mapping. These views never change workflow state.

## Tenant directory

| Route | Methods | Contract |
| --- | --- | --- |
| `/v1/directory/principals` | GET | `{items:[{subject,issuer,managementClient,permissions,enabled,displayName,organization,jobTitle,kind}],truncated}` |
| `/v1/directory/organizations` | GET | `{root:{id,name,kind,children},relations:[{from,to,label}],truncated}` |

Both require management `audit.read` in the caller's tenant/issuer, reject query parameters, and return `no-store`. The private `junctura_directory_api` role reads local tables; it never calls Keycloak administration or returns secrets/tokens/bodies.
Principals are capped at 1000, ordered by subject/issuer/client. Nullable bounded profile fields are operator-owned
presentation metadata, not provider claims; `kind` is `admin`, `application` or `null`.
The organization root is the tenant (`platform`); children are registered applications (`application`), without a separate organization table.
Relations include active, unexpired direct grants only; labels use the capability title, falling back to its exact ID.
Limits are 1000 applications and 500 relations; `truncated` reports overflow. Application names come from registrations;
other principals use subjects, while callers can obtain their own `preferredUsername` from identity.

## Storage summary and workflow history

| Route | Methods | Contract |
| --- | --- | --- |
| `/v1/storage/summary` | GET | `{applications:[{id,name,state,collections:[{name,records,updatedAt}],files:{count,bytes,quarantined,updatedAt}}],totals:{collections,files}}` |
| `/v1/storage/files` | GET | Required `application`, optional `path` (root default); `{application:{id,name},path,folders:[{name,files,bytes,updatedAt}],files:[{name,extension,bytes,status,updatedAt}],truncated}` |
| `/v1/storage/collections` | GET | Required `application`; `{application:{id,name},collections:[{name,records,updatedAt,fields:[{name,type,fillRate}]}]}` |
| `/v1/workflows/executions` | GET | `{items:[{id,definition:{id,key,name,version},status,startedAt,updatedAt,title,currentStep}],limit}`; `limit` 1–100 (default 20), optional `status=running\|completed\|cancelled` |
| `/v1/workflows/summary` | GET | `{definitions:[{key,name,application:{id,name}\|null,steps:[{name,owner}],counts:{running,completed,cancelled},updatedAt}],totals:{definitions,running,completed,cancelled}}` |

These read-only routes require management `audit.read` and send `no-store`. Unknown/repeated query parameters are rejected;
summary routes accept none. SQL enforces tenant/permission through private `junctura_storage_api`,
`junctura_storage_collections_api` and `junctura_workflow_audit_api` roles; Core asserts them, never caller tokens.
Storage totals count application `core.app_records` plus legacy `core.records`; file aggregates reduce private filer metadata.
Summary exposes no object IDs, versions, original names, download paths or contents. Without a configured filer, `files` is `null`;
a configured but unavailable filer fails with `503`. Per-app quarantine counts are zero; tenant totals count quarantine separately.

The file browser reads one application-prefixed directory level, skips unsafe names and UUID object-key entries,
shows folder names and masks file bases (first three/last two grapheme clusters with `…`; bases of at most five keep only the first).
Extensions are retained; grapheme segmentation preserves combining marks. Published paths report `clean`, quarantine paths `quarantined`, unclassified paths `unknown`. File contents, object keys, versions and internal filer paths are never returned.
Collection fields are inferred from at most 200 newest records per collection, without records, samples or JSON paths. Types are `string`, `number`, `boolean`, `object`, `array`, `mixed`, `null`; `fillRate` is 0–100 for present non-null fields.
Multiple non-null types become `mixed`; entirely null fields are `null`. Only the selected application's collections appear.

Workflow history reads tenant-scoped engine history newest first, excludes `junctura_c4a_single` and returns running
step name, assignee and candidate groups, without full variables. It scans at most 20 pages of 100 history entries.
The summary aggregates at most 100 pages of 100 entries and discovers up to 100 latest definitions; it excludes both
technical keys `junctura_checkpoint` and `junctura_c4a_single`. Counts distinguish running/completed/cancelled only.
Summary returns no variables, case references or task IDs and cannot mutate executions. Labels, cache/failure handling and
case-title rules are defined once under Workflow display metadata above. Permission/provider failures retain their errors, including `503`.

## Internal protected audit contract

Authority/control-plane mutations append `app_private.audit` events transactionally; append failure rolls back the mutation.
Migration 005 derives actor/tenant metadata, validates events/outcomes and redacts free text. Application roles cannot
read/write the table directly. `core.audit_query(jsonb)` accepts only `since`, `until`, `limit` (1–100, default 50) and `cursor`,
requires management `audit.read`, and grants execution only to private `junctura_audit_api`.
Core exposes `GET /v1/audit-events` and `POST /v1/audit-events/verify` (empty JSON object) with that permission;
verification checks the per-tenant SHA-256 chain. These routes are outside Foundation OpenAPI. See [SECURITY.md](SECURITY.md).

## Application registration and capabilities

Registration, independent approvals, registry versions, authorized discovery and direct trust use private SQL authority
boundaries and enrolled tenant permissions. C3 compatibility is an offline module; C4A/C4B execution is opt-in and disabled
by default. Human delegation and resolver HTTP routes remain unimplemented; design-only execution cancel/resume routes
are not served. [CAPABILITIES.md](CAPABILITIES.md) documents registration, trust, execution, composition and revision/approval rules.

## Tested backend HTTP example

[foundation-http.mjs](../examples/foundation-http.mjs) uses ordinary HTTP for confidential authentication, private record
creation, binary upload/download, a ten-minute read share and technical checkpoint start/inspect/completion.
It puts no private content in workflow variables and never automatically retries POST. `npm run test:applications` executes this example with uniquely named, independently approved backend fixtures,
using the local Keycloak administrator credential for provisioning. Credentials stay in memory; tests verify shared read
and denied update, run the standalone CLI with private environment variables, and clean up their resource fixtures.

For an already operator-enrolled active backend, set these environment variables privately and run `npm run example:foundation`:

```text
PUBLIC_URL=http://127.0.0.1:8080
JUNCTURA_APP_CLIENT_ID=<registered confidential backend client>
JUNCTURA_APP_CLIENT_SECRET=<privately provisioned credential>
JUNCTURA_GRANTEE_APP_ID=<different active same-tenant registered app UUID>
```

Optional `JUNCTURA_GRANTEE_CLIENT_ID` and `JUNCTURA_GRANTEE_CLIENT_SECRET` must be supplied together to test the recipient read.
The tenant-a/tenant-b fixtures alone do not grant v2 access. The CLI leaves its records, object and expiring share owned
by the backend and prints IDs without credentials/tokens. Reconcile failed POST outcomes before rerunning;
keep backend secrets out of frontends, repositories and shell transcripts.

## Limitations

This is a local single-node stack, without production TLS/deployment or replicated storage configuration.
Generic storage has no domain schema; v1 legacy and v2 private resources remain separate.
Workflows remain tenant-scoped, and public task interaction is limited to single-task completion.
Contracts and positive operation coverage do not prove exhaustive faults, external exactly-once effects or full provider conformance.
