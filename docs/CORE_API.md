<!-- SPDX-FileCopyrightText: 2026 Junctura Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Core API

The local gateway is `PUBLIC_URL` (default `http://127.0.0.1:8080`); versioned Core routes use `/v1` and `/v2`.
Machine-readable contracts are [Foundation OpenAPI](contracts/foundation-api.openapi.json) and [Capability OpenAPI](contracts/capability-api-v1.openapi.json). Compose publishes HTTP on loopback only.
Configure TLS, trusted proxies and secrets before exposure beyond the local environment; see [SECURITY.md](SECURITY.md).

## Contract and checks

Foundation OpenAPI 3.1.1 describes health/readiness, identity/OIDC integration, application registration and approvals,
delegated access, legacy and private resources, read shares and workflow lifecycle.
Both files carry [planned API contracts](#planned-apis-not-yet-implemented). The route index below describes live routes.
Capability OpenAPI separately marks implemented registry, trust and
opt-in execution/composition subsets and design-only operations. Do not assume every operation exists.
The `/identity/` prefix delegates to Keycloak; vendor administration and dynamic login actions remain upstream-owned.
Operator database, filer and engine interfaces and `/internal/auth` are not public Foundation endpoints.

Authorization boundaries apply independently of schema validation:

- Core verifies live OIDC issuer, audience, expiry, roles and tenant membership. Caller app/tenant/client/owner headers confer no authority.
- V2 resolves an active registration and the enrolled backend subject or a current human assignment.
  Record and object access in a deployed app also requires a verified unit. Owners write within their authorized unit
  and an owner-approved share permits reading its resource subject to the same boundary.
- Inactive consumers lose v2 entry and suspended or revoked owners block shared reads. In-flight work may finish.
- Browser sign-in uses the application OIDC client. Core recognizes the application role and unit supplied by live assignment checks.
  Applications define their own domain authorization. Forwarded human headers and descriptors confer no authority.
- V1 data/objects are a deprecated, separate tenant namespace behind `LEGACY_RESOURCE_CLIENTS`
  (empty by default outside Compose). They never read v2 tables or bytes; migrate deliberately without guessed ownership or fallback.
- Workflows and their variables remain tenant-scoped; do not put application-private content in variables.

Record lists accept `limit` 1–100 (default 100), `order=asc|desc` (default `asc`) and an opaque `cursor`.
Application lists have their own filters and cursor.
Workflow definition listing is capped at 100 without public pagination. Foundation JSON writes are limited to 64 KiB;
object uploads to 1 byte–5 MiB; Nginx separately bounds request bodies at 10 MiB. Smaller limits can apply to extensions.
Core errors use `{error: code}`; control-plane handlers also include `requestId` and set `X-Request-Id`.
Application access refusals use `{error, requestId}` at the gateway and Core. HEAD has no response body.
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
Its independently reviewed route/method inventory and live coverage apply to implemented Foundation operations.
Planned operations and planned replacements in both contracts receive structural, reference and authorization checks.
It also checks composition route/source/status mappings. The official OpenAPI metaschema is downloaded into memory
and verified against a pinned SHA-256; network failure or a changed digest fails the check without fallback.
Validator self-tests deliberately corrupt schemas, routes, references, authentication, statuses, media and headers.

Run live suites **sequentially** against an isolated local development stack; integration/recovery/audit suites can interrupt dependencies:

```sh
docker compose config --quiet
docker compose up --build --detach --wait --wait-timeout 240
npm run directory:provision
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
| `/health` (GET, HEAD), `/ready` (GET), `/metrics` (GET) | Liveness, dependency readiness and Prometheus process metrics | Public; `/metrics` is reachable only inside the internal monitoring network | Identity and gateway below |
| `/v1/identity` (GET) | Caller's verified identity | None | Identity and gateway below |
| `/v1/token-exchange` (POST) | Obtain a short-lived bearer for calling as an assigned user | Enrolled application service account and login access token for the same client and tenant | Delegated application access below |
| `/identity/` (upstream methods) | Keycloak OIDC passthrough | Keycloak protocol/client policy | Identity and gateway below |
| `/v1/data/*` (GET, POST, PATCH, DELETE) | Legacy tenant records | Legacy client allowlist; writer for mutations | Structured data below |
| `/v2/data/*` (GET, POST, PATCH, DELETE) | Application-private records, filtered lists and aggregates | Active bound backend; owner/writer for mutations; exact or app-group read shares | Structured data below; [SECURITY.md](SECURITY.md) |
| `/v2/data:export`, `/v2/data:import` (GET, POST) | Owner-only NDJSON snapshot and transactional import | Active bound backend; writer for import | Structured data below |
| `/v2/data/{collection}/aggregate` (GET) | Count and group readable records | Active bound backend; owner, read share or management grant | Structured data below |
| `/v1/objects` and `/*` (GET, POST, PUT, DELETE) | Legacy tenant bytes | Legacy client allowlist; writer for mutations | Unstructured objects below |
| `/v2/objects` and `/*` (GET, POST, PUT, DELETE) | Application-private bytes | Active bound backend; owner/writer for mutations; exact read shares | Unstructured objects below; [SECURITY.md](SECURITY.md) |
| `/v2/resource-shares` (POST), `/{shareId}` (DELETE) | Create/revoke exact app or app-group read shares | Active owner backend and writer | [SECURITY.md](SECURITY.md) |
| `/v2/secrets/{name}` (GET, PUT, DELETE) | Secret metadata/write/delete; GET never returns plaintext | Active bound backend; writer for PUT/DELETE | [OPERATIONS.md](OPERATIONS.md) |
| `/v1/workflows/*` (GET, POST, DELETE) | Definitions and execution lifecycle/oversight | Writer for lifecycle mutations; management `audit.read` for list/summary | Workflow engine; Storage summary and workflow history below |
| `/v1/applications` (POST), `/{appId}` (GET), `/{appId}/approve`, `/{appId}/state` (POST) | Register through authorized setup tooling, inspect, activate and change application state | Enrolled owner/admin visibility, `audit.read` reads any (read-only); `applications.register` / `applications.approve` | [CAPABILITIES.md](CAPABILITIES.md) |
| `/v1/applications` (GET), `/{appId}` (PATCH) | Filter visible applications and update deployment metadata | Enrolled owner or management role | Application deployment and access below |
| `/v1/applications/{appId}/assignments` (GET/POST), `/{assignmentId}` (DELETE) | Read, assign and revoke application access | Read follows application visibility. Writes require owner or management authority. | Application deployment and access below |
| `/v1/applications/{appId}/oidc-keys` (GET/POST) | Inspect rotation receipts and rotate the OIDC client secret | Enrolled owner or management authority | Application deployment and access below |
| `/v1/applications/stats` (GET) | Tenant application counts, activity timestamps and IDs | Management `audit.read`; verified client ID | Application statistics below |
| `/v1/approvals` (POST), `/{approvalId}` (GET), `/{approvalId}/revoke` (POST) | Application, capability, grant and enabled composition decisions | Resource-specific independent approval/visibility; grant writes also require writer | [CAPABILITIES.md](CAPABILITIES.md) |
| `/v1/capabilities` (GET), `/{capabilityId}/versions/*` (GET, POST, PUT) | Registry, catalog visibility levels and authorized discovery | Management `capabilities.write` / `capabilities.publish`; `audit.read` reads every version (read-only); consumers need exact discover grant; catalog exposure defaults to hidden and is changed with `PUT …/visibility` | [CAPABILITIES.md](CAPABILITIES.md) |
| `/v1/capabilities/catalog` (GET) | Latest visible published version per capability with `myAccess` and cursor pagination | Tenant member or verified active application. A live exact `discover` grant exposes the manifest. | [CAPABILITIES.md](CAPABILITIES.md#catalog-visibility) |
| `/v1/trust/access-requests` (GET, POST), `/{requestId}` (GET), `/{requestId}/withdraw`, `/decline`, `/accept` (POST) | Capability access requests and acceptance into the direct grant approval flow | Sending application or provider owner with `trust.write`. Mutations require `core-writer`. | [CAPABILITIES.md](CAPABILITIES.md#capability-access-requests) |
| `/v1/trust/grants` (POST), `/{grantId}` (GET), `/{grantId}/activate`, `/{grantId}/revoke` (POST) | Direct trust lifecycle | Management `trust.write` / `trust.approve`; mutations require writer | [CAPABILITIES.md](CAPABILITIES.md) |
| `/v1/trust/graph` (GET) | Visible applications and direct grants | Management `trust.write` (own providers) or `trust.approve`/`audit.read` (tenant); read-only | [CAPABILITIES.md](CAPABILITIES.md) |
| `/v1/capability-executions` (POST), `/{executionId}` (GET) | Opt-in C4A/C4B invocation and status | Bound consumer, exact invocation authority; writer for submission | [CAPABILITIES.md](CAPABILITIES.md) |
| `/v1/capability-authorizations/introspect` (POST) | Opt-in provider ticket redemption | Writer, exact bound provider and valid ticket/context | [CAPABILITIES.md](CAPABILITIES.md) |
| `/v1/compositions` and `/*` (GET, POST, PUT) | Opt-in C4B registry/lifecycle | `config.compositionRuntime`; management `compositions.write` / `compositions.publish` | [CAPABILITIES.md](CAPABILITIES.md) |
| `/v1/me/consents` (GET, POST), `/{consentId}/revoke` (POST) | Manage the caller's own consents | Own authenticated login with a matching binding if the token supplies `subjectId` | [SECURITY.md](SECURITY.md) |
| `/v1/me/resource-consents` (GET, POST), `/{consentId}/revoke` (POST) | Manage the caller's consent for an organization unit to read a record or linked object | Own login token with a verified subject binding | Resource consent below |
| `/v1/resource-consent-requests` (POST), `/{requestId}` (GET), `/{requestId}/cancel` (POST) | Submit, check or cancel a request for resource consent | Exchanged token with a current application assignment in the original unit | Resource consent requests below |
| `/v1/me/resource-consent-requests` (GET), `/{requestId}/accept` and `/{requestId}/decline` (POST) | List and decide the subject's pending resource consent requests | Own login token with a verified subject binding | Resource consent requests below |
| `/v1/me/data-access` (GET), `/{accessId}/flag` (POST) | Merged access history naming the caller as data subject; flag a visible entry for review | Verified client and own tenant, issuer and subject | [SECURITY.md](SECURITY.md) |
| `/v1/me/emergency-accesses/{executionId}/feedback` (POST) | The subject's feedback on their own break-glass access | Verified client and own tenant, issuer and subject | [SECURITY.md](SECURITY.md) |
| `/v1/emergency-accesses` (GET), `/{executionId}/review` (POST) | Review break-glass invocations | List: management `trust.approve` or `audit.read`; review: `trust.approve` and writer | [SECURITY.md](SECURITY.md) |
| `/v1/events` (GET) | Live task, record status and consent references over SSE | Bearer with `core-reader` and current resource authorization | Live events below |
| `/v1/queues/{queue}` and its message, lease and dead-letter routes | Deliver background jobs across applications | Active enrolled backend with queue access | Message queues below |
| `/v1/audit-events` (GET, POST), `/v1/audit-events:export` (GET), `/v1/audit-events/verify` (POST) | Append, query, export and verify the tenant audit chain | Active app writer for append. App self, assigned regulator or management `audit.read` for reads. Management `audit.read` for verify. | Application audit log below and [SECURITY.md](SECURITY.md) |
| `/v1/metrics/traffic`, `/requests`, `/features` (GET) | Per-tenant, process-local traffic observations | Management `audit.read`; verified client ID | Traffic metrics below |
| `/v1/directory/principals`, `/organizations` (GET) | Tenant principal/application directory | Management `audit.read` | Tenant directory below |
| `/v1/directory/unit-types`, `/units`, `/units/{unit}/groups`, `/units/{unit}/members` (GET), item PUT/DELETE | Directory management desired state | Management `directory.write`; writer for mutations. Console roles can list units, groups and members. | Tenant directory below |
| `/v1/storage/summary`, `/files`, `/collections` (GET) | Storage aggregates and reduced metadata | Management `audit.read` | Storage summary and workflow history below |

Nginx uses a Core authorization subrequest for versioned paths. The token exchange handler authenticates both input tokens itself. With both `config.executionRuntime` and
`config.compositionRuntime` absent (default `C4A_ENABLED=false`, `C4B_ENABLED=false`), invocation/introspection
paths fall through to Core `404`. Composition registry paths likewise return `404` without `config.compositionRuntime`.
With only composition enabled, capability-target submission returns `422 capability_runtime_disabled`.
Authentication or gateway errors can precede these responses. See [CAPABILITIES.md](CAPABILITIES.md) for supported opt-in operations.

## Identity and gateway

- `GET /health` checks process liveness. `GET /ready` returns `200` or `503`, checking OIDC discovery/issuer
  and configured data RLS access, filer metadata/registered volume, ClamAV, secrets service and authenticated workflow engine.
  Readiness does not prove every future operation or complete disaster recovery.
- `GET /metrics` serves the Prometheus text format (version 0.0.4) with request counters by method, route family
  and status, cumulative request duration and process uptime, start time and memory gauges. Prometheus cannot speak
  OIDC, so the route is unauthenticated by design; Core publishes it only on the internal monitoring network and the
  gateway never proxies it, so gateway callers receive `404`. Counters include unauthorized requests and unknown
  routes, while `/health`, `/ready` and `/metrics` itself are excluded so a scrape never counts itself. Route labels
  reuse the fixed feature families of the traffic metrics below. Query strings are ignored; other methods return
  `405` with `Allow: GET`. Unit tests in tests/metrics.test.mjs exercise the response format.
- `GET /v1/identity` returns `{subject,tenantId,roles,units,unitPaths,groups}` and optional `preferredUsername` from the caller's own
  safe `preferred_username` claim (well-formed, nonblank, at most 255 code points, without C0/DEL controls).
  `units` lists the caller's verified unit IDs. `unitPaths` pairs each ID with its full provider group path
  (`/{tenant}/{unit}`). `groups` uses tenant-relative `/unit/group` paths. These arrays default to `[]`.
  For an app-scoped bearer, Core resolves the effective unit from the verified token and current assignment
  and limits all three arrays to that unit. An operator-bound `subjectId` claim appears only while the binding maps it to the
  caller's own login subject in this tenant and issuer; it is distinct from `subject` and never looked up from
  provider administration.
- `/identity/realms/junctura/.well-known/openid-configuration` provides upstream discovery;
  use standard OIDC authorization, token/refresh, userinfo, keys and logout APIs.

Gateway auth-request and Core independently introspect bearer tokens through confidential client `junctura-core`.
Tokens must be active, unexpired, from the configured issuer, have audience `junctura-core`, role `core-reader`,
and a `tenant_id` present in authoritative `tenant_memberships`. Caller tenant headers are ignored; provider failures
fail closed with `503`. Core returns only supported reader/writer roles. Group membership and role grants are administrator-owned;
a tenant attribute alone grants no membership. Keycloak remains the authority for login tokens and user status.

The imported realm supplies two service-account tenants, a read-only account and tenant-A `local-user` with random
credentials from ignored `.env`. Registration is disabled. Public client `junctura-local` requires authorization-code
S256 PKCE and permits exactly `http://127.0.0.1:9876/callback`. These are local fixtures, not account provisioning.
Keycloak imports only into an empty database; edit existing realms through reviewed administration, never by deleting a volume.
`npm run setup` creates ignored random credentials and refuses to overwrite an existing `.env`; see [GETTING_STARTED.md](GETTING_STARTED.md).

Unknown routes return `404`; invalid/denied credentials return `401/403`. Nginx limits versioned requests per source
address to 100 requests/second with burst 50 (`429`), body reads to 10 seconds, upstream connect to 3 seconds,
and upstream send/read to 15 seconds. Upstream URLs are fixed configuration. Auth subrequests and provider ports are unpublished.

## Delegated application access

The application backend sends `POST /v1/token-exchange` with its enrolled service account's access token in `Authorization: Bearer` and the user's login access token in a JSON body `{"subjectToken":"<user-access-token>"}`. The login token must come from the same application client and tenant. Core resolves the user's current assignment and pins the unit selected by the application access rules. If the application credential names a unit, that unit must match.

Present the returned `access_token` as a bearer to `/v1/identity`, `/v1/search`, the resource consent request routes for the requester, or the v2 record, schema and object routes permitted by the current assignment, or single-capability execution routes. It carries the user in `sub`, the app client and its service account in `act`, and the verified tenant and selected unit. Changes to v2 resources require `core-writer` in both input tokens and a current assignment that permits the operation. The bearer lasts at most 60 seconds and expires by the earlier input expiry. To renew access, exchange an active login token and an active service account token again. Token exchange accepts only those two input credentials.

Core uses Keycloak Standard Token Exchange V2 to obtain an access-only user proof and checks it on every delegated call. Core also checks the active app, enrollment, assignment and unit on every call. For an existing realm, apply the token exchange attributes and audience mapper on `junctura-core` from the realm configuration. [Realm configuration](../infra/keycloak/realm.json)

Use the bearer that represents the actor for each route family. Route permissions still apply.

| Route family | Bearer |
| --- | --- |
| Identity | Keycloak login for the user, exchanged bearer for the user acting through an app, or the service account for the app's own identity. |
| V2 records and objects | App login or exchanged bearer with the current unit assignment for user operations. Use the enrolled backend bearer for backend operations. |
| Workflow tasks | Keycloak login with the task's verified unit and candidate group. Claim and completion also require write authority. |
| Audit | Verified management or regulator bearer for its read scope. An enrolled app bearer can read its own events and append with write authority. |
| Capability invocation | Enrolled consumer bearer with the exact invocation grant and write authority. |

Policy refusals return `403` with `requestId`. `not_assigned_to_app` means the current user assignment is missing, `unit_mismatch` means the selected unit is invalid for the call, and `capability_not_granted` means the effective roles or supported route set exclude the operation. `delegation_not_allowed` covers an invalid delegation pairing or a delegated credential whose user proof has become inactive, including a locked user. Tenant audit records `delegation.exchanged`, `delegation.authorized` and `authorization.denied` with the request ID in `reason`, the login in `subject`, the app client in `managementClient` and the application ID in `actorAppId` when the enrollment is verified.

## Capability consent by recipient unit

`POST /v1/me/consents` accepts `recipientUnit` as an alternative to `consumerAppId`.
The caller needs an operator-bound `subjectId`, and the unit must be confirmed in the same tenant.
A unit grant covers the declared capability and purposes for each app independently approved to invoke it
on behalf of a writer with a current assignment in that unit. Send the exchanged bearer to execute and read
that execution. Set `context.dataSubjectKind` to `canonical` and use the bound `context.dataSubject`.
Core checks the consumer app's approved direct grant and the user's effective unit separately.

An authorized request with no matching unit grant receives `403 consent_missing`. Revoked and expired grants
produce `consent_revoked` and `consent_expired`. The execution uses its original grant for retries, result reads
and provider redemption. Removing a unit revokes its grants. A legacy app grant remains scoped to that app's
backend invocation. An undisclosed subject or capability yields `404 not_found`.

## Resource consent

With your own login bearer and a verified `subjectId`, send `POST /v1/me/resource-consents` with a UUID `Idempotency-Key` and a JSON body like this.

```json
{
  "resourceType": "record",
  "resourceId": "44444444-4444-4444-8444-444444444444",
  "recipientUnit": "unit-b",
  "purpose": "Review the selected record"
}
```

The recipient must be a confirmed directory unit in your organization. Core records the verified user's login as the subject of a new record created through an assigned application. A record needs this association to be eligible for consent. Use `resourceType: "object"` to grant access to a specific version of an object attached to your record. A new object version or a recreated record needs its own consent.

Supply a future UTC `expiresAt` to set a time limit. Omit it to grant consent until revocation. Creation returns `201` and repeats the original result for an identical key and body for 24 hours. `GET /v1/me/resource-consents` returns your grants under `consents` with their status. A grant becomes `inactive` if its recipient unit is removed while it is active. Send `POST /v1/me/resource-consents/{consentId}/revoke` with `{}` to revoke. The response shows the recorded `revokedAt`, including on subsequent revocation requests.

For consent-based access, a user in the recipient unit presents an exchanged bearer for an application currently assigned to that user in that unit. The grant covers exact reads through `GET /v2/data/{collection}/{id}` or `GET /v2/objects/{id}`. Application permissions for lists, searches and writes follow their existing rules. If ordinary read authority is absent and the selected unit's matching consent was revoked or expired, Core returns `403` with `consent_revoked` or `consent_expired` and a `requestId`. Without a matching grant for that unit, the usual resource or unit denial applies.

The subject's `GET /v1/me/data-access` shows the attempt under `action: "resource.read"` with the reader's login, recipient unit, app, time, resource reference, consent ID, request ID and outcome. An authorized tenant reader can query `GET /v1/audit-events?action=resource.read` for the Core audit entries, which also include the resource subject ID and the application client ID.

### Resource consent requests

With an exchanged bearer, send `POST /v1/resource-consent-requests` with the resource type (`record` or `object`), ID, purpose and a future UTC expiry.

```json
{
  "resourceType": "record",
  "resourceId": "44444444-4444-4444-8444-444444444444",
  "purpose": "Review the selected record",
  "expiresAt": "2030-01-01T00:00:00Z"
}
```

Core uses the verified subject of the resource in the caller's organization and the requester's currently assigned unit. A viewer assignment is sufficient. A pending request for the same resource, unit and purpose returns `409 consent_request_already_pending`. A new request returns `201` with its `requestId` and a `Location` header. The original requester uses that location with a current exchanged token for the same unit to check `pending`, `accepted`, `declined`, `expired` or `cancelled`. To cancel a pending request, send `POST /v1/resource-consent-requests/{requestId}/cancel` with `{}`.

The subject uses their own verified login to call `GET /v1/me/resource-consent-requests`. The `requests` array contains pending requests, newest first. Post `{}` to `/v1/me/resource-consent-requests/{requestId}/accept` or post `{}` or `{"reason":"The proposed duration is too long."}` to `/v1/me/resource-consent-requests/{requestId}/decline`. The requester can see `declineReason` when supplied. A decision or cancellation after the request is settled returns `409 consent_request_not_pending`. If the requested version or recipient unit has become unavailable, acceptance can return `409 consent_request_target_changed`.

Acceptance uses the proposed expiry and returns the new `consentId`. The resulting resource consent includes the original `requestId` and follows the read and revocation behavior above. The request stays `accepted` after grant revocation. A pending request reaches its deadline at `expiresAt`. The next authorized check or submission for the same pending-request key records and audits the expiry. Unit retirement closes pending requests. Tenant audit records each transition as `audit.resource_consent_request_<status>`, with the consent request ID in `resourceId`. Authorized tenant readers can query those events with `GET /v1/audit-events?action=audit.resource_consent_request_accepted`.

## Structured data

| Route | Methods | Contract |
| --- | --- | --- |
| `/v1/data/{collection}` | GET | `{items:[...],nextCursor}`; optional `limit` 1–100 (default 100), `order` (`asc` or `desc`, default `asc`), `cursor` |
| `/v1/data/{collection}` | POST | `{data:{...}}`; `201` with generated UUID |
| `/v1/data/{collection}/{id}` | GET, PATCH, DELETE | Read, replace `data`, or delete a tenant record; inaccessible IDs return `404` |

Collections match `^[a-z][a-z0-9_-]{0,62}$`; IDs are lowercase UUIDs. JSON writes require `application/json`, at most
64 KiB and exactly one object-valued `data` field. Unknown envelope fields/query parameters are rejected.
All access requires reader; mutations require writer. Responses expose only ID, collection, JSON data and creation time. V1 collections are schemaless.

V2 has the same methods/envelopes under `/v2/data`, with server-resolved owner application, owner-only writes and
exact resource read shares. Active registration/backend binding and live app state are checked; see [SECURITY.md](SECURITY.md).
V1 remains tenant storage behind the explicit legacy allowlist; no ownership migration is automatic.

Both list routes order by `(created_at, id)` in the requested direction. Pass a non-null `nextCursor` as `cursor`
with the same `order` to read the next page; `nextCursor: null` means no further row was found. Cursor timestamps
retain the database's full precision. Cursors are opaque base64url strings of at most 512 characters.
Unknown or repeated list keys and invalid `limit`/`order` return `400 invalid_query`; malformed cursors and an
order mismatch return `400 invalid_cursor`. Item GET accepts only `limit`, validates its first value (1–100,
default 100) and returns one record even if a larger limit is supplied. It continues to accept repeated `limit`
keys using the first value. `order` and `cursor` on item GET, and all query keys on writes, return `400 invalid_query`.

Core signs 30-second tenant assertions for PostgREST with audience `junctura-data`.
The database role is `junctura_api` for v1 records and `junctura_record_api` for v2 record operations.
Caller tokens are not database credentials. PostgreSQL FORCE ROW LEVEL SECURITY
checks tenant/resource claims. The signing secret stays private; no anonymous PostgREST role or data/database port is published.
`data-migrate` applies versioned SQL transactionally, retaining data and recording checksums; changed applied migrations
are refused. Add reviewed migrations for schema changes. Named volumes survive `docker compose down`; never use `down -v` on persistent data.

### Versioned records

| Route | Methods | Contract |
| --- | --- | --- |
| `/v2/data-schemas/{collection}` | PUT | Register a collection schema and indexed, searchable, sensitive and unique fields. |
| `/v2/data-masking/{collection}` | GET, PUT | Read or replace the calling app's field masking policy. |
| `/v2/data/{collection}` | POST | Create a record with a generated ID and version 1. |
| `/v2/data/{collection}/{id}` | GET, PATCH, DELETE | Read, replace, increment or delete an individual record. |
| `/v2/data/{collection}/{id}:lock` | POST, DELETE | Acquire, renew or release an exclusive lease. |
| `/v2/data/{collection}/by-key/{key}` | PUT | Create or conditionally replace by a case-sensitive unique key. |
| `/v2/data:batch` | POST | Apply 1–50 operations in request order in one transaction. |

V2 collection schemas use `type`, `required`, `properties`, `enum`, `minLength`,
`maxLength`, `pattern`, `minimum`, `maximum`, `items` and `format` for dates and
date-times. The root is an object and the maximum schema depth is eight. Patterns are at most 256
characters and use PostgreSQL regular expressions with C collation. The subset
supports ASCII literals, character classes, anchors and quantifiers on single
atoms. Grouping, alternation and backreferences are outside the subset.
Indexed fields have a declared scalar type. Dates and offset date-times are
normalized to UTC in the index at PostgreSQL's microsecond precision. Record
writes reject numbers outside ±2^53 or numbers that lose decimal precision
during HTTP parsing. Core measures the 64 KiB data limit in compact UTF-8
JSON with insignificant whitespace and trailing decimal zeros removed.

Schema registration validates existing records and rebuilds their indexed field
values in one transaction while holding the collection's write lock. The record
RPC has a 4-second statement timeout and a 2-second lock timeout. A timeout rolls
back the registration and can return `503 data_unavailable` to it or to writers
waiting on the collection. Register schemas before bulk loads. For populated
collections, schedule registration during low write traffic and validate its
duration with representative data before updating large collections.

The owner receives a strong, incarnation-specific ETag on individual reads and
writes. Keep the complete tag, including the quotes. In compatibility mode,
unkeyed creates and individual reads retain their legacy bodies. Creates with
an idempotency key return a versioned body. To require keys on creates and
preconditions on replacements and deletes, set `STRICT_RECORD_WRITES=true`
on every Core replica. In strict mode, the default list scope is the calling
app and list items include their version. Restart pagination after switching
modes. For management readers with an explicit app-level grant, Core omits
schema-sensitive fields that have no field masking rule.

In compatibility mode, `409` from `POST /v2/data/{collection}` and
`PATCH /v2/data/{collection}/{id}` returns `error: "conflict"` with the specific
code in `details.code` and any increment field in `details.field`. This applies
with or without an idempotency key. Strict mode puts the specific code in `error`
and returns an increment field at the top level.

#### Field masking

`GET /v2/data-masking/{collection}` returns `{collection, fields}` for the caller's
app, with empty `fields` by default. To replace the policy, send
`PUT /v2/data-masking/{collection}` as the owning backend with `core-writer`
or as a verified app manager with write access. For example:

```json
{
  "fields": {
    "nationalId": { "mask": "full", "owner": true },
    "phone": { "mask": "last4", "roles": ["manager"] }
  }
}
```

The policy applies to top-level fields of existing and future records in that
app's collection, including schemaless collections. `full` returns `"***"`.
`last4` prefixes the last four characters with `***` for strings longer than
four characters and uses `"***"` for shorter strings and other values. Absent
fields stay absent. Send `{"fields":{}}` to clear the policy.

A field is shown in full when any of its configured conditions is met after
the reader has been authorized to access the record.

- `owner: true` allows the owning backend and the verified user who created the
  record through the owning app.
- `roles` allows verified `core-reader`, `core-writer` or `regulator` roles,
  or a verified `viewer`, `editor` or `manager` role in the owning app.
- `shareIds` allows readers covered by one of the specified exact-app record
  shares for that field. Create each share with `POST /v2/resource-shares`
  and use its returned `shareId`. Expiry and revocation also end clear access.

Core applies the policy to individual reads, both list modes, NDJSON exports,
and record bodies returned by writes or idempotency replays. Batch results
contain operation metadata. Core records `audit.record_fields_revealed` with
the reader and record ID whenever it returns one or more clear fields covered
by the policy. The audit entry carries no field values.

Masked fields are excluded from filtering, sorting, grouping, search indexing
and increment operations. A unique key cannot also have a masking rule.
Updating a policy invalidates existing filtered query cursors for the collection.
An NDJSON export reflects the reader's access, so masked values in it may fail
validation if the export is imported into a collection with a registered schema.

#### Filtered lists and aggregates

`GET /v2/data/{collection}` filters indexed fields with `where[field]`. Use a JSON scalar after `eq:`, a
non-empty JSON array of scalars after `in:`, a JSON string or number after `gte:` or `lte:`, and a JSON
string after `prefix:`. Operands must match the declared field type; integer fields reject fractional
values and every numeric operand must survive HTTP parsing without losing decimal precision. URL-encode
the operands.

Set `sort=field.asc` or `sort=field.desc` to order by one indexed field. `sort` is mutually exclusive with
`order`; without `sort`, `order` controls creation-time order. Missing and null sort values come last and
`id` breaks ties. Send `nextCursor` back as `cursor` with the same owner, filters, ordering and schema
revision. Cursors are opaque and signed; a changed owner, filter, ordering kind or schema revision returns
`400 invalid_cursor`. System ordering and a data field named `created_at` are distinct bindings even though
both expose `created_at`.

`GET /v2/data/{collection}/aggregate?count` counts readable matches. Repeat `groupBy` for up to two
indexed fields or UTC day buckets such as `day(createdOn)`; day buckets require a date or date-time field.
Missing values group as `null`. Queries that would return more than 1,000 groups return
`400 invalid_query`. Each query reads matching rows from one snapshot. Core holds the collection's
schema and masking policy for the duration of a filtered list request.

Management readers with an explicit app-level grant can list or aggregate another app's collection with
`ownerAppId`. Schema-sensitive fields and fields with masking rules are unavailable for these readers'
filters, sort keys and group dimensions. A scope the caller may not read returns `404 not_found`.

In compatibility mode (`STRICT_RECORD_WRITES=false`), a list without `sort`, any `where[...]` or
`ownerAppId` keeps the legacy body and cursor without `version` fields. Strict mode and any filtered list
return the versioned page. Restart pagination after switching modes.

#### Read-only record lifecycle

`POST /v2/data/{collection}/{id}:archive` marks an owned record read-only and advances its ETag.
Send `If-Match` with the current ETag. A delegated caller also needs the app manager role.
An optional `Idempotency-Key` replays the original receipt. The receipt and subsequent detail
and list responses include `archivedAt`. Updates, deletes, increments, locks and upserts
against an archived record conflict with `409`. Batches containing such a mutation roll back.

Authorized readers keep their read access. Details, lists, exports and search references
generate `audit.archived_record_read` with actor, record, time and the request ID in
the audit reason field. The event stores neither record data nor search terms.
Aggregates continue to include archived records in the caller's existing read scope.

### Record archives

`GET /v2/data:export` streams a consistent snapshot of the calling app's records as UTF-8 NDJSON in
`(collection, id)` order, containing record IDs, collections and data. Collection definitions, revisions,
shares, file bytes and audit rows are outside the format. Register schemas before importing data that needs
validation. Core reads the first page before sending `200`, bounds snapshot bytes and concurrent snapshots,
and removes the snapshot when streaming ends, fails or the client disconnects.

`POST /v2/data:import` accepts that NDJSON format, preserves record IDs, starts new versions at 1 and
applies schema, uniqueness and quota checks in one transaction. The body is required; blank lines, a BOM
and more than one object per line are rejected. Any failed line rolls back the whole upload. Schema and
framing failures report the one-based input line as `issues[].line`; an existing record ID conflicts. The
record data limit is 64 KiB in compact UTF-8 JSON. Per-collection record counts and per-app file bytes are
subject to configured quotas.

#### App-group read shares

`POST /v2/resource-shares` accepts `granteeAppGroup` for a read share of one catalog record, or
`granteeAppId` for an exact app share of a record or object. A group share applies to one record and
expires within 24 hours. `expiresAt` is a real UTC instants ending in `Z`, with seconds or exactly three
fractional digits. Group membership and share expiry are checked when a recipient reads; removing
membership, revoking the share, expiry or app suspension terminates subsequent reads. Revoke either kind
with `DELETE /v2/resource-shares/{shareId}`. Reusing an `Idempotency-Key` with a different body returns
`422 idempotency_key_reused` with a `requestId`. Shares grant no write or onward grant authority.

When listing another app's collection, set `ownerAppId` to see only the records explicitly shared with the
caller, including live app-group shares with current membership.

## Unstructured objects

| Route | Methods | Contract |
| --- | --- | --- |
| `/v1/objects` | POST | Generated UUID upload; `201 {id,size}` |
| `/v1/objects/{uuid}` | PUT | Caller-chosen UUID upload/replace; `201` created or `200` replaced |
| `/v1/objects/{uuid}` | GET, DELETE | Read/delete a tenant object; inaccessible or missing IDs return `404` |
| `/v2/objects` | POST, GET | Multipart or octet-stream upload with owned `recordRef` and `tags`; authorized metadata list |
| `/v2/objects/{uuid}` | PUT, GET, DELETE | Replace with metadata merge semantics; download; tombstoning delete |

Uploads require writer and 1 byte–5 MiB file bytes. The UUID `Idempotency-Key` stays optional for
backward compatibility: a keyless upload records no receipt, so a retry publishes a new version,
while a request that carries a key replays its first committed result for 24 hours. V2 accepts
`multipart/form-data` (exactly one `file` part plus optional `recordRef` and `tags` JSON parts) or
`application/octet-stream`. A missing metadata part preserves the previous value on replace while an
explicit `null`/`[]` clears it; the idempotency digest covers file bytes and metadata presence, so a
changed part under the same key replays nothing and returns `422 idempotency_key_reused`. A `recordRef`
must point to a live record owned by the caller; the stored link keeps the record's incarnation, a
deleted or re-created record makes the link invalid without deleting the file, and links confer no read
access. Query parameters, invalid paths and unsupported upload content types are rejected. Bytes are
opaque; original filenames and MIME-based rendering are not API inputs. Downloads use octet-stream,
attachment disposition, `nosniff` and `no-store`.
V2 ownership resolves server-side: only owner writes and exact read shares authorize a listing
(`recordRef[collection]` and `recordRef[id]` together, a `tag`, or both; sorted by object ID with a
caller-bound cursor). The per-app quota charges the bytes of currently published versions under a
per-app lock and answers `429 quota_exceeded` with `quota.resource: appFileBytes`, `limit` and `used`;
replacement charges the delta and deletion releases the size. An internal reconciliation task
measures versions the quota does not know yet from the Filer's current bytes, so while any version
is unmeasured the upload answers `503 quota_unmeasured` and the listing omits it; a version whose
bytes no longer exist stays uncounted. Every upload records its candidate version before the Filer
stores bytes, and the reconciliation task removes staged versions only after confirming the
database no longer references them, so a lost commit response never deletes published bytes. See
[SECURITY.md](SECURITY.md) for resource authorization.

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
| `/v1/workflows/definitions` | GET | Up to 100 latest tenant definitions with ID, key, version and name. |
| `/v1/workflows/executions` | POST | Start by exact `definitionId` with optional `input`, `unit`, `taskUnits`, `dueAt` and `taskDueAt`. Requires a UUID `Idempotency-Key`. |
| `/v1/workflows/executions/{executionId}` | GET | `{id,definitionId,status,input,dueAt}`. Status is `running`, `completed` or `cancelled`. If deadline storage is unavailable, `dueAt` is null. |
| `/v1/workflows/tasks` | GET | `{items,nextCursor}` for waiting tasks in the caller's candidate groups. |
| `/v1/workflows/tasks/{taskId}/claim` | POST | Optional `{ttlSeconds}`. Returns `{taskId,claimedBy,claimedUntil}`. |
| `/v1/workflows/tasks/{taskId}/release` | POST | Returns `204` when the caller's claim is released or the task is already unclaimed. |
| `/v1/workflows/executions/{executionId}/complete` | POST | Business completion by `{taskId,variables?,output?,records?}` with a UUID `Idempotency-Key`. Returns `202` and `{taskId,completionStatus:"pending",execution}`. |
| `/v1/workflows/executions/{executionId}/history` | GET | `{items,nextCursor}` for confirmed task completions, newest first. |
| `/v1/workflows/executions/{executionId}` | DELETE | Cancel a running execution. Returns `204` on cancellation and on repetition. A pending completion or a completed execution conflicts with `409`. |

Reads require `core-reader`. Writes also require `core-writer`. Foreign tenant definitions, executions
and tasks return `404`. The internal C4A definition is excluded. Keep private data out of workflow
variables, which are visible within the tenant. Start JSON is limited to 64 KiB with input nesting at most 32.

### Deadlines, task routing and claims

An operator binds each business definition version to a default unit and allowed units. The caller needs
verified membership in the resolved default unit. Per-step overrides also require membership in the
destination unit or the Keycloak `workflow-router` realm role. The role cannot route outside the
definition's allowed units and it grants no task claim or completion permissions.
Existing realms can add the role in Keycloak and assign it to designated callers.
`taskUnits` and `taskDueAt`
use BPMN user-task element IDs. An unknown ID is invalid. A step uses the execution deadline unless it has
an override, including when a step is revisited. Deadlines use absolute timestamps and mark work overdue.

The inbox supports `definitionKey`, `unit`, `candidateGroup` and `overdue=true|false`. Eligibility
requires a verified path for the task's unit and one of the definition's candidate groups. Filters narrow
that set. Tasks sort by deadline ascending, then task ID, with undated tasks last. Each parallel step has its
own task ID. Both inbox and history accept `limit` from 1 to 100, default 20, and an opaque `cursor` from the
previous page with the same filters.
Each inbox request scans at most 20 Flowable pages of 100 active tasks in task ID order before applying
unit, candidate-group and deadline filters. Supply `definitionKey` to limit the scan to that definition key.
The inbox cursor paginates the scanned set.

An eligible writer can claim a waiting task for 1800 seconds by default or up to 28800 seconds.
A repeated claim by the holder returns its existing expiry. An expired claim becomes available again.
An active claim belonging to another writer returns `409 task_claimed` with its display name and expiry.
Completion requires a matching group (`403 task_group_required`) and either an unclaimed task or the
caller's own claim. A new attempt to complete the same finished task returns `409 task_already_completed`.

### Completion, history and retries

`variables` accepts strings, numbers and booleans up to 4096 bytes as compact UTF-8 JSON.
`input` and `__junctura_completion` are reserved. `output` accepts an optional business result as a
JSON object up to 65536 bytes as compact UTF-8 JSON. Its keys become process variables like `variables`;
structured values are stored as JSON strings, output keys must not collide with `variables` keys, and
`output` that is not a JSON object returns `400 invalid_request`. `records` can create up to ten records in collections
owned by the caller's enrolled, active app. The token must also carry an operator-bound verified subject
for record-bearing requests. Core commits all records, the completion outbox entry and the replay receipt
in one PostgreSQL transaction. Each parallel task can be completed by its own ID.

Within the 24-hour receipt window the same key and logical request return the original response, including
the original `202` after confirmation. Current authorization is checked on each request. A changed
logical request with the same key returns `422 idempotency_key_reused`. The worker retries pending
engine transitions and checks Flowable's tenant, process instance, execution, task and task-local completion
marker before publishing history. History shows the actor, unit, first matching candidate group in BPMN
order, optional decision and reason, and engine completion time. It is available to eligible execution
members and enrolled `audit.read` principals. Checkpoints and executions without task policy or user tasks
return an empty page after the tenant execution is verified.

A cancellation in progress returns `409 task_conflict` to a competing cancellation. If cancellation
fails and Flowable still reports a running execution, Core releases the cancellation lease so tasks
can resume. If confirmation is unavailable, a new cancellation can take over after 60 seconds.

A business start replays its original `201`. The permanent start reservation protects against duplicate
engine instances even after receipt expiry. If start is uncertain, retry with the same key. Core looks up
the exact tenant, definition and business key in Flowable history. It returns `409 execution_pending_reconciliation`
until there is a unique result. Operators resolve stranded reservations after checking engine history.

The technical `junctura_checkpoint` retains its empty-object completion with `200`, including repetition
after completion. Earlier executions without task policy can drain through the same single-task path.
A checkpoint started with just definition and input retains the original `200` replay. Changed input or
options with the same checkpoint start key returns `409 idempotency_conflict`, including across the two start paths.

## Business workflow definitions

Applications maintain business BPMN outside the Core image. Operators set `WORKFLOW_DEFINITIONS_DIR` to their directory; unset/empty uses [infra/workflows](../infra/workflows/README.md), which contains no business BPMN.
[Example workflows](../examples/workflows/README.md) are not deployed by default. `workflow-init` mounts the directory read-only at `/definitions/business` and recursively collects `*.bpmn20.xml`;
the technical checkpoint mount is separate. `WORKFLOW_TENANTS` defaults to `demo,production,tenant-a,tenant-b`, trims comma-separated
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

After deployment, an operator inserts or updates a row in `app_private.workflow_definition_policies` using the
exact `(tenant_id, definition_id)` from the deployed version. Set `default_unit` and `allowed_units` to
operator-managed directory units. Define at least one `flowable:candidateGroups` entry on every business user
task, and register those groups in each unit where the step will run. Core captures the assignments at start.
Create a binding for each newly deployed version before accepting business starts for that version.

Flowable owns process execution and durable task history. Core holds the deadlines, claims and completion
outbox in PostgreSQL. Inspect the private outbox for `cancelled` or `unconfirmed` rows when reconciling
records accepted before an external engine change.

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
(registry/executions/compositions), applications, consents and break-glass access, secrets and audit.
Directory, identity, metrics and unrecognized paths map to `other`; only observed features appear. See
[metrics.mjs](../src/modules/metrics/metrics.mjs) for the exact mapping. These views never change workflow state.

## Tenant directory

| Route | Methods | Contract |
| --- | --- | --- |
| `/v1/directory/principals` | GET | `{items:[{subject,issuer,managementClient,permissions,enabled,displayName,organization,jobTitle,kind}],truncated}` |
| `/v1/directory/organizations` | GET | `{root:{id,name,kind,children},relations:[{from,to,label}],truncated}` |

Both require management `audit.read` in the caller's tenant/issuer, reject query parameters, and return `no-store`. The private `junctura_directory_api` role reads local tables; it never returns secrets/tokens/bodies.
Principals are capped at 1000, ordered by subject/issuer/client. Nullable bounded profile fields are operator-owned
presentation metadata, not provider claims; `kind` is `admin`, `application` or `null`.
The organization root is the tenant (`platform`); children are registered applications (`application`), without a separate organization table.
Relations include active, unexpired direct grants only; labels use the capability title, falling back to its exact ID.
Limits are 1000 applications and 500 relations; `truncated` reports overflow. Application names come from registrations;
other principals use subjects, while callers can obtain their own `preferredUsername` from identity.

An enrolled management principal with `directory.write` additionally manages the organization itself:
list `/v1/directory/unit-types` and `/v1/directory/units` with `limit`/`cursor` keyset pages, then PUT or DELETE
`/v1/directory/unit-types/{unitType}`, `/v1/directory/units/{unit}`, `/v1/directory/units/{unit}/groups/{group}`
and `/v1/directory/units/{unit}/members/{subject}`. Mutations additionally require the `core-writer` role.
Units stay flat; every referenced unit type, unit or group
must already exist, and a member's `groups` array replaces that unit's group assignments for one existing tenant
subject. Every change is stored as desired state with a per-row generation and applied to the identity provider
through a dedicated service account; the API reports success only after reading the provider back and finding
exactly that generation, and a retry of the same desired state converges. Deletions stay as durable tombstones
until confirmed, so a generation is never reused across a delete and recreate, and every command serializes on a
per-tenant advisory lock in PostgreSQL, so concurrent replicas never overwrite one another. PUT returns `201` for
a new row and
`200` for an updated or identical one; repeating a DELETE returns `204`; deleting a resource that is still
referenced conflicts with `409 resource_conflict`. Previously issued tokens can retain old membership claims
until they are renewed. The provider realm keeps organization groups under a per-tenant namespace, so verified
group paths are `/{tenant}/{unit}/{group}` upstream and `/unit/group` in Core responses; tenant membership
itself is proven only by the exact root group path `/{tenant}`.
## Application deployment and access

`GET /v1/applications` filters the visible registrations by `q` (case-insensitive display-name substring),
`state` and deployment `unit`. It sorts by application ID and returns `{items, nextCursor}`. The default
page size is 50 and the maximum is 100. Pass the returned `nextCursor` as `cursor` with the same filters.
A null cursor ends the list. Enrolled owners see their apps. Console viewers and management readers see
registrations for their tenant and issuer.

`PATCH /v1/applications/{appId}` accepts `displayName`, `ownerUnit` and `deploymentUnits` and checks the
current `If-Match`. Deployment units and the owning unit reference confirmed directory units. An owning
unit is required when any deployment unit is set. Revoke the unit's assignments before removing it.
The revision advances on changes. An approval made for a prior revision must be renewed. The approved
OIDC client ID and origin follow the enrollment and lifecycle contract.

`POST /v1/applications/{appId}/assignments` takes `unit`, `targetType`, `target` and `role`. A unit
assignment repeats the unit ID in `target`. Use a directory group ID or a member's login subject for
the other types. For example, App X can grant `viewer` to `reviewers` in `unit-a`. `viewer` can read
records and objects, `editor` can also write, and `manager` can additionally register record schemas.
The `GET` endpoint lists assignments and their synchronization state. `DELETE` makes revocation effective
in Core before removing the Keycloak role. Retry the same request when synchronization is unavailable.
A Core worker retries pending role changes and removes assignments whose directory target was deleted.
While a revocation is pending (`enabled: false`, `synchronized: false`), reassigning the same unit,
target type, target and role returns `409 resource_conflict`. Wait for that pending assignment to
disappear from `GET /v1/applications/{appId}/assignments`, then retry the same `POST` with backoff.
A successful re-grant has a new assignment ID. The assignee needs a new token to use the grant.

Keycloak binds the browser and enabled direct-grant flows to a client-specific access role. Use an
exact registered redirect URI with S256 PKCE for browser access. Provider roles and unit membership
come from the verified token, and Core checks them against PostgreSQL on each request. For people with
eligible assignments in one unit, that unit is selected. People with assignments in multiple units need
an operator-set `junctura_unit` attribute in Keycloak. A service account of a partitioned app also needs
this attribute. Keys, body fields and headers supplied by the caller confer no unit authority. Core
restricts deployed-app tokens to identity, records, objects and search. Enrolled owners with
`applications.register` can also list their registrations and manage their own app metadata,
assignments and OIDC keys. A principal with `applications.approve` can manage those resources within
the same tenant and issuer. PostgreSQL restricts row access to the selected unit. Pre-existing rows
without a unit become invisible to unit-scoped tokens. Migrate
them with an explicit owner-approved mapping. Scoped rows stay isolated from legacy unpartitioned callers.

Console requires an explicit `console-admin`, `console-manager` or `console-viewer` client role. Grant
these roles on the Console client to the allowed people. A new local realm imports the service account
and its roles. The default `junctura-app-sync` client is enabled on import when the operator supplies
`APP_SYNC_CLIENT_SECRET`. The service account uses its own `APP_SYNC_CLIENT_ID` and
`APP_SYNC_CLIENT_SECRET`. On an existing local realm or with a custom client ID,
`npm run directory:provision` installs the managed unit attribute and aligns the Console flows. Set the
new app sync credential in the operator's deployment configuration, and assign explicit Console client
roles before enabling the new gateway checks. Core caches live Console role mappings for up to three
seconds. After the cache expires, current roles are required even for an unexpired token. Managed
clients issue short-lived access tokens, and the browser can start another authorization flow when needed.

On approval, Core with Keycloak synchronization and OpenBao configured writes the confidential
client's connection bundle before activating the application. The bundle lives at
`<mount>/data/tenants/<tenant>/connections/<appId>` in the OpenBao KV v2 API. The operator issues an
AppRole scoped to that exact path. The application reads it directly using OpenBao.
See [Application bootstrap](GETTING_STARTED.md#bootstrap-a-server-side-application).

OIDC rotation uses `POST /v1/applications/{appId}/oidc-keys` with `{}` and a UUID `Idempotency-Key`.
Core stages a random secret at `<mount>/data/tenants/<tenant>/oidc-clients/<appId>/<rotationId>`,
applies and verifies it in Keycloak, updates the connection bundle, and confirms the rotation.
HTTP returns rotation IDs and timestamps. After an interruption, retry with the same key.
`GET` shows the latest 100 receipts, including pending rotations with null `appliedAt`.

Application access refusals return HTTP 403 with `{error, requestId}`. The audit event
`authorization.denied` stores the code in `reasonCode` and the request ID in `reason`.
Keycloak logs a denied sign-in and shows the localized reason in its login theme.

| Code | Condition |
| --- | --- |
| `not_assigned_to_app` | The current client role and assignment do not grant access to the application. |
| `capability_not_granted` | The caller lacks the role for the requested operation or the grant to invoke the capability. |
| `consent_required` | A capability call requires the named subject's consent for this purpose. |
| `consent_revoked` | The matching consent was revoked. |
| `consent_expired` | The matching consent passed its expiry. |
| `unit_mismatch` | The selected unit is invalid, or a directly addressed resource belongs to a different unit. |

Run `npm run test:app-access` against an isolated development stack with the migrations and both
synchronization accounts configured. The suite provisions its own Keycloak users and clients,
enrolls two applications, creates directory units, checks browser sign-in and unit isolation, and
rotates the fixture client's secret in OpenBao.


## Application statistics

`GET /v1/applications/stats` requires a verified client ID and management `audit.read` in
the caller's tenant and issuer. It rejects any query string (`400 invalid_query`) and
non-GET (`405`), returns `Cache-Control: no-store`, and fails with `403
stats_permission_required` or `503 application_stats_unavailable`. Results cover only the
caller's tenant and issuer and contain counts, timestamps, display names, states and IDs.

The body has `generatedAt`, `totals` and `applications`. `totals` contains `applications`,
`activeApplications`, `activeLast24h`, `activeLast7d` and `activeConnections`. Each
application contains `id`, `name`, `state`, `registeredAt`, `lastActivityAt`,
`calls.outgoing.last24h`, `calls.outgoing.last7d`, `calls.incoming.last24h`,
`calls.incoming.last7d`, `capabilities.published`, `connections.given`,
`connections.received`, `data.collections`, `data.records` and `files` (`count`, `bytes`,
or `null` when objects storage is not configured).

`lastActivityAt` is the latest actor audit timestamp or consumer/provider execution
creation timestamp. `activeLast24h`/`activeLast7d` count applications active in those
windows; `calls` count executions created in the window; `connections` count active
unexpired grants; `data` counts owned records and distinct collections. No record content,
collection names, object keys, file names, capability manifests, grant proposals, subjects
or audit reasons are returned.

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
read/write the table directly. The private `junctura_audit_api` role executes the audit RPCs.
`POST /v1/audit-events/verify` accepts an empty JSON object and requires management `audit.read`.
Verification checks the per-tenant SHA-256 chain. The deployed operations are documented in
[Capability OpenAPI](contracts/capability-api-v1.openapi.json). See [SECURITY.md](SECURITY.md).

## Application registration and capabilities

Registration, independent approvals, registry versions, authorized discovery and direct trust use private SQL authority
boundaries and enrolled tenant permissions. C3 compatibility is an offline module; C4A/C4B execution is opt-in and disabled
by default. Human delegation and resolver HTTP routes remain unimplemented; design-only execution cancel/resume routes
are not served. [CAPABILITIES.md](CAPABILITIES.md) documents registration, trust, execution, composition and revision/approval rules.

## Tested backend HTTP example

[foundation-http.mjs](../examples/foundation-http.mjs) loads the connection bundle and uses ordinary HTTP
for authentication, private records, binary upload/download, a ten-minute read share and a technical
checkpoint workflow. `npm run test:applications` runs the HTTP workflow with independently approved
fixtures and checks shared read and denied update. `npm run test:app-bootstrap` checks connection bundle
isolation and rotation, and runs the standalone SDK example with AppRole credentials.

For an already operator-enrolled active backend, set these environment variables privately and run `npm run example:foundation`:

```text
JUNCTURA_OPENBAO_URL=<OpenBao origin>
JUNCTURA_OPENBAO_ROLE_ID=<application role ID>
JUNCTURA_OPENBAO_SECRET_ID=<privately provisioned secret ID>
JUNCTURA_GRANTEE_APP_ID=<different active same-tenant registered app UUID>
```

To test the recipient read, supply its `JUNCTURA_GRANTEE_OPENBAO_ROLE_ID` and
`JUNCTURA_GRANTEE_OPENBAO_SECRET_ID` together. The recipient bundle supplies its app ID.
The tenant-a/tenant-b fixtures alone do not grant v2 access. The CLI leaves its records, object and expiring share owned
by the backend and prints IDs without credentials/tokens. Reconcile failed POST outcomes before rerunning;
keep backend secrets out of frontends, repositories and shell logs.

## Planned APIs (not yet implemented)

Each future Operation Object carries `x-junctura-status: planned`.
[Foundation OpenAPI](contracts/foundation-api.openapi.json) covers record storage, workflows, identity,
directory, files, events and search. [Capability OpenAPI](contracts/capability-api-v1.openapi.json)
covers consent, subject access history, feedback, flagging and application audit.
Some proposals extend an existing HTTP method at the same URL. In those cases
`x-junctura-planned-operation` contains the complete future Operation Object on the existing operation.
To build a mock API document, replace each operation carrying that extension with its value and retain the
top-level planned operations. Keep both contract files together so relative references resolve.
Use the current route index for calls to a deployed Core.

### Concurrent writes and retries

Before a record replacement or deletion, GET the individual record and copy its
`ETag` verbatim into `If-Match`. Strict mode requires this on PATCH with `data`
and DELETE, including schemaless collections. PUT by unique key always requires
it for replacements. Supply `ifMatch` on every batch replacement or deletion.
A missing required precondition returns `428`. On `412`, reread the record,
reconcile your edits and submit the new precondition.

For relative changes to indexed numeric fields, send PATCH with `operations` and use
`increment` with a positive or negative `by`. Core applies the arithmetic in one database
statement. Optional `min` and `max` bound the result inclusively. Increments can
omit `If-Match` in strict mode because they operate on current values.

Use `POST /v2/data/{collection}/{id}:lock` to reserve a record during an edit. The lock expires
after 5 minutes by default and can last up to 30 minutes per request. Renew it with the returned
`lockId` and a fresh idempotency key. To release it, send DELETE to the same URL with the
`Lock-Id` header. Other callers receive `423` on edits and deletes. The holder follows the same
`If-Match` rules as any writer. Only the holder may release an active lock. Use a task claim to
reserve a workflow step while someone works on it.

Send a UUID `Idempotency-Key` when creating a record, writing a batch, importing records, upserting
by unique key, incrementing with PATCH, acquiring or renewing a record lock, starting a workflow or
completing a step, appending an audit event, uploading a file with replayable retries, creating a
share or granting consent. Plain `application/octet-stream` uploads and record creates without a key
stay compatible and record no receipt. Core keeps the first recorded result for 24 hours in the
verified tenant, caller, method and URL
path scope. A retry with the same key and logical request, including any write precondition, replays
the original status, body and resource headers. A changed request with the same key returns
`422 idempotency_key_reused`. Use a fresh key for each new operation.

Record writes save receipts for `2xx`, `409`, `412`, `422` and `429`. A `423`
can be retried with the same key after the lock expires or is released. After
`400` or `428`, correct the request and retry with the same key.

If a batch increment produces data that violates the collection schema, the issue
points to the resulting field at `/operations/N/data/<field>`, using a zero-based
batch index and JSON Pointer escaping.

With `quantity` registered as an indexed numeric field, send this body with an `Idempotency-Key`
to `POST /v2/data:batch` to decrease stock for two items together. If either quantity would go
below zero, Core returns `409 limit_exceeded` and both quantities stay the same.

```json
{
  "operations": [
    {
      "op": "increment",
      "collection": "inventory",
      "id": "44444444-4444-4444-8444-444444444444",
      "operations": [{"op": "increment", "field": "quantity", "by": -10, "min": 0}]
    },
    {
      "op": "increment",
      "collection": "inventory",
      "id": "55555555-5555-4555-8555-555555555555",
      "operations": [{"op": "increment", "field": "quantity", "by": -3, "min": 0}]
    }
  ]
}
```

### Identity and directory

An enrolled `directory.write` principal manages `/v1/directory/unit-types`, `/v1/directory/units`,
and each unit's `groups` and `members`. List each collection and use PUT or DELETE at an item URL.
Core takes a PostgreSQL lease per tenant before changing desired state. A competing write can return
`409 resource_conflict`. Provider mutations renew the lease, and confirmation requires both the current
lease and row generation. GET lists show the last confirmed values. With no sync client configured,
provider-backed writes return `503` before saving changes. A provider outage after a save leaves work for
the background reconciler. Each replica can run it, and the tenant lease coordinates who applies each job.
The periodic sweep reads back confirmed rows and deletion tombstones too, so a late Keycloak write
after lease expiry is corrected without a client retry. Renew the token to refresh membership claims.

For rollout on an existing realm, run `npm run directory:provision` first. It discovers clients using the
Junctura mapper template and aligns their tenant memberships to full group paths. Pass `--clients` for
enrolled clients with custom mapper layouts. Configure a replacement sync secret before enabling the
client. Inventory enrolled clients, renew their tokens and check that each carries its exact
`/{tenant}` root. Then deploy Core with migrations 036–038. Operators can seed verified one-to-one
bindings after migration 036 for the migration 038 backfill, or create them afterward and let the
insert trigger map the login's existing consents. Renew each user's token after assigning `subject_id`
to use its verified `subjectId`. Account holders cannot edit this managed attribute.

`GET /v1/identity` exposes verified `units` and group paths of the form `/unit/group`. A bound
`subjectId` is optional. The existing consent and history routes retain compatibility by looking up the
authenticated login in its tenant and issuer. A consent request with a mismatched `subjectId` claim
returns `403 verified_subject_required`. The planned flag and feedback routes require a verified binding.
Consent grants require a UUID `Idempotency-Key`. The first committed result replays for 24 hours.

Capability callers can name a login with `dataSubject`, or set `dataSubjectKind: "canonical"` to name
an operator-bound subject ID. Unmapped consents stay in the login namespace pending operator
reconciliation. The access log uses the binding for canonical events and the login for login events.
Operators review ambiguous historical entries against the original execution and consent before assigning
an identifier kind. Binding keys are immutable in normal operation.
Application audit accepts a delegated-user token for the enrolled client when the operator has bound
that login subject to the app and verified its subject ID. For resource-consent reads, Core derives
the reader and acting application from the exchanged token and records both in the audit chain.

### Files, search and privacy

- Upload to `/v2/objects` with `multipart/form-data` to attach an owned `recordRef` and `tags`.
  Keep the file and metadata the same when retrying with the original key.
  Octet-stream uploads remain available. Files pass malware scanning before publication. Use
  `GET /v2/objects` with `recordRef[collection]` and `recordRef[id]`, a `tag`, or both to
  list authorized file metadata. Only current published object bytes count toward the app quota.
- `GET /v1/search?q=…&limit=…&cursor=…` searches declared fields and clean text files, subject to live read permissions.
  Meilisearch holds one index per generation and only ranks candidates; the API returns references checked against
  PostgreSQL at query time. Authorized administrators and viewers see record data with sensitive fields omitted.
  A `cursor` is a signed page key bound to the query, the caller and the caller's current read scope and index
  generation, and it fails closed with `400 invalid_cursor` when reused by anyone else or after a rebuild.
- `GET /v1/me/data-access` merges capability calls and application events that were declared visible
  to the caller's bound subject at append time, newest first with a stable `accessId` tie-break and a
  cursor bound to the caller. Restricted actions and unresolved outcomes stay invisible. The page is
  re-checked against the live bindings on every request.
- `POST /v1/me/emergency-accesses/{id}/feedback` records the data subject's feedback on their own
  break-glass access. `POST /v1/me/data-access/{id}/flag` flags a visible access event using its
  `accessId`; retrying with the same reason replays the original report and a changed reason answers
  `409 resource_conflict`. Both store a separate report keyed by the access event, never overwrite the
  audit chain or the management review, and answer `404` for entries outside the caller's own visible
  history.

### Live events

`GET /v1/events` streams new group tasks, record status changes and consent revocations as
Server-Sent Events. Use the bearer header with an empty query string. A change to a record's
top-level `status` publishes a reference, including creation with that field. Task notifications
come from active Flowable tasks on confirmed executions.
The background scan publishes `workflow.task.due_soon` and `workflow.task.overdue`
with `taskId`, `executionId` and `dueAt` for eligible task groups. The default lead time
is 3600 seconds, configurable via `WORKFLOW_REMINDER_LEAD_SECONDS`. Each active task
can produce one reminder per milestone and deadline revision. A scan that first observes a
task after its deadline publishes only the overdue event. Delivery checks current task activity,
group membership and the current deadline revision. Core rechecks the bearer and resource authority
before each delivery. The feed has no event IDs or replay. Refresh source lists after reconnecting.
Core sends comment heartbeats and closes streams on credential expiry, backpressure or a journal gap.

### Message queues

Queues store background jobs in the existing PostgreSQL Data service. Leasing uses row locks with
`SKIP LOCKED` so Core replicas can dispatch work concurrently. Delivery is at least once. Make job
handlers safe to run again after a lease expires or a worker stops before acknowledgement.

Queue names are unique per tenant and match `^[a-z][a-z0-9-]{0,62}$`. The backend that first configures
a name owns the queue. Only that owner can replace its policy. The owner can also send, consume and
manage dead letters. All callers use enrolled, active service accounts with `core-reader`. `POST`
and `PUT` additionally require `core-writer`.

The owner configures `producerAppIds` and `consumerAppIds` independently. A queue can also allow
consumers of selected capabilities through `producerCapabilityVersionIds` and
`consumerCapabilityVersionIds`. Each entry names a capability version UUID owned by the queue
owner. The caller needs a currently valid `invoke` grant on that exact version under the existing
trust policy. Configuring a queue replaces its policy. Omitted lists default to empty and each list
accepts up to 100 UUIDs. Revocation, grant expiry and policy changes apply to subsequent operations,
including ack and nack. Unauthorized operations on a queue return `403 queue_forbidden`.

| Method and route | Body or query | Result |
| --- | --- | --- |
| `PUT /v1/queues/{queue}` | Policy lists and `maxAttempts` (1–10, default 5) | `200` with `queueId`, `name`, `ownerAppId` and `maxAttempts` |
| `POST /v1/queues/{queue}/messages` | `Idempotency-Key` UUID header and `{"payload":{"task":"refresh-index"},"delaySeconds":5}` | `201` with `messageId` |
| `POST /v1/queues/{queue}/lease` | `{"visibilityTimeoutSeconds":30}` or `{}` | `200` with `{ "message": null }` or a message with `messageId`, `payload`, `attempt`, `leaseToken` and `leaseExpiresAt` |
| `POST /v1/queues/{queue}/messages/{messageId}/ack` | `{"leaseToken":"<uuid>"}` | `204` and removal of the payload |
| `POST /v1/queues/{queue}/messages/{messageId}/nack` | `{"leaseToken":"<uuid>"}` | `204` and a scheduled retry or immediate dead-letter transition |
| `GET /v1/queues/{queue}/dead-letters` | Optional `limit` (1–50, default 20) and `cursor` from `nextCursor` | `200` with `{ items, nextCursor }`, ordered by message UUID. Each item includes `messageId`, `payload`, `attempt`, `deadLetteredAt` and `reason` (`nack` or `lease_expired`). |
| `POST /v1/queues/{queue}/dead-letters/{messageId}/replay` | `{}` | `204` and immediate availability under the same message ID, with attempts reset and the current attempt limit. `404 dead_letter_not_found` if the job is no longer in dead letters. |

The payload may be any JSON value up to 64 KiB in compact UTF-8 JSON. The send request envelope
has a 65 KiB limit. The optional `delaySeconds` is 0–86,400 and defaults to zero. The idempotency key
is scoped to the producer app and queue. The same key, payload and delay return the original ID even
after ack. Changing the payload or delay returns `409 idempotency_key_reused`. Acknowledged
messages retain their idempotency receipts.

Visibility timeouts are 1–3,600 seconds and default to 30. Lease tokens are unique to each delivery
and tied to the consumer app. Stale or expired tokens return `409 queue_lease_lost`. A lease increments
the attempt before delivery. Nack schedules a retry after `2^(attempt - 1)` seconds. An expired lease
can be taken immediately. On the final attempt, nack or expiry makes the job a dead letter. A lease
on the final attempt remains valid until its deadline. Jobs keep the attempt limit set at send or replay.

Core records operations and queue authorization denials in the audit chain with actions under
`audit.queue_*`. This includes empty polls and dead-letter reads. Queue operation events contain
actor and resource metadata, with no payload, lease token or idempotency key. A final lease records
its attempt at issuance and its deadline determines when a dead letter becomes visible.

### Application audit log

Register the app-wide `auditActions` catalog with the collection schema operation. Supplying the
catalog replaces its entries. Each declaration sets sensitivity and whether the subject may see an
event. The stored event retains these values even if the catalog later changes. Restricted entries
are outside the subject view.

- `POST /v1/audit-events` requires an enrolled active app, the writer role and a UUID
  `Idempotency-Key`. An undeclared action returns `422 unknown_action`. Use an opaque resource
  reference, a coded purpose and at most 2 KiB of compact scalar metadata. Core stamps the actor,
  app, unit and time. An identical retry within 24 hours returns the same committed receipt.
  Each app may append up to 120 new entries per minute.
- An app credential takes its unit from the operator's `app_private.audit_app_units` binding when
  present. A delegated user token must identify the enrolled client, an operator-bound subject ID
  and a login listed in `app_private.audit_app_delegates`. A delegated actor with exactly one
  verified unit uses that unit. Events without a resolved unit carry `null`.
- `GET /v1/audit-events?app=self` shows the active app's events. Regulators see app entries for
  assigned units. Their restricted view withholds actor, subject, resource, purpose and metadata,
  and the subject filter searches standard entries only. Management with `audit.read` sees
  platform events and the structural projection of app events in its own tenant after matching the
  verified issuer and client. `unit` limits that view to application metadata for the specified unit.
  Regulators can filter only their assigned units. The `actor` filter matches the login or service identity
  that performed an operation. It matches platform events for management, standard application events for
  regulators and the caller's own events for `app=self`. `subjectId` continues to filter the data subject.
  Use `from` and `to` for inclusive timestamps. List also accepts the legacy `since` and `until` names.
  Keep the filters and caller scope across pages.
- `GET /v1/audit-events:export` streams an authorized snapshot as NDJSON with the same audit filters. The first line gives the
  tenant head even for an empty result; an empty chain reports sequence 0 with the zero hash of 64
  zeros, which the chain verifier accepts as the genesis predecessor. Each event line gives its
  sequence and digest. Scoped views can have sequence gaps. A tenant can have two active exports,
  each with up to 10,000 events. An export beyond that limit answers `400 audit_export_too_large`
  instead of a rate limit; narrow the time range and retry. The privileged verify endpoint checks the
  full tenant chain, including both historical platform hashes and application events.

### Error responses

Planned Core errors put the code in `error` and correlate requests with `requestId` and
`X-Request-Id`. Gateway responses can be HTML. Schema violations add an `issues` array with JSON
Pointer paths into the request and, for NDJSON, one-based line numbers.

| Code | HTTP | When it occurs | What the client should do |
| --- | --- | --- | --- |
| `invalid_request`, `invalid_query`, `invalid_schema` | 400 | An envelope, parameter or schema declaration is invalid, or a required idempotency key is missing or malformed | Correct the request and resubmit. |
| `invalid_cursor` | 400 | A cursor is malformed or belongs to different filters or scope | Restart from the first page with the intended filters. |
| `audit_export_too_large` | 400 | The authorized export matches more than 10,000 audit events | Narrow the time range or split the export. |
| `forbidden`, `verified_subject_required` | 403 | The caller lacks the required authority or subject claim | Use an authorized identity or obtain a token with the required verified claim. |
| `task_group_required` | 403 | The caller belongs to no candidate group for the task's unit | Refresh the inbox and route the task to an eligible group member. |
| `unique_key_conflict`, `resource_conflict` | 409 | A key, record ID or directory resource conflicts with existing state | Inspect the existing resource and reconcile the change before retrying. |
| `limit_exceeded` | 409 | An atomic increment would exceed its inclusive bounds | Use the returned `field` to identify the quantity and reconcile the requested change. |
| `task_conflict` | 409 | The workflow transition is unavailable, for example while completion is pending | Refresh the execution and its history before acting. |
| `task_claimed` | 409 | Another caller holds the task | Display `claimedBy` and `claimedUntil`, then refresh the inbox after release or expiry. |
| `task_already_completed` | 409 | A new attempt targeted a finished task | Refresh the inbox or execution history. |
| `precondition_failed` | 412 | The record ETag has changed | Fetch the latest record and reconcile edits before resending with its ETag. |
| `body_too_large` | 413 | A body, record, file, variables object or audit metadata exceeds its byte limit | Reduce the payload or split an import or batch as appropriate. |
| `schema_violation` | 422 | Record data violates its registered schema | Correct the fields identified in `issues`, then resubmit the write. |
| `unknown_action` | 422 | The audit action is absent from the app's catalog | Use a declared action or register it before submitting the event. |
| `malware_detected` | 422 | The file failed scanning | Select a clean file. |
| `idempotency_key_reused` | 422 | An unexpired key is bound to a different logical request | Retry the original request with the same key or use a fresh key for a new operation. |
| `locked` | 423 | Another caller holds a live record lock | Display `lockedBy` and `lockedUntil`. Refresh the record after release or expiry before retrying the edit. |
| `precondition_required` | 428 | A replacement or deletion lacks `If-Match` or a required batch `ifMatch` | Fetch the record's ETag and include it in the write. |
| `rate_limited` | 429 | The gateway or app has reached a temporary request-rate limit | Respect `Retry-After` when present and back off. |
| `quota_exceeded` | 429 | The collection record or app file quota would be exceeded | Use the returned `quota` details to free space or request a higher quota. |

## Limitations

This is a local single-node stack, without production TLS/deployment or replicated storage configuration.
Generic storage has no domain schema; v1 legacy and v2 private resources remain separate.
Contracts and positive operation coverage do not prove exhaustive faults, external exactly-once effects or full provider conformance.
