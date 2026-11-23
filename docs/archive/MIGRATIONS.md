<!-- SPDX-FileCopyrightText: 2026 Junctura Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Database migrations and schema integrity

The migration runner is `infra/postgres/migrate.sh`. Compose runs it as the
one-shot `data-migrate` service before `data` and `core` start. It is the only
supported way to apply migrations.

## Guarantees

- Every applied migration is recorded in `core.schema_migration_checksums`
  together with the SHA-256 of the exact file content.
- The checksum is inserted in the same transaction that applies the migration.
  `BEGIN;`/`COMMIT;` inside the file are stripped and the body runs under
  `psql --single-transaction`, so a failure leaves neither objects nor a
  checksum behind.
- Applied files are immutable. Editing one makes the runner refuse with
  `content differs from its recorded checksum`.
- A checksum present without the matching version row, or a version row without
  a checksum, is refused instead of guessed.
- The runner refuses a database whose `max(version)` is newer than the local
  migration set.
- `core.schema_migration_state` stores a fingerprint of installed function
  definitions, owners, ACLs, table RLS flags, column grants and policies. A
  mismatch is `installed schema drift` and stops the run before any new SQL.
- Two runners serialize through `flock` and a PostgreSQL advisory lock.

Existing migrations `001`-`012` and the tables they create are not modified by
this mechanism. The two bookkeeping tables are created by the runner itself.

## Normal operation

```sh
docker compose run --rm data-migrate
```

Expected output is `Migration N verified` for each applied version and
`Migrations current at version N`.

## Failure reference

| Message | Meaning | Action |
| --- | --- | --- |
| `applied-version integrity` / `duplicate local migration version` | A historical migration file is missing or version numbers collide. | Restore the exact matching migration set. Never remove ledger entries to make startup pass. |
| `content differs from its recorded checksum` | An applied file was edited or replaced. | Restore the original bytes. Never edit applied history; add a new migration. |
| `recorded as applied without a checksum` | Version-only history from an older runner. | Follow adoption below. |
| `installed schema drift detected` | Functions, owners, ACLs, RLS or policies differ from the recorded fingerprint. | Inspect the difference, restore the expected schema, or record a reviewed adoption. |
| `database schema is newer than this migration set` | The checkout is older than the database. | Deploy the matching runner; do not replay older authority SQL. |
| `could not acquire the database migration lock` | Another runner held the advisory lock for 120 s. | Confirm the other run finished; investigate a stuck session. |
| `checksum ... exists but the version is not applied` | Partial bookkeeping. | Stop and restore from backup; do not guess. |

## Operator adoption (version-only history)

A database created before checksum enforcement has version rows but no
checksums. Adoption records the checksum of the files that are actually
installed. It does not prove what was originally applied.

1. Take a verified backup (`pg_dump`) and keep the volume.
2. Run the runner without flags. It must stop at the first version-only entry.
3. Compare installed definitions, owners, ACLs and RLS with the expected
   migrations. `scripts/check-schema-drift.mjs` prints the fingerprint inputs
   and refuses to modify anything.
4. Only after that review, run:
   ```sh
   docker compose run --rm -e MIGRATION_ADOPT_EXISTING=1 data-migrate
   ```
5. Re-run without flags. The result must be `Migration N verified` for each
   version and no `Applying migration` line.

## Operator adoption (installed drift)

When the fingerprint differs but the schema is intentionally different (for
example a manually restored provider fix):

1. Capture the difference (`pg_dump --schema-only` or the drift report).
2. Record it in the change review and a new forward migration if it must persist.
3. If the difference is the reviewed baseline, run once with
   `MIGRATION_ADOPT_SCHEMA_DRIFT=1`; then re-run without flags.

Using either adoption flag is a production decision. It is not a way to make a
demo pass.

## Tests

`npm run test:migrations` starts a disposable, network-isolated PostgreSQL
container and proves:

- fresh install records every checksum in the applying transaction;
- repeat execution verifies without replaying;
- edited applied content fails closed;
- an interrupted migration leaves neither objects nor a checksum;
- concurrent runners converge;
- version-only history requires explicit adoption;
- installed drift is detected and only adopted after review;
- a database newer than the runner is refused.

`scripts/check-schema-drift.mjs` is the read-only diagnostic used by operators
and CI. It needs `DATABASE_SERVICE` (default `database`) and prints either
`schema matches the recorded fingerprint` or the expected/actual fingerprints.

## Audit hash chain (018)

Migration 018 adds nullable `chain_seq`, `prev_hash` and `entry_hash` columns to
`app_private.audit`, a forced-RLS `app_private.audit_chain_heads` table and
`core.audit_verify(jsonb)`. Existing events are not rewritten by the migration;
they are sealed by the first verification. See [AUDIT](AUDIT.md#tamper-evident-hash-chain).

## Trust graph (019)

Migration 019 only adds the read-only `core.trust_graph(jsonb)` function (no table or
column changes) and grants it to `junctura_trust_api`. See
[CAPABILITY_DIRECT_TRUST](CAPABILITY_DIRECT_TRUST.md#trust-graph-019).

## Purpose and subject access (020)

Migration 020 adds `execution_private.execution_contexts`, the
`junctura_subject_api` role and `core.subject_access(jsonb)`. It renames the applied
`core.execution_command` to `execution_private.execution_command_base` (body unchanged)
and installs a wrapper under the original name and grant. See
[CAPABILITY_EXECUTION](CAPABILITY_EXECUTION.md#purpose-and-data-subject).

## Consent and break-glass access (021)

Migration 021 adds `execution_private.subject_consents` and
`execution_private.emergency_reviews` (forced tenant RLS), emergency columns on
`execution_contexts`, `core.subject_consent` (subject role) and `core.emergency_review`
(trust role), and replaces the 020 execution wrapper and `core.subject_access`. The
C4A base authority stays unchanged.

## Tenant directory (022)

Migration 022 only adds two read-only functions and the `junctura_directory_api`
role: `core.directory_principals(jsonb)` lists the caller tenant's enrolled
principals, and `core.directory_organizations(jsonb)` builds the tenant/application
tree plus current trust relations. Both require `audit.read` on the verified
caller; no table or column changes are made.

## Principal profile (023)

Migration 023 adds nullable `display_name`, `organization`, `job_title` and
`kind` (`admin` or `application`) columns plus bounded, control-character-free
checks to `app_private.principals`, and replaces the read-only
`core.directory_principals(jsonb)` function so it also returns `displayName`,
`organization`, `jobTitle` and `kind`. No existing row is rewritten; absent
profiles stay `NULL`. The local demo provisioning (`npm run demo:provision`) fills the
administrator profiles directly with `docker compose exec ... psql`; it is not part of the
migration history and never stores credentials.

## Active directory relations (024)

Migration 024 replaces only `core.directory_organizations(jsonb)`, leaving the
022/023 history untouched. The organization tree now lists a trust relation only
when the grant is `active` and not expired, so proposals still awaiting approval
no longer appear as granted access. Roles, function ownership, ACLs, row limits
and the `NOTIFY pgrst` reload are preserved from 022.

## Storage and workflow audit summary (025)

Migration 025 adds two read-only aggregate functions and the private
`junctura_storage_api` / `junctura_workflow_audit_api` roles.
`core.storage_summary(jsonb)` counts structured records per collection and
application in the caller tenant, including legacy `core.records`, and returns
only names, counts and timestamps. `core.workflow_audit_access(jsonb)` is a
boolean `audit.read` gate for the tenant workflow history list. Both require a
verified principal with `audit.read` and never return record contents, object
keys, object names or bytes. The migration also grants the application owner a
tenant-scoped read policy on `core.records` so the aggregate function can run
under forced row-level security.

## Storage collection structure (026)

Migration 026 adds `core.storage_collections(jsonb)` and the private
`junctura_storage_collections_api` role. The function verifies `audit.read` in
PL/pgSQL from the verified caller claims, confines the lookup to the caller
tenant and issuer, and returns each collection's record count, latest creation
time and inferred field structure. Types come from `jsonb_typeof` over at most
the 200 newest records; the function never returns a record value, sample row or
object key. It is `SECURITY DEFINER`, owned by `junctura_app_owner`, executable
only by the private role, and ends with the pgREST schema reload. Migration 025
stays immutable.

## C4B forward corrections

Migrations 013-017 are additive corrections to 012, preserving existing records,
ownership, forced RLS and audit. The version-16 runner first verifies the old
fingerprint scope, then includes `composition_private` in the new fingerprint.
No adoption flag is needed for this transition. The drift test also proves
Composition RLS tampering is rejected. CRLF transaction delimiters are stripped
before execution, while checksums still hash the original file bytes; 013's
applied CRLF bytes are explicitly preserved by `.gitattributes`. Never normalize
an already-applied migration or replace its recorded checksum silently.

The inspected development checkout also contains pre-existing mixed line endings
in 006. Its original working-tree bytes match that database's checksum and were
left unchanged. A future replacement with Git-normalized bytes must fail the
checksum check; investigate/restore the recorded bytes rather than treating it as
permission to reapply authority SQL. Fresh installs hash their actual checkout.

## Versioned app records (030)

Drain old Core instances and application record writers before applying 030.
The migration revokes direct PostgREST mutation of `core.app_records`. Bring up
Core with `record_command` support before resuming traffic. Existing v2 records
retain their data, IDs, owners and creation times. Each receives version 1 and a
new incarnation, and existing collection counts are backfilled. V1 is unchanged.

The migration creates the NOLOGIN, NOBYPASSRLS role `junctura_record_api`. Ensure
it exists before restoring a backup that contains the new RPC grants and set
its `statement_timeout` to four seconds. Configure
collection limits through `app_private.record_collections.max_records`. A null
limit leaves the collection unmetered. Grant management reads by adding an
`app_private.record_read_grants` row for the exact enrolled principal and app.

## Record queries (031)

Adds the private record query RPC and cursor state for long sort keys.

## Record locks and increments (032)

Adds the tenant-scoped `app_private.record_locks` table and extends the record
RPC to check expiry and ownership under the record lock. Existing records
start with no lease. Increment operations apply in request order and commit
one record version.

## Record batches and unique-key upserts (033)

The record RPC uses the existing collection locks for upserts and locks all
collections in name order for a batch. A failed batch rolls back its records,
leases, projections and counters together. The idempotency receipt retains
the resulting business error for replays.

## Record archives (034)

Adds the archive RPC for owner-only export snapshots and transactional imports
that retain source record IDs.

## App group shares (035)

Adds tenant-scoped app groups and membership, plus the optional group recipient
on record read shares. Existing exact app grants are preserved.

## Subject bindings (036)

Adds the tenant-scoped table binding an operator-assigned `subjectId` to exactly
one OIDC login subject per (tenant, issuer), plus the read-side check RPC that
verifies a caller's own claim against that binding. Nothing here is writable
through Core; provisioning inserts rows directly.

## Directory management (037)

Extends the management permission vocabulary with `directory.write` and adds
the durable desired state for unit types, flat units, per-unit groups and unit
memberships. Every row carries a generation and a synchronization status; a
change is confirmed only after the identity provider state has been read back,
and confirmations are keyed by generation so an older job never overwrites a
newer one. Every command takes a per-tenant advisory lock, deletions remain as
durable tombstones until confirmed (so a generation is never reused across a
delete and recreate), a confirm that no longer matches the row generation is a
lost race reported as a conflict, and mutations additionally require the
`core-writer` role relayed by Core.

## Verified subject consents (038)

Consent list, grant and revoke now require a verified subject identity and use
the bound `subjectId` as the canonical data subject, resolved one way only: a
login subject maps to its bound subjectId, never the reverse. Each consent row
carries that canonical key; the one-time backfill moved legacy rows written
under a login subject to the bound subjectId, while rows no binding reaches
stay quarantined with no canonical key until an operator re-maps them during
reconciliation. Binding rows refuse identifiers shared between a subjectId and
a login subject in the same tenant and issuer, and the per-subject
active-consent limit counts and creates under its own advisory lock. Consent
checks during capability execution resolve the named person through the same
one-way join, so consents granted before verified subjects keep their
authority, and the data subject's access log shows calls recorded under either
of their identifiers.

## Workflow deadlines and completion (039–041)

Migration 039 creates operator-managed definition policies keyed by tenant and exact Flowable definition ID.
Managed starts keep their reservation, effective unit assignments and deadlines in a private execution table
and record the first response in the shared idempotency ledger. Existing checkpoint reservations remain
in `core.workflow_requests`. Install bindings for each business definition version before starting it.

Migration 040 adds expiring claims and a completion outbox. The tenant-scoped workflow RPC checks the task
unit, candidate groups and active claim before committing records, the outbox and the replay receipt.
A separate internal worker role leases pending entries. It publishes task history only after seeing the
matching task-local marker and successful end in Flowable history. Both roles use RPC grants and the private
tables enforce tenant RLS.

Migration 041 adds a cancellation lease to the workflow execution row. If Flowable still reports the
execution as running after a failed cancellation, the holder can reopen it for tasks. It also allows
empty history for executions without task policy and aligns checkpoint key conflicts with legacy starts.

Keep the PostgreSQL execution/outbox data and Flowable history together during backup and restore. An
unconfirmed engine outcome stays pending and retries with a capped delay. A task ended by external deletion
is marked `cancelled`. A task ended by a different command is marked `unconfirmed`. History contains
confirmed completions. Use the stored execution and task IDs to reconcile committed records with Flowable.

## File, audit, search and access events (042–046)

- Migration 042 adds application payloads to the existing tenant audit chain. It preserves historical
  hashes and seals the action, classification and subject visibility at append. Export projects the
  authorized view under the chain lock and materializes a short-lived snapshot. Direct operational SQL
  that writes `core.app_records` without identity claims fails closed on the publish trigger, so run
  such maintenance through the service roles.
- Migration 043 adds published object metadata, incarnation-bound record links and quotas on bytes.
  Every upload stages its candidate version before the Filer stores bytes; an internal reconciliation
  worker measures unmeasured versions from the Filer and cleans staged attempts, and a commit refuses
  to charge while unmeasured versions remain.
- Migration 044 queues index updates in the source transaction and checks live authority before returning
  search references. Keep Meilisearch private. Its index can be rebuilt from the authoritative store.
- Migration 045 adds a short-lived per-tenant notification journal. Deferred triggers publish record
  status changes and consent revocations at commit. Core replicas observe active tasks from Flowable
  and deduplicate them in PostgreSQL. Clients reconnect from the current head.
- Migration 046 adds separate subject reports and reads application access through the projection
  introduced in migration 042. The page key keeps full timestamp precision and concurrent writers of
  the same report or feedback read the winning row instead of failing.
