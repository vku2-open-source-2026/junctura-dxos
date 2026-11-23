<!--
SPDX-FileCopyrightText: 2026 Junctura Contributors
SPDX-License-Identifier: Apache-2.0
-->
# Contributor guide

Use this guide for Core, Console and SDK changes; see [Getting started](GETTING_STARTED.md) for installation/integration.

## Rules

1. **Scope:** Keep Layer 1 headless and reusable: Identity/SSO, API Gateway, structured data, objects and workflow. The competition also requires a Layer 2 GUI application. Official [OLP requirements](OLP_REQUIREMENTS.md) take precedence over internal conventions; never invent requirements.
2. **Licensing:** Keep the approved license, SPDX headers and upstream notices; record dependencies. Resolve uncertain rights before integration. See [Licensing and third-party policy](#licensing-and-third-party-policy).
3. **Architecture:** Keep business logic in applications using public contracts. New services, frameworks and breaking APIs need justification and approval; follow [Architecture](ARCHITECTURE.md).
4. **Security:** Never commit credentials or private data. Validate input, authorize server-side and isolate tenants; never bypass controls for a demo.
5. **Hygiene:** Read existing code and reuse patterns. Avoid unrelated refactors, duplicate utilities, speculative features, generated clutter and unused dependencies. Keep agent prompts/instructions local.
6. **Quality:** Update relevant tests and documentation; run available checks. Claim a successful test, build, audit or deployment only when verified.
7. **Operations:** Obtain explicit approval before force-pushing, rewriting history, deleting data, destructive migrations or production deployment.
8. **Handoff:** Report changed files, checks run and omitted, risks, dependencies, license impact and decisions requiring approval.

## Workflow for a change

**Before editing:** Read this guide, relevant docs and existing code. Define the smallest
change, affected APIs/schemas, risks and tests. Confirm dependencies/licenses before installation.

**While editing:** Separate Core from applications. Validate input, use safe SQL, authorize
server-side and constrain uploads/timeouts. Make retries with side effects idempotent;
fail closed on uncertain permissions. Keep secrets, caches, dumps and scratch/binary clutter
out of Git. Update contracts/tests; never disable validation, tests or scanning to obtain a pass.

**Completion report:** List files/reasons, exact test/build/lint commands and results,
omitted checks, dependencies/license impact, risks, approvals and migration/rollback steps.

## Runtime shape and backend module map

Core is one Node.js process with explicit imports/routes/contracts and bootstrap wiring.
Nginx is the API ingress; the optional Console has its own Nginx proxy. Keycloak,
PostgreSQL/PostgREST, SeaweedFS, Flowable, ClamAV and OpenBao remain private.

| Module | Responsibility / boundary |
| --- | --- |
| `src/server.mjs` | Configuration, process startup and shutdown. |
| `src/bootstrap/config.mjs`, `src/bootstrap/container.mjs` | Validate environment; construct adapters and optional workers with one close hook. |
| `src/bootstrap/readiness.mjs` | Dependency checks for `GET /ready`. |
| `src/api.mjs` | Public route dispatch, request IDs and error mapping. |
| `src/platform/health/health.mjs` | HTTP server, `GET/HEAD /health` and fallback errors. |
| `src/platform/auth/auth.mjs` | Bearer introspection, tenant and role checks. |
| `src/platform/http/http.mjs` | Body/JSON helpers, `HttpError`, writer and UUID checks. |
| `src/platform/security/internal-token.mjs` | Short-lived internal assertions for adapters. |
| `src/modules/applications/applications.mjs` | Application registration/approval models and private commands. |
| `src/modules/audit/audit.mjs` | Audit queries, chain verification and subject-access history. |
| `src/modules/capability/registry/capabilities.mjs`, `src/modules/capability/registry/manifest.mjs`, `src/modules/capability/registry/payload.mjs` | Registry/publication commands, manifest validation, canonical digests and payload validation. |
| `src/modules/capability/compatibility/compatibility.mjs` | Offline schema compatibility proof and strict JSON parsing. |
| `src/modules/capability/trust/trust.mjs` | Exact direct grants, lifecycle commands and trust graph. |
| `src/modules/capability/execution/execution.mjs` | SQL reservations, in-memory authentication leases and tickets. |
| `src/modules/capability/execution/provider-network.mjs` | Approved-origin TLS transport, DNS pinning and dispatch guard. |
| `src/modules/capability/execution/runtime.mjs` | Opt-in guarded invocation and Flowable worker correlation. |
| `src/modules/capability/composition/plan.mjs`, `src/modules/capability/composition/bpmn.mjs` | Linear plan validation and deterministic bounded BPMN. |
| `src/modules/capability/composition/registry.mjs` | Composition lifecycle and publication authority. |
| `src/modules/capability/composition/execution.mjs`, `src/modules/capability/composition/runtime.mjs` | Private SQL steps, leases and opt-in ordered dispatch/observation. |
| `src/modules/consent/consent.mjs` | Subject consents and emergency-access reviews. |
| `src/modules/data/data.mjs` | Structured records through `/v1/data/*` and `/v2/data/*`. |
| `src/modules/directory/directory.mjs` | Tenant principals and organization tree plus operator-managed directory desired state. |
| `src/modules/metrics/metrics.mjs` | Per-process request counters and bounded recent traffic. |
| `src/modules/objects/objects.mjs`, `src/modules/objects/malware-scan.mjs` | Object routes, storage adapter and fail-closed ClamAV scanning. |
| `src/modules/resources/resources.mjs` | Verified application context, resource authority and read shares. |
| `src/modules/secrets/secrets.mjs` | OpenBao-backed application-secret metadata; no plaintext GET. |
| `src/modules/storage/storage.mjs`, `src/modules/storage/files.mjs` | Read-only storage summaries, file metadata and collection structure. |
| `src/modules/storage/filer.mjs`, `src/modules/storage/rpc.mjs`, `src/modules/storage/file-names.mjs` | Private storage queries, authorized RPC transport and safe file labels. |
| `src/modules/workflow/workflow.mjs`, `src/modules/workflow/client.mjs` | Tenant workflow routes, idempotency ledger and private Flowable client. |
| `src/modules/workflow/definition-policy.mjs`, `src/modules/workflow/summary.mjs` | Definition safety policy and summaries from deployed workflow metadata. |

Resolve tenant/application authority server-side; never trust ownership/role headers.
Reuse transport helpers and `HttpError`; separate coordination from provider calls.
Keep provider credentials out of browsers and tokens/secrets/bodies out of logs. Authority uses
restricted RPCs. Boundary checks enforce public entrypoints, downward dependencies and no cycles.
Bootstrap wires workers; Flowable owns durable jobs/timers. There is no dynamic plugin loader.

## Add a public API route

The Gateway is authoritative; a route changes the security surface.

1. Read the requirement, architecture decision and existing contract. Resolve authorization semantics before implementation.
2. Choose the module and versioned path. Legacy `/v1/data` and `/v1/objects` are deprecated and allowlisted; add no new behavior there.
3. Add explicit method/path dispatch in `src/api.mjs`; unknown routes must remain `404`.
4. Use the existing authorizer and `resourceIdentity` for application-owned v2 resources; never derive ownership from headers.
5. Use `requireWriter` for mutations where required, plus the operation's authority checks.
6. Update operations and schemas in `docs/contracts/foundation-api.openapi.json`; represent every implemented public operation.
7. If the Console calls it, add an explicit method/path allowlist entry in `console/nginx/default.conf`; there is no generic `/api/` passthrough.
8. Run `npm --prefix console run generate:endpoints` and `npm --prefix console run generate:api-reference`. Include updated `console/src/constants/foundationEndpoints.json` and `console/src/constants/apiReference.json`.
9. Cover success and denial: unauthenticated, wrong tenant/application, read-only caller, malformed/oversized input and unknown route.
10. Run relevant checks, including `npm run console:check:endpoints` and `npm --prefix console run check:api-reference`; update authoritative docs.
11. Submit Gateway security behavior changes for explicit approval as a separate change.

The Gateway's `/v[12]/` match forwards to Core authorization; never widen it to provider paths
or generic plugin execution. See [Core API](CORE_API.md) for workflow definitions.

## Add or change a module

- Give it one responsibility and an owning file under `src/`.
- Document its public surface, or explicitly keep it internal.
- State authorization requirements and data ownership.
- Define readiness behavior for any new dependency.
- Keep provider ports and credentials private.
- Identify its API contract when it exposes routes.
- Add positive, failure and denial tests.
- Document current behavior and limitations without overstating support.

New modules need an approved change and tests; avoid empty folders, placeholders and unused tables.

## Console rules

Follow [Console](CONSOLE.md): show missing/rejected credentials explicitly; label synthetic previews.
Keep bearer tokens in memory, never `localStorage`, and client secrets out of browsers.
Preserve the Nginx allowlist, design system, languages/themes; label unimplemented controls.
`core-reader`/`core-writer` imply no administrator authority. Business decisions belong to applications.

## Domain-neutral check

`npm run check:neutral` (also in `npm run check`) scans tracked text in `src/`, `infra/`,
`scripts/`, `sdk/`, `console/src/`, `examples/`, `docs/contracts/`, `compose.yaml`,
`compose.providers.yaml`, both Dockerfiles and `.env.example` for sector vocabulary.
Vocabulary exclusions: `tests/`, `console/src/tests/`, temporary `examples/workflows/`,
the checker and allowlist. The separate BPMN rule allows only the two technical definitions
in `infra/flowable/`, plus any `*.bpmn20.xml` under `tests/fixtures/` or `examples/workflows/`. Exceptions in
`scripts/domain-neutral-allowlist.json` need an exact path, term and nonempty reason;
unused entries fail. See [the checker](../scripts/check-domain-neutral.mjs).

## Local verification

Use Node 24. Fast checks need no Docker. First run `npm ci --prefix console` and install
Python dependencies from `requirements-contracts.txt` and `requirements-reuse.txt`:

```sh
npm run check
npm run check:docs
npm run check:reuse
npm test
npm run check:contracts
npm run test:contract-validator
npm run console:check:endpoints
npm --prefix console run check:api-reference
npm run console:test
npm run console:build
```

`npm run check:contracts` and `npm run test:contract-validator` call `python`. With only `python3`,
use `python3 -B scripts/check-contracts.py` and `python3 -B scripts/check-contracts.py --self-test`.
`check:reuse` also calls `python`; use `python3 -B -m reuse lint` instead (`reuse lint` is read-only).
`integration/contract.mjs` honours `PYTHON`; set `PYTHON=python3` on such hosts.

Real-service checks require Docker Engine with Linux containers; provider-network
checks also require host OpenSSL. Run sequentially on a disposable test stack:

```sh
npm run setup
docker compose config --quiet
npm run local:demo
npm run healthcheck
npm run test:console-container
npm run test:integration
npm run test:applications
npm run test:capabilities
npm run test:compositions
npm run test:flowable-worker
npm run test:recovery
npm run test:audit
npm run test:malware-scan
npm run test:secrets
npm run test:migrations
npm run test:execution-ledger
npm run test:provider-network
npm run check:schema-drift
```

Integration suites restart services and change test state. Retain persistent volumes.
CI runs syntax/boundary/neutral/docs/REUSE checks, Console audit/inventories/tests/build/container
checks, OpenAPI validation, host/container unit tests, deterministic packaging, provider/ledger/
migration checks and real Compose integration, authority, worker, recovery and audit suites.
See [CI](../.github/workflows/ci.yml).

## Database migrations

Run [infra/postgres/migrate.sh](../infra/postgres/migrate.sh) with `docker compose run --rm data-migrate`;
Compose gates `data` and then Core on success. Number after the highest `infra/postgres/NNN-*.sql`:
currently `038`. Mount new files in `compose.yaml`'s `data-migrate` service.
**All applied files are immutable**: preserve their exact bytes and add forward migrations.

SHA-256 enters `core.schema_migration_checksums` in the applying transaction
(`psql --single-transaction`, stripping file delimiters); failure leaves neither changes nor checksum.
The runner refuses checksum/ledger inconsistencies, missing/duplicate versions and newer databases.
`core.schema_migration_state` fingerprints definitions, owners, ACLs, RLS flags, column grants
and policies before new SQL. `flock` and PostgreSQL advisory locking serialize runners.
Repeats print `Migration N verified` and `Migrations current at version N`.

| Message (verbatim excerpt) | Meaning / action |
| --- | --- |
| `applied-version integrity` / `duplicate local migration version` | Missing historical files or duplicate numbers: restore the exact set; never remove ledger rows. |
| `content differs from its recorded checksum` | Applied bytes changed: restore originals and add a forward migration. |
| `recorded as applied without a checksum` | Version-only history: review before explicit adoption. |
| `installed schema drift detected` | Installed authority differs: inspect and restore, or adopt only after review. |
| `database schema is newer than this migration set` | Use the matching checkout; never replay older authority SQL. |
| `could not acquire the database migration lock within 120 seconds` | Check the other runner and investigate a stuck session. |
| `exists but the version is not applied; refusing to guess which side is authoritative` | A checksum lacks its version row: stop and restore from backup. |

Before adoption, take a verified `pg_dump` backup and preserve the volume. Run without flags;
compare installed definitions, owners, ACLs and RLS with expected migrations. For version-only
history, use `docker compose run --rm -e MIGRATION_ADOPT_EXISTING=1 data-migrate` after review;
this records current checksums without proving originally applied bytes. For intentional drift,
capture `pg_dump --schema-only`, record the reviewed change, add a forward migration if it must
persist, then run once with
`docker compose run --rm -e MIGRATION_ADOPT_SCHEMA_DRIFT=1 data-migrate`.
Re-run without flags and verify no SQL replay. Adoption is an operator decision, never a demo shortcut.

`npm run test:migrations` uses disposable, network-isolated PostgreSQL to test fresh/repeat runs,
tampered/missing/duplicate files, rollback, concurrency, adoption, drift and newer-database refusal.
`npm run check:schema-drift` runs [scripts/check-schema-drift.mjs](../scripts/check-schema-drift.mjs)
read-only; `DATABASE_SERVICE` selects the Compose service (default `database`). It prints a match
or recorded/installed fingerprints; inspect definitions separately to investigate differences.
Migration 016 expands fingerprinting to `composition_private` after checking the old scope.
The runner strips CRLF delimiters for execution but hashes original bytes;
`.gitattributes` preserves 013's applied CRLF bytes. Never normalize applied migrations.

| Migration | Adds |
| --- | --- |
| 001 | Tenant-isolated structured records and data API role. |
| 002 | Workflow request/idempotency ledger. |
| 003 | Application registration, principals, approvals and private authority. |
| 004 | Application-owned resources and exact read shares. |
| 005 | Protected audit role, transactional append and tenant queries. |
| 006 | Capability manifests, versions and registry/publication authority. |
| 007 | Private direct-trust persistence. |
| 008 | Trust grant lifecycle and approval commands. |
| 009 | Discovery filtered by current exact grants. |
| 010 | Capability execution ledger, reservations and ticket authority. |
| 011 | Finalization correction preserving absent ticket expiry. |
| 012 | Bounded composition registry and execution authority. |
| 013 | Composition authority corrections and step digests/dispatch evidence. |
| 014 | Composition registry digest/lifecycle guards. |
| 015 | Reservation timestamp and live publication/owner checks. |
| 016 | Exact result version, lifecycle guards and expanded fingerprint scope. |
| 017 | Execution checks bound to the originally reserved exact grants. |
| 018 | Audit chain columns, tenant heads and `core.audit_verify`; existing events seal on verification. |
| 019 | Read-only `core.trust_graph`. |
| 020 | Purpose/subject execution context and `core.subject_access`. |
| 021 | Subject consent, emergency justification and review authority. |
| 022 | Read-only principal/organization directory and private directory role. |
| 023 | Nullable principal display/profile fields and directory output. |
| 024 | Directory relations limited to active, unexpired grants. |
| 025 | Read-only storage aggregates and workflow audit-access gate. |
| 026 | Read-only collection field/type inference from at most the 200 newest records, without values. |
| 027 | Read-only application statistics through a `SECURITY DEFINER` function and private role. |
| 028 | Trust graph also readable by `audit.read` (tenant scope); `readOnly` reports no mutating trust permission. |
| 029 | `audit.read` reads every capability, any application and the emergency review queue of its tenant, read-only. |
| 030 | Record versions, collection schemas, index projections, management read grants and the record RPC. |
| 031 | Indexed record queries, aggregates and resumable cursors. |
| 032 | Exclusive record locks and atomic numeric increments. |
| 033 | Unique-key upserts and atomic record batches. |
| 034 | Record export snapshots and transactional NDJSON imports. |
| 035 | Operator-managed app groups and read shares for group members. |
| 036 | Operator-bound verified subject identifiers per tenant and issuer. |
| 037 | Directory desired state (unit types, flat units, groups, members) with generations and the `directory.write` permission. |
| 038 | Consent under the verified subject identity with legacy mapping through subject bindings. |

Set `STRICT_RECORD_WRITES=true` on every Core replica after updating callers to
send idempotency keys and record preconditions. The default is `false`.

## Demo data and developer journey

Layer 1 ships no domain scenario. Authorized setup tooling registers applications, publishes
capability versions and configures grants through the operator approval flow. Enrolled application
backends then load demo records through the resource APIs. See [TIER_MODEL.md](TIER_MODEL.md).

`npm run local:demo` runs `setup` when `.env` is missing, then `local:up`, `env:provision`,
`demo:seed` and `demo:console`. `npm run env:provision` provisions tenant `demo` (read-only
account `demo`, the only public login hint) and tenant `production` (`admin1`–`admin3` plus
the read-only judge `giamkhao`); passwords are generated at run time and stored in
`.junctura/demo-accounts.json` (mode 0600). Only the `demo` account is also written to the
public login hints. See [Operations](OPERATIONS.md).

`npm run demo:seed` writes simulated applications, capabilities, grants, records, notes and
files through the real API. It defaults to `--tenant demo`, is idempotent, and refuses
`production`, `tenant-a` and `tenant-b`; use it only for demo-style tenants.
`tests/demo-seed.test.mjs` covers reserved tenants, idempotent writes, pagination, object
scan failures and local-demo step planning; run `node --test tests/demo-seed.test.mjs`
or `npm test`.

For operator enrollment/`resource_subject` binding see [Capabilities](CAPABILITIES.md); for resource authorization see [Security](SECURITY.md).

Run [examples/foundation-http.mjs](../examples/foundation-http.mjs) with an active enrolled backend and
grantee on a running stack. Keep credentials server-side; `PUBLIC_URL` defaults to `http://127.0.0.1:8080`.

```sh
JUNCTURA_APP_CLIENT_ID='<enrolled-backend-client>' \
JUNCTURA_APP_CLIENT_SECRET='<backend-secret>' \
JUNCTURA_GRANTEE_APP_ID='<second-enrolled-app-uuid>' \
JUNCTURA_GRANTEE_CLIENT_ID='<grantee-client>' \
JUNCTURA_GRANTEE_CLIENT_SECRET='<grantee-secret>' \
node --env-file=.env examples/foundation-http.mjs
```

1. Authenticate with OIDC client credentials; `/v1/identity` returns verified subject, tenant and roles.
2. Create/read a `/v2` record; with grantee credentials, confirm the grantee receives `404` before sharing.
3. Upload/download a `/v2` object with identical bytes.
4. Start, inspect and complete the operator-installed `junctura_checkpoint` workflow.
5. Create a ten-minute record read share; with grantee credentials, confirm access succeeds afterward.

Grantee credentials are optional but must be paired; omitting them skips before/after checks.
Workflow variables are tenant-visible: exclude private record/object content. The CLI prints IDs
and keeps resources; failed POST outcomes may be ambiguous, so never blindly rerun.
For cleanup, use an owner backend token in `$TOKEN`, set `$PUBLIC_URL` and substitute printed IDs:

```sh
curl -X DELETE -H "Authorization: Bearer $TOKEN" "$PUBLIC_URL/v2/resource-shares/$SHARE_ID"
curl -X DELETE -H "Authorization: Bearer $TOKEN" "$PUBLIC_URL/v2/data/http_example/$RECORD_ID"
curl -X DELETE -H "Authorization: Bearer $TOKEN" "$PUBLIC_URL/v2/objects/$OBJECT_ID"
```

Never use `docker compose down -v` or volume deletion for cleanup.

## Tests

- Unit tests: `tests/*.test.mjs`, using `node:test` (including SDK tests).
- Real-provider integration and fault tests: `integration/`; `integration/contract.mjs` validates observed HTTP traffic against the OpenAPI contract.
- Console tests: `console/src/tests/`, using Vitest.
- Contract validation/regressions: `scripts/check-contracts.py`, using `docs/contracts/` schemas and examples.

Prefer deterministic focused tests; cover denial for each new authorization decision.

## Licensing and third-party policy

Apache-2.0 is approved by the maintainer for original source; keep it unless explicitly approved otherwise.
[LICENSE](../LICENSE) holds terms; `NOTICE` holds attribution. Preserve upstream notices.
For original source/configuration, Markdown, HTML and SVG, use the language's comment syntax:

```text
SPDX-FileCopyrightText: 2026 Junctura Contributors
SPDX-License-Identifier: Apache-2.0
```

Cover JSON and other comment-hostile files with `REUSE.toml` annotations and/or `.license`
sidecars; never add JSON comments. Keep `Apache-2.0` metadata in root, Console and SDK manifests.
REUSE text is `LICENSES/Apache-2.0.txt`. CI runs read-only `reuse lint` via `npm run check:reuse`
alongside source checks; missing/invalid metadata must fail without rewriting files.

For dependencies, images/base OS packages and assets, record name, exact version/commit/digest,
upstream URL, SPDX license, role, distribution/hosting model and notice obligations in
[THIRD-PARTY.md](../THIRD-PARTY.md). Verify the OSS edition provides the feature; free access
does not prove licensing, nor do separate containers remove obligations. Review GPL/AGPL/MPL
and mixed licenses for actual use/distribution. Reject unresolved rights; never relabel upstream source.

Before publication, reconcile LICENSE/NOTICE/headers/inventory, pin components and preserve bundled
notices. Verify the GitHub account/repository and exclude secrets/private data. Binary/package/container
publication needs its own inventory, notice review and approval; source approval does not authorize
production deployment. Only report license/vulnerability checks actually run.

## Release

Follow [Release](RELEASE.md) for checks, source packaging, organizer-format verification, installation,
upgrade/rollback and approved publication. Verify the Core-to-application flow; test reproducibility claims.

## Documentation rules

Keep one authoritative document per subject; link rather than duplicate it.
`docs/contracts/foundation-api.openapi.json` owns the machine API contract.
Final doc set: [README](../README.md), [GETTING_STARTED](GETTING_STARTED.md), [ARCHITECTURE](ARCHITECTURE.md),
[CORE_API](CORE_API.md), [CAPABILITIES](CAPABILITIES.md), [SECURITY](SECURITY.md), [OPERATIONS](OPERATIONS.md),
[CONSOLE](CONSOLE.md), [DEVELOPING](DEVELOPING.md), [OLP_REQUIREMENTS](OLP_REQUIREMENTS.md),
[RELEASE](RELEASE.md), [README_EN](README_EN.md). Old documents live in `docs/archive/`.
Update the README opening for product-model changes; preserve licensing records, audit evidence and decisions.

## Limitations

Deployment is single-host Compose with loopback HTTP. Foundation workflows are tenant-scoped.
Metrics reset on restart; no downgrade migrations are supplied. See [Release](RELEASE.md) for rollback.
