<!-- SPDX-FileCopyrightText: 2026 Junctura Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Security

Layer 1 combines live OIDC introspection for every protected Core request, forced tenant
row-level security (RLS), owner-controlled RPC roles, independent approval by a different enrolled
management principal (operators provision those principals as separate humans) and protected audit. The local loopback deployment is not
production-certified. See [architecture](ARCHITECTURE.md) and the [Core API](CORE_API.md).

## Trust boundaries

- Ordinary API roles cannot administer private authority or access another tenant's
  records/audit. Tenant, owner, app and role headers do not create authority.
- PostgreSQL superusers, database owners, owner functions and host operators are trusted;
  consistent rewriting of audit rows and chain heads defeats database-local verification.
- Authorization belongs at the service boundary. Browsers authenticate to a Layer-2 or Layer-3
  backend that authorizes the human and uses private service credentials for Core
  resource calls. Never put those credentials or broad writer tokens in a browser.
  Forwarded user/app headers are not delegation; UI/routing restrictions are insufficient.
- [Compose](../compose.yaml) publishes Gateway/optional Console on loopback; providers
  are private. Core runs nonroot, read-only, with dropped capabilities and no privilege
  escalation. Private providers and internal assertions depend on this network boundary.
- The isolated PostgreSQL restore test covers Core data/authority; it does not restore
  Keycloak sessions/keys, Flowable history or SeaweedFS metadata/bytes. Coordinate all
  stores, roles and credentials; see [operations](OPERATIONS.md) (`npm run backup`/`restore`).

## Identity and roles

[Core authentication](../src/platform/auth/auth.mjs) checks active status, issuer,
`junctura-core` audience, expiry, subject, tenant membership and `core-reader`, without
a positive token cache. Invalid tokens return 401, tenant/role failures 403, unavailable
identity 503. Liveness/readiness probes are public. Record/object/share mutations
additionally require `core-writer`.

Enabled `app_private.principals` entries keyed by `(tenant_id, issuer, subject,
management_client)` confer explicit [permissions](CAPABILITIES.md#permissions):

| Permission | Authority, subject to operation-specific checks |
| --- | --- |
| `applications.register` | Propose an application matching an operator enrollment. |
| `applications.approve` | Administer application lifecycle; approval also needs `trust.approve`. |
| `trust.write` | Propose direct grants for an owned provider application; also a wider trust-graph view (own providers). |
| `trust.approve` | Independent trust decisions and application approval decisions; tenant-wide trust-graph view. |
| `capabilities.write`, `capabilities.publish`, `capabilities.approve` | Authoring (creation always needs `write`), tenant registry administration incl. publication, and publication approval. |
| `compositions.write`, `compositions.publish`, `compositions.approve` | Separate composition authoring, publication and approval powers. |
| `audit.read` | Read and verify the caller tenant's audit history; also the tenant directory, traffic metrics, storage, application statistics, workflow administration views and the read-only tenant trust graph (metadata, no record values). |

Activation/reactivation consumes an unexpired approval bound to the proposal digest/revision,
from a subject other than the owner. Realm roles/membership do not imply management permissions.

Traffic metrics require a verified client and `audit.read` in the caller's tenant; observations are per-process, per-tenant, in-memory and cleared on restart.
Only requests with a verified tenant are recorded; probes and `401` responses are excluded.

For private application/resource/audit calls, Core signs verified tenant, issuer,
subject and client ID in an HS256 assertion with `junctura-data` audience and 30-second
expiry; resource assertions carry writer status. PostgREST's `junctura_data` login
assumes `NOLOGIN NOBYPASSRLS` API roles. Generic records cannot administer private authority;
never expose assertions or signing secrets to clients/logs.

## Demo and production environments

`npm run env:provision` creates separate environment tenants. `demo` has one read-only
principal `demo`, the only account written to public login hints (mode 0644); Core denies
its registrations, approvals and revocations. `production` has `admin1`–`admin3` and the
read-only judge `giamkhao`, none of which are ever published. `tenant-a`/`tenant-b` remain
test/CI fixtures. Provisioning generates passwords at run time, never prints them, and
stores all of them in `.junctura/demo-accounts.json` (mode 0600); the `demo` password is
also public by design. It disables the legacy read-only account and removes moved accounts
from the other tenant groups, including the fixtures.

`giamkhao` holds only `audit.read` and a reader role. Provisioning compares the
expiry date (default 2026-12-15, inclusive through that UTC day) with today and enables the
account only while that date is not past; Keycloak does not store the date. Expiry is applied by the script, not by a
scheduler: re-run `npm run env:provision -- --tenants production` on or after the date to
disable it. `--disable-judge` disables the Keycloak user, ends its sessions and disables
the Console principal immediately; only an explicit `--judge-expires <future-date>` re-enables it.

## Application statistics

`GET /v1/applications/stats` is read-only. Core authenticates with a short-lived internal
assertion for the `NOLOGIN` role `junctura_application_stats_api` and calls
`core.application_stats(jsonb)`. This `SECURITY DEFINER` function belongs to
`junctura_app_owner`, has EXECUTE restricted to that role, and accepts only an empty
payload. It validates the verified tenant, issuer, subject and client, then requires an
enabled principal with `audit.read` in that tenant. Forced row-level security keeps reads
tenant/issuer scoped. Responses contain counts, timestamps, application IDs, display names
and states only, never record content, collection names, object keys, file names, capability
manifests, grant proposals, subjects or audit reasons. Responses are `no-store`; malformed
aggregates or dependency failures return `503 application_stats_unavailable`.

## Resource authorization

V2 resolves the application from `(tenant, issuer, oauth_client_id)` and the exact
operator-enrolled `resource_subject`. The application must be active, enrollment enabled
and subject bound. Request headers, app IDs and owner fields cannot substitute.

Verify the confidential client, exact service-account subject, tenant/audience mappings
and disabled browser/password login through authenticated identity administration; set
`app_private.enrollments.resource_subject` through reviewed SQL, including any rebinding.

`/v2/data/{collection}[/{id}]` provides GET/POST/PATCH/DELETE with an immutable,
server-derived owner. Reads include owned/shared records; only the owner mutates them.
PATCH replaces `data`. Forced RLS enforces tenant/app access even through private
PostgREST resource-role calls; legacy/application-administration roles have no access.

`/v2/objects[/{uuid}]` provides POST/GET/PUT/DELETE with a 5 MiB upload limit. Uploads
are quarantined until a clean ClamAV result; detection/errors/timeouts fail closed.
Ownership is immutable; v2 writes fresh versions under `junctura-app/{tenant}/{owner}/{id}/{version}` and
publishes the pointer only after another live SQL authorization check.
Failed/ambiguous publication can leave unreachable bytes. Concurrent PUTs use the last
successful pointer publication; GET rechecks authority after fetching bytes. UUIDs are
tenant-scoped: another tenant's same UUID is independent. DELETE tombstones v2 metadata
and prevents UUID reuse. Bytes/old versions remain; there is no background collector.

An active owning writer creates a read share with `POST /v2/resource-shares` and exactly:

```json
{"resourceType":"record","resourceId":"LOWERCASE-UUID","granteeAppId":"LOWERCASE-UUID","action":"read","expiresAt":"UTC-ISO-TIMESTAMP"}
```

`resourceType` accepts `record` or `object`. The resource must exist and belong to the
caller; the grantee must be a different active same-tenant app with enabled resource
enrollment. Expiry must be future and at most 24 hours away. Creation returns 201 with
`shareId` and share fields. Owner approval needs no separate administrator decision.
Shares permit only individual same-tenant reads, with no transfer/resharing/delegation.
Readers need `core-reader`; object shares include future versions of the same live object.
`DELETE /v2/resource-shares/{shareId}` returns 204, including repeat revocation;
foreign/hidden shares return 404. Share changes and audit append are atomic.

Pending, suspended or revoked apps receive 403 `application_access_required` at
v2 entry. Disabling enrollment or clearing `resource_subject` also blocks entry.
Inactive owners' resources are hidden from grantees (item reads return 404). Reactivation
restores valid unexpired shares; terminal revocation retains ownership/resources without
disabling the identity client. Authority is reread per SQL operation/pointer publication,
with no positive app/share cache. In-flight authorized work may finish across a state change.

Legacy `/v1/data/{collection}[/{id}]` and `/v1/objects[/{uuid}]` are deprecated for app-private
data, tenant-scoped and separate from v2 storage. `LEGACY_RESOURCE_CLIENTS` defaults empty in Core; Compose
defaults to `tenant-a,tenant-b,reader`, excluding the browser fixture. Others receive
403 `legacy_resources_disabled`. This separate operator permission survives v2
suspension/revocation: remove its allowance or disable the identity client to block it.
Inventory legacy data/clients, assign owners out of band and enroll/activate backends.
Copy approved records/bytes through v2, update IDs, verify isolation/checksums and remove
allowances. No automatic ownership migration/deletion exists; owners authorize disposition.

## Audit

`app_private.audit` stores events under forced tenant RLS. Owner functions append inside
the authority mutation's transaction. The BEFORE INSERT guard requires verified actor
claims, rejects tenant mismatch, validates event/resource type, revision, outcome and
reason code, and derives tenant/issuer/subject/client, actor app, event ID, time and schema
version (`1`). Reasons receive best-effort bearer/JWT/secret redaction and a 512-character
limit. No arbitrary JSON/token/password fields exist.

`junctura_audit_api` has execute access to `core.audit_query` and `core.audit_verify`,
with no table privileges. Ordinary API roles/PUBLIC cannot read or append audit rows.
These SECURITY DEFINER functions belong to `junctura_app_owner`; no client append or
public PostgREST audit table route exists. Required append failure rolls back mutations,
including approval consumption/share changes. This is not universal HTTP access logging.

`GET /v1/audit-events?since=&until=&limit=&cursor=` requires an enabled management
principal with explicit `audit.read` in its tenant. Only these four parameters are
accepted, once each; tenant/actor/resource filters are rejected. `since`/`until` are
inclusive timestamps; `since > until` is invalid. Integer `limit` is 1–100, default 50.
Other values must be 1–1024 characters; `cursor` is the opaque hex `nextCursor`.
Responses contain `items` newest first by time/event ID and `nextCursor` (null at end),
with `Cache-Control: no-store`. Invalid queries return 400, missing audit permission
403, technical failures 503 `audit_unavailable`.

`POST /v1/audit-events/verify` accepts body `{}` and no query parameters, with the
same management/audit permission. Under a per-tenant advisory lock it recomputes
sealed entries in `chain_seq` order and checks `app_private.audit_chain_heads`,
detecting missing tail entries too. Only an intact chain seals pending events in
`(occurred_at, event_id)` order. Ordinary appends do not take this lock and remain
unsealed until verification. Nothing is sealed on top of a detected break.

The [hash implementation](../infra/postgres/018-audit-chain.sql) uses `n = chain_seq`:

```text
entry_hash = hex(SHA256(UTF8(jsonb_build_array(
  'junctura-audit/1', n, prev_hash, tenant_id, event_id,
  integer_microseconds_since_epoch, issuer, subject, management_client, event,
  resource_type, resource_id, revision, outcome, reason_code, reason,
  actor_app_id, schema_version)::text)))
```

Entry 1 uses 64 zeroes for `prev_hash`; canonical JSONB/integer microseconds avoid session
time zone/date-style differences. Results include `verified`, `entries`, `newlySealed`,
`headHash`, `verifiedAt` and `firstBreak` (`chainSeq`, `eventId`, `reason`). Break kinds:
`content_modified`, `chain_link_mismatch`, `missing_entry` or `head_mismatch`.

Single-capability reservations with context append `execution.subject_accessed`
(`execution.emergency_access` for emergency calls), with purpose as `reason_code`
and, for a named data subject, `data_subject_sha256:` plus its SHA-256 as `reason`.
The binding lives in owner-only, forced-RLS `execution_private.execution_contexts`.
`GET /v1/me/data-access` accepts no query, requires only an authenticated `core-reader` caller with a verified client ID (no management permission),
and returns only the caller's tenant/issuer/subject entries, newest first, up to 200 with
`truncated`. Entries describe declared reservations rather than proving completed access.

For a development stack, enroll a demo app first, e.g. `npm run app:enroll -- demo`. The
helper provisions `junctura-demo-auditor-<tenant>` with only `audit.read`:

```sh
npm run audit:demo              # default verify and seal through Gateway/Core/SQL
npm run audit:demo -- verify    # explicit verification
npm run audit:demo -- tamper    # alter sealed event #2 directly in PostgreSQL
npm run audit:demo              # reports content_modified at #2
npm run audit:demo -- restore   # undo the demo alteration
npm run audit:demo -- token     # short-lived auditor token for the Console
```

Fixture cleanup can break sealed chains; demonstrate on a separate stack. Back up audit
rows/heads with authority tables, roles and migration history. No automatic retention
purge/down migration exists. Preserve evidence/roles on rollback; disable callers if needed.

## Code and repository checks

`npm run check:boundaries` checks literal relative imports for public entrypoints,
downward dependencies, Foundation/Capability separation and cycles, including side-effect
and literal dynamic imports. Computed imports require review; this is not a sandbox.
The [migration runner](../infra/postgres/migrate.sh) serializes runners and records SHA-256
checksums transactionally, rejecting changed/missing applied files, duplicate versions,
inconsistent history and unreviewed drift. See [development guidance](DEVELOPING.md).
Fingerprints cover selected Core/private schemas, function definitions, owners, ACLs,
column grants, RLS flags and policies, not full physical-schema/extension integrity.
`npm run check:schema-drift` is read-only.

## Dependency and container scanning

Core runtime has no third-party npm dependencies. [Console dependencies](security/console-dependencies.json),
[container packages](security/container-packages.json), [findings](security/container-vulnerabilities.tsv)
and [scan summary](security/scan-summary.json) record inventories/evidence. Unlisted/new
images need fresh scans. Scanner findings and license metadata remain unresolved.
**The release security gate for production/binary redistribution is NOT cleared**.
Scan lockfiles, pinned requirements and local image digests from Compose/Dockerfiles;
use an isolated pip-audit environment. Findings do not prove exploitability or safety.

```sh
npm audit --prefix console --json
pip-audit -r requirements-contracts.txt --no-deps --disable-pip
docker scout cves --format sarif <pinned-image>
docker scout sbom --format spdx <pinned-image>
```

Never scan or upload a directory containing `.env`. CI audits the Console graph
at the high-severity threshold; that does not clear the container release gate.

## Verification

Run service suites sequentially on an isolated stack: they mutate fixtures and restart services.

```sh
npm run check
npm run check:boundaries
npm test
npm run test:integration
npm run test:audit
npm run test:recovery
npm run test:applications
npm run test:capabilities
```

## Limitations

- Production/binary redistribution remains blocked by unresolved scan findings.
- No independently controlled audit sink or external chain-head anchoring exists;
  unsealed events and consistent administrator rewrites lack that protection.
- Retention, legal hold and purge policy remain operator responsibilities.
- API DELETE is not secure physical erasure, including retained v2 object bytes.
- Revocation is not remote cancellation of already authorized work.
- Workflow execution is tenant-scoped; keep application-private data out of shared variables.
- No penetration test, load test or full coordinated disaster recovery is claimed.
