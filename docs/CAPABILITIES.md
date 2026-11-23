<!-- SPDX-FileCopyrightText: 2026 Junctura Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Capabilities and applications

Layer 1 registers applications, publishes versioned capabilities, grants exact access between
applications, invokes providers through Core, and composes sequential plans. Registration,
publication, grants and emergency review are **platform-access approvals**. Core never approves
business work; applications own those decisions. See [ARCHITECTURE.md](ARCHITECTURE.md).
Execution/composition are opt-in and disabled by default. Contracts: [Foundation API](contracts/foundation-api.openapi.json),
[capability API](contracts/capability-api-v1.openapi.json); the latter also contains design surfaces beyond this subset.

## Concepts

| Term | Meaning |
| --- | --- |
| Application | Tenant-scoped binding of an OAuth client, owner and canonical HTTPS provider origin; state is pending, active, suspended or revoked. |
| Enrollment | Operator-attested issuer/client/owner/origin record; `resource_subject` binds a verified backend service-account subject. |
| Principal permission | Explicit database permission bound to tenant, issuer, subject and management client. |
| Capability version | Exact capability URN plus `major.minor.patch`, owned by a provider application. |
| Manifest / digest | Versioned JSON contract and its RFC 8785 JCS SHA-256 digest, written as `sha256:<lowercase hex>`. |
| Grant | Immutable proposal connecting one provider, one consumer and one exact capability reference, with bounded operations, permissions, subject and expiry. |
| Approval | Independent platform-access decision bound to an exact resource digest, revision, requester, application and expiry. |
| Execution | Durable reservation binding an initiating backend, request, original grant, deadline and idempotency key. |
| Ticket | Opaque, short-lived, single-use provider authorization bound to an invocation and canonical input digest. |
| Composition | Consumer-owned versioned plan of sequential capability steps with whole-value input/output bindings. |

## Permissions

Core live-introspects OIDC credentials and requires `core-reader`, a verified tenant and matching
tenant membership. `core-writer` also gates Trust mutations, invocation, provider redemption and
emergency review writes. Baseline roles alone supply no management authority. Operators provision
enabled `app_private.principals`; none of the following permissions is assigned by default.

| Principal permission | Holder and authority |
| --- | --- |
| `applications.register` | Enrolled human owner: register an exactly enrolled application. |
| `applications.approve` | Human administrator: application administration; activation/decisions also require `trust.approve`. |
| `capabilities.write` | Enrolled provider owner: create drafts and manage owned versions; creation also allows an authorized publisher with this permission. |
| `capabilities.publish` | Tenant capability administrator: management visibility and mutation authority; required to publish. |
| `capabilities.approve` | Independent enrolled human: decide capability publication. |
| `trust.write` | Enrolled human provider owner: propose/read/revoke its direct grants. |
| `trust.approve` | Independent human administrator: decide/activate grants, read/revoke tenant grants, view tenant trust graph and review break-glass access. |
| `compositions.write` | Explicitly enrolled consumer backend: create plans; authorized owners/writers manage drafts and lifecycle. |
| `compositions.publish` | Tenant composition administrator: management reads and publication. |
| `compositions.approve` | Independent enrolled approver: decide composition publication. |
| `audit.read` | Enrolled management principal: tenant audit reads and verification; see [SECURITY.md](SECURITY.md#audit). |

Human management and backend subject enrollments are separate attestations; registration, shares and Console
confer no permissions. Live introspection supplies issuer/subject/client/tenant; bodies cannot choose identity or SQL role.

## Application registration

Before enrollment, verify through authenticated Keycloak administration:

- Exact realm issuer, enabled provider client and intended ownership; verify TLS origin ownership
  and network destinations out of band. Use a canonical HTTPS hostname origin without path,
  query, fragment, credentials or IP literal.
- Enabled human owner and separate human approver, without `serviceAccountClientId`;
  verify current tenant attribute and administrator-owned tenant group membership.
- Enabled management client for authorization-code + PKCE. Make tenant attributes administrator-managed
  user-profile fields, read back user/group records, and test `GET /v1/identity` before granting access.

Execute reviewed SQL through trusted database administration, substituting verified values for every placeholder.

```sql
BEGIN;
INSERT INTO app_private.principals
  (tenant_id,issuer,subject,management_client,permissions)
VALUES
  ('VERIFIED_TENANT','EXACT_ISSUER','VERIFIED_OWNER_SUBJECT','VERIFIED_MANAGEMENT_CLIENT',
   ARRAY['applications.register']);
INSERT INTO app_private.principals
  (tenant_id,issuer,subject,management_client,permissions)
VALUES
  ('VERIFIED_TENANT','EXACT_ISSUER','DIFFERENT_HUMAN_SUBJECT','VERIFIED_MANAGEMENT_CLIENT',
   ARRAY['applications.approve','trust.approve']);
INSERT INTO app_private.enrollments
  (tenant_id,issuer,oauth_client_id,owner_subject,provider_origin)
VALUES
  ('VERIFIED_TENANT','EXACT_ISSUER','VERIFIED_PROVIDER_CLIENT','VERIFIED_OWNER_SUBJECT',
   'https://verified-provider.example.invalid');
COMMIT;
```

Bind verified backend service-account user IDs as `resource_subject` for discovery/invocation/redemption/v2;
see [resource authorization](SECURITY.md#resource-authorization). Record operator changes through change control.
Principal `enabled=false` blocks API administration; disabled enrollment blocks new registration/activation.

| Method | Route | Task |
| --- | --- | --- |
| POST | `/v1/applications` | Register a pending application. |
| GET | `/v1/applications/{appId}` | Read an owned or administratively visible application. |
| POST | `/v1/applications/{appId}/approve` | Activate with `{approvalId}` and `If-Match`. |
| POST | `/v1/applications/{appId}/state` | Suspend, reactivate or revoke with `If-Match`. |
| POST | `/v1/approvals` | Decide application, capability-version, grant or enabled composition-version access. |
| GET | `/v1/approvals/{approvalId}` | Read an authorized decision. |
| POST | `/v1/approvals/{approvalId}/revoke` | Revoke a decision with `{reason}` and `If-Match`. |

1. Owner POSTs only `{displayName, oauthClientId, providerOrigin}`, matching enrollment exactly.
   Response: **201**, `Location`, `ETag`, server `appId`, tenant, owner, `pending`, revision and digest.
2. Independent administrator GETs the app and POSTs `/v1/approvals`: `resourceType: "application"`,
   `resourceId` and `requesterAppId` equal to `appId`, stored owner as `requesterSubject`, matching
   `resourceDigest`/`resourceRevision`, `decision: "approve"` or `"deny"`, and future UTC-Z
   `expiresAt` within ten minutes.
3. The same administrator POSTs `/approve` with `{approvalId}` and exact `If-Match`. Core rechecks
   enabled owner/enrollment and atomically consumes approval, activates and audits. Stale, expired,
   denied, revoked or consumed approvals fail activation.
4. Administrator POSTs `/state` with `{action, reason}` and exact `If-Match`. `reactivate` requires
   a new `approvalId` for the suspended revision; `suspend`/`revoke` reject it. Revocation is terminal.
5. Owner/administrator may GET the decision. Its deciding administrator may revoke an unconsumed
   application approval with its ETag; suspend/revoke the app to undo already activated access.

| Status / error | Meaning |
| --- | --- |
| 400 `invalid_json`, `invalid_application_body`, `invalid_application_path` | Malformed JSON, fields or path; malformed approval references also return 400. |
| 400 `invalid_application_approval`, `invalid_approval_expiry` | Malformed approval body or expiry; elapsed or outside the ten-minute bound. |
| 401 `bearer_token_required`, `invalid_token` | Authentication failed. |
| 403 `application_permission_required`, `provider_not_enrolled`, `owner_not_enrolled` | Required principal or enrollment authority is absent. |
| 403 `independent_approver_required` | Required separation of duties failed. |
| 404 `not_found` | Missing/foreign resource or concealed same-tenant ownership. |
| 409 `application_conflict`, `invalid_transition`, `approval_stale` | Duplicate client binding, invalid lifecycle change or unusable approval. |
| 428 `if_match_required` / 412 `revision_mismatch` | Missing/stale exact `If-Match`. |
| 413 `body_too_large` / 415 `json_required` | Body exceeds 64 KiB or media type is not `application/json`. |
| 503 `identity_unavailable`, `applications_unavailable`, `approvals_unavailable` | A required dependency failed. |

Application bodies reject duplicate/unknown keys, nested values, invalid Unicode and identity/state
overrides. Proposal hashing uses the object/string JCS subset including tenant and owner; lifecycle
changes increment revision without changing proposal contents. Treat returned ETags as opaque.
Application/approval errors include `error` and `requestId`; gateway authentication errors keep their representation.
Duplicate client binding remains reserved after revocation.

## Capability registry

| Method | Route | Task |
| --- | --- | --- |
| GET | `/v1/capabilities` | List visible versions; `limit` 1–100 and optional `cursor`. |
| POST | `/v1/capabilities/{capabilityId}/versions` | Register an exact draft manifest; 201. |
| GET | `/v1/capabilities/{capabilityId}/versions/{version}` | Read a visible version. |
| PUT | `/v1/capabilities/{capabilityId}/versions/{version}` | Replace draft manifest; `If-Match`. |
| POST | `/v1/capabilities/{capabilityId}/versions/{version}/validate` | Record report; `{}` and `If-Match`. |
| POST | `/v1/capabilities/{capabilityId}/versions/{version}/publish` | Publish with `{approvalId}` and `If-Match`. |
| POST | `/v1/capabilities/{capabilityId}/versions/{version}/deprecate` | Deprecate publication; `{reason}` and `If-Match`. |
| POST | `/v1/capabilities/{capabilityId}/versions/{version}/revoke` | Terminal revocation; `{reason}` and `If-Match`. |

Create with `capabilities.write`, active provider application/enrollment, and owner authority or
`capabilities.publish`; the enrolled provider owner must retain `capabilities.write`. Capability IDs
use `urn:junctura:capability:<provider-app-id>:<slug>`; permission URNs use
`urn:junctura:permission:<provider-app-id>:<slug>`. Manifest provider and request path must agree.
Management reads/mutations require the owning writer or a `capabilities.publish` administrator.

Use the [manifest schema](contracts/capability-manifest-v1.schema.json) and
[implementation](../src/modules/capability/registry/manifest.mjs). Manifests declare identity/version,
title/description, input/output schemas, invocation, permissions, side effects, timeout and preconditions.
The 64 KiB strict parser rejects duplicate keys, malformed UTF-8/Unicode and nonfinite numbers.
Validation rejects unknown fields, external references, unsupported keywords and unsafe integer schema bounds.
Schemas use bounded objects/arrays/strings/numbers/integers, booleans and null; objects require
`additionalProperties: false`. RFC 8785 JCS hashes the full manifest; registration never contacts providers.

Draft replacement increments revision and clears validation, making earlier approvals stale.
Validation binds digest/revision/policy without incrementing content revision. Publication requires
a current valid report and independent `capabilities.approve` decision through `/v1/approvals`,
`resourceType: "capability-version"`. Use `versionId` or `capabilityId@version` as `resourceId`;
the bare-ID alias must resolve one digest/revision. Bind `requesterSubject` to `createdBy`,
`requesterAppId` to provider. Expiry: future UTC-Z within ten minutes. Approver differs from creator,
provider owner and publishing caller; publisher needs `capabilities.publish`. Consumption is single-use.

Publication, deprecation and revocation increment revision. Published content is immutable;
revocation is terminal. Conflicts include 409 `capability_conflict`, `immutable_version`,
`validation_required` or `approval_stale`; invalid manifests return 422 `invalid_manifest` with issues.
Required audit writes, including validation reports and approval consumption, commit atomically
with changes. See [SECURITY.md](SECURITY.md#audit) for audit access.

## Direct trust grants

Propose one exact `{capabilityId, version, manifestDigest}` between different active same-tenant apps.
`operations`: `discover`, `invoke` or both; `permissions`: nonempty manifest subset; `subjectIds`:
the consumer enrollment's single verified `resource_subject`. `delegationAllowed`/`acceptDelegation`: false.
Increased authority needs a new immutable proposal/approval. All mutations require `core-writer`.

| Operation | Authority | Concurrency / result |
| --- | --- | --- |
| POST `/v1/trust/grants` | Provider owner with `trust.write`. | Exact published digest and live targets; 201 pending. |
| GET `/v1/trust/grants/{grantId}` | Owning provider writer or `trust.approve` administrator. | Tenant-scoped view and effective expiry. |
| POST `/v1/approvals` (`resourceType: "grant"`) | Independent `trust.approve` human, different from creator/provider owner. | Bind grant ID, digest, revision, creator and provider; 201 decision. |
| POST `/v1/trust/grants/{grantId}/activate` | Same deciding administrator with `trust.approve`. | `{approvalId}`, exact `If-Match`; atomic single consumption/activation. |
| POST `/v1/trust/grants/{grantId}/revoke` | Owning provider writer or `trust.approve` administrator. | `{reason}`, exact `If-Match`; terminal from pending/active/effectively expired. |
| GET capability version/list | Owning registry writer/publisher or consumer with exact `discover` authority. | Visibility filtered before pagination. |

Grant approval expiry is at most ten minutes and no later than grant expiry. Consumed approval
expiry is the activation deadline; grant expiry controls later authority. Expired pending/active
grants read as `expired` using server time. Revocation retains history. Missing/stale ETags return
428/412; unusable decisions return 409 `approval_stale`. Foreign targets are concealed;
non-owner proposals return 403 `provider_owner_required`.

Consumers see published manifest/version metadata only, excluding private reports, creator/approval
and OAuth data. `invoke` alone grants no discovery. Consumer cursors bind tenant/application and
never preserve authority across changes. The internal
[eligibility function](../src/modules/capability/trust/trust.mjs) freshly introspects and calls private
`core.trust_eligibility`, returning only `{allowed, reason}`. Discovery/eligibility share a live SQL
predicate checking identity binding, active applications/enrollments, exact published digest,
unexpired grant, operation, subject, consumed independent approval and current creator/approver
authority. One grant must cover every required manifest permission; partial grants are never combined.
`invoke` also requires `core-writer`. Deprecation/revocation, disabled authority, subject rebinding or
inactive apps block subsequent checks. Reads use a statement snapshot; an authorized in-flight read may finish.

`GET /v1/trust/graph` takes no query parameters: `trust.approve` or `audit.read` sees tenant scope,
`trust.write` alone sees owned providers. It returns application nodes and up to 500 newest grant edges with
effective states, operations, revisions and timestamps; `truncated` indicates more. `readOnly` is `true`
when the caller holds neither `trust.write` nor `trust.approve` (pure `audit.read` viewers), `false`
otherwise. Digests, permissions, subject bindings and approvals stay private. Locally, `npm run trust:demo`
enrolls `app-danhba`, `app-vanban`, `app-lichhop`, `app-thongbao`, publishes `contact-lookup`,
`document-summary`, `availability`, and creates active/pending/revoked grants. `npm run trust:demo -- token`
prints a local-only approver token for Console LIVE mode.

## Capability execution

Set `C4A_ENABLED=true` and approved origins before starting Core. Identity, private data
authority/signing and Flowable configuration must be complete; no approved origins fails startup.
Origins come from application enrollment and must match an operator allowlist.
With both runtimes disabled, execution routes return 404; composition alone returns
422 `capability_runtime_disabled` for single-capability submissions.
When capability execution is enabled, Core forwards the request to the provider with a one-time ticket and checks consent when the call names a data subject, under the current policy.

| Environment variable | Value |
| --- | --- |
| `C4A_ENABLED` / `C4B_ENABLED` | `true` enables single-capability / composition runtime; default false. |
| `C4A_PROVIDER_ORIGINS` / `C4B_PROVIDER_ORIGINS` | JSON arrays of exact approved public HTTPS origins, e.g. `["https://provider.example.org"]`. |
| `C4A_INTERNAL_PROVIDER_ORIGINS` / `C4B_INTERNAL_PROVIDER_ORIGINS` | JSON arrays of exact lowercase HTTPS `.internal` origins. |
| `PROVIDER_CA_FILE` | PEM CA file required when internal origins are configured. |

| Method | Route | Task |
| --- | --- | --- |
| POST | `/v1/capability-executions` | Reserve execution using a UUID `Idempotency-Key`. |
| GET | `/v1/capability-executions/{executionId}` | Read as original tenant/app/issuer/subject/client with current invoke authority. |
| POST | `/v1/capability-authorizations/introspect` | Provider authenticates independently and redeems its ticket. |

Single-capability requests contain `target`, `input`, and optional `context`:

```json
{
  "target": {"kind": "capability", "capability": {
    "capabilityId": "urn:junctura:capability:<provider-app-id>:text-normalize",
    "version": "1.0.0", "manifestDigest": "sha256:<manifest-hex>"
  }},
  "input": {"text": "example"}
}
```

Replace placeholders and satisfy the input schema. New reservations return **202** plus `Location`;
identical authorized replays return **200**. Changed body/context returns 409 `idempotency_conflict`.
Missing/non-UUID keys return 400 `uuid_idempotency_key_required`; input violations return
422 `invalid_execution_input`. The original grant stays bound even if a replacement becomes eligible.
The deadline is bounded by manifest `timeoutMs` (100–10000 ms) and original grant expiry;
the memory lease also expires with the credential.

Core POSTs `{invocationId, capability, input}` with an opaque Bearer ticket and
`Idempotency-Key: <stable operation UUID>`. Using its own enrolled OIDC credential, the provider POSTs
`{ticket, invocationId, inputDigest}` to introspection **before executing**. `inputDigest` is input's
JCS SHA-256. Valid redemption returns `active: true`, expiry and caller context; invalid/replayed tickets
return 200 `{active: false}` without context. Tickets have 256 bits of entropy, persist only as hashes,
and expire within 30 seconds and all lease/grant/deadline bounds. Success requires redemption,
HTTP **200**, exactly `{output: ...}` and output-schema validation. Strict JSON wire limit: 64 KiB.

Flowable runs a [fixed process](../infra/flowable/capability-single.bpmn20.xml); Core verifies deployed
bytes and reserved-job correlation. Engine variables hold execution ID/input digest/deadline, never
input or credentials. The deadline timer ends queued work.

Optional `context` requires `purpose` matching `^[a-z][a-z0-9_]{1,62}$`, e.g. `verification`;
`dataSubject` is an optional identity-provider subject of 1–255 UTF-16 code units without controls (422 `invalid_execution_context` otherwise).
Context binds the request digest and is stored privately/returned on redemption; audit records purpose/subject hash.

| Method / route | Consent or emergency task |
| --- | --- |
| GET / POST `/v1/me/consents` | List own consents / create `{consumerAppId, capabilityId, purposes, expiresAt}`; 201. |
| POST `/v1/me/consents/{consentId}/revoke` | Revoke own consent with `{}`; 200. |
| GET `/v1/me/data-access` | Own newest 200 named calls: purpose, applications, capability, state and emergency/review flags. |
| GET `/v1/emergency-accesses` | `trust.approve` administrator lists reviews. |
| POST `/v1/emergency-accesses/{executionId}/review` | `trust.approve` plus `core-writer`: `{decision: "justified" or "unjustified", note}`; 200. |

Naming a subject requires consent for that consumer/capability/purpose, otherwise 403
`consent_required`, `consent_revoked` or `consent_expired`. Consent allows 1–8 purposes, future expiry within 366 days and 200 active
consents per subject (429 `consent_limit_reached`), rechecked at redemption. Consent/review bodies: 16 KiB.
Emergency context adds `emergency: true`, `dataSubject` and 10–500-character `justification`: it bypasses
consent, retains Trust checks, audits `execution.emergency_access` (sealed at the next chain verification), flags provider/subject views and queues
review. Five pending consumer reviews trigger 429 `emergency_review_backlog`. Review notes: 1–500
characters; a second decision returns 409 `already_reviewed`.

For internal providers, run `npm run provider:pki -- unit-a unit-b`, configure
`C4A_INTERNAL_PROVIDER_ORIGINS` (or composition equivalent), e.g. `https://unit-a.provider.internal:8443`,
then run `docker compose -f compose.yaml -f compose.providers.yaml up -d`. The pure-Node helper writes
CA/provider certificates and mode-0600 keys under `.junctura/pki`. The override mounts only `ca.crt`
into Core as `PROVIDER_CA_FILE`; attach providers to its isolated `providers` network with matching aliases.

The [provider transport](../src/modules/capability/execution/provider-network.mjs) enforces:

- Exact HTTPS origins; manifest paths ≤256 characters with letter/digit/`_`/`-` segments.
  Redirects, encoded traversal, queries and fragments fail.
- Check every DNS answer and pin the first approved address, preserving hostname/SNI. Public policy
  denies private/special-use destinations; internal policy allows only RFC 1918 IPv4/IPv6 unique-local,
  verified TLS and the operator CA with matching certificate names.
- Internal origins cannot overlap public/test origins; loopback, link-local, carrier-grade NAT
  and metadata destinations remain denied.
- Fixed headers, shared DNS/connect/request deadlines and bounded JSON bodies; no forwarded caller
  credentials/headers or proxy environment variables. Live lease/Trust checks and dispatch audit precede sockets.

States: `accepted`, `running`, `succeeded`, `failed`, `auth_required`, `timed_out`, `outcome_unknown`; only success
exposes output. Possible receipt then lost response/persistence yields `outcome_unknown`; errors include
`invalid_execution_output`, `provider_failed` and `provider_authorization_required`.
After process loss, reads reconcile untouched work to `auth_required` (or `timed_out` after the deadline), possible dispatch to `outcome_unknown`.
Only the original initiator can replay untouched work before deadline to reauthenticate/reuse the process.
Errors include 403 `invoke_not_authorized`, 409 `execution_deadline_expired`, 409 `result_expired` and
429 `execution_capacity_exceeded` (default 1,000 live leases per runtime).

## Composition

Enable independently with `C4B_ENABLED=true` and its public/internal origin settings.
Use the [composition schema](contracts/composition-v1.schema.json).

| Method | Route | Task |
| --- | --- | --- |
| POST | `/v1/compositions` | Create plan and initial draft version; 201. |
| POST | `/v1/compositions/{compositionId}/versions` | Add exact draft version; 201. |
| GET | `/v1/compositions/{compositionId}/versions/{version}` | Read an authorized version. |
| PUT | `/v1/compositions/{compositionId}/versions/{version}` | Replace draft with `If-Match`. |
| POST | `/v1/compositions/{compositionId}/versions/{version}/validate` | Validate `{}` with `If-Match`. |
| POST | `/v1/compositions/{compositionId}/versions/{version}/publish` | Publish `{approvalId}` with `If-Match`. |
| POST | `/v1/compositions/{compositionId}/versions/{version}/deprecate` | Deprecate `{reason}` with `If-Match`. |
| POST | `/v1/compositions/{compositionId}/versions/{version}/revoke` | Terminal revocation `{reason}` with `If-Match`. |

Creation requires the enrolled backend's `compositions.write`; its consumer resource binding owns the plan.
Draft/lifecycle changes require `compositions.write`; publication needs `compositions.publish`, valid
validation and independent `compositions.approve`. Approvals reuse `/v1/approvals` with
`resourceType: "composition-version"`, composition ID, digest/revision, creator and owner app; expiry ≤ten minutes.
App owner/creator cannot approve; publisher differs from the still-enabled approver. Validation increments
revision: use its new ETag/revision for approval. Draft replacement clears validation; published content is immutable.

Plans contain `compositionFormat: "1.0"`, name, exact version, input/output schemas, `deadlineMs` (100–60000)
and 1–16 unique steps pinning exact capabilities/digests. First input: `{source: "composition-input"}`;
later: `{source: "step-output", stepId: "<immediately-previous-step>"}`. Compatibility must prove every
whole-value edge, including plan input/final output; indeterminate proofs fail validation. SQL requires
provider timeouts plus 300 ms per step to fit the execution plan deadline (422 `composition_deadline_exceeded`).

POST `/v1/capability-executions` with exactly `{target, input}` and UUID `Idempotency-Key`.
Target is `{kind: "composition", compositionId, version, compositionDigest}`. Only the owning
consumer executes; every step needs live direct invoke authority. Reservation/replay/conflict return
202/200/409. Each step has one stable operation ID, one ticket and at most one attempt; later input
digests bind preceding canonical output. Replacement grants cannot revive a revoked reserved grant.

| Transition | Required evidence / resulting state |
| --- | --- |
| reserve → engine reserve/bind | `accepted`; serialized key, audit, durable start marker and exact process correlation. |
| prepare → dispatch → redeem | `running`; current pending step, live lease/authority, exact provider/input ticket; intent audited before socket, redemption consumed atomically. |
| step output | Valid output and consumed ticket; advance exactly one index while overall state remains `running`. |
| engine completed | All steps succeeded plus matching naturally completed Flowable history; commit final output and `succeeded`. |
| failure / observation | `failed`, `timed_out`, `auth_required` or `outcome_unknown`; stop later dispatch and preserve evidence. |
| terminal mutation | `succeeded`, `failed`, `timed_out`, `outcome_unknown` and stored `cancelled` cannot return to active/success. |

- Flowable is the sole engine. Core verifies generated BPMN bytes, tenant, definition/process,
  business key, activity/topic, execution ID, input digest and deadline variables. Acquire has no tenant
  filter; unmatched jobs get zero retries.
- Reconcile ambiguous starts against runtime/history using the durable marker/unique business key.
  Exactly one process may bind; otherwise 409 `execution_pending_reconciliation`. No blind second start.
- Restart loses leases. Observation marks untouched work `auth_required` (`timed_out` after the deadline), possible unfinished
  dispatch `outcome_unknown`. Replay cannot restore a composition lease. BPMN deadline timers independently stop work.
- Core terminates failed/lost-lease/expired processes. Unconfirmed cleanup returns
  503 `workflow_termination_unconfirmed`; status reads retry cleanup, preserving the durable outcome.
  Lost completion confirmation may leave an unknown result.

## Storage and recovery

`app_private`, `trust_private`, `execution_private`, `composition_private`: nonlogin `junctura_app_owner`,
forced tenant RLS. API roles `junctura_app_api`, `junctura_capability_api`, `junctura_trust_api`,
`junctura_execution_api`, `junctura_composition_api`, `junctura_subject_api`, `junctura_audit_api` call
owner-controlled RPCs without private-table access. Core signs assertions; apps receive no SQL/PostgREST credentials.

Relevant migrations: 003 application authority; 004 resource subject; 005 protected audit; 006 registry;
007–009 Trust/discovery; 010–011 execution/registry validation; 012–017 composition authority/finalization;
018 audit sealing; 019 trust graph; 020 purpose/subject access; 021 consent/emergency.
Run `docker compose run --rm data-migrate` from the current checkout before Core startup. The runner
applies pending migrations and checks applied bytes, inventory and authority fingerprints; follow
[migration rules](DEVELOPING.md). Back up schemas, approvals, grants, execution/step/ticket evidence
and audit together, preserving roles, ownership, ACLs and RLS. Retain authority/history on code rollback;
there are no destructive down migrations. See [OPERATIONS.md](OPERATIONS.md).

## Verification

Use an isolated Node 24 development stack with dependencies/contract validators configured. Run integration
suites **sequentially**: they exercise shared dependencies/restarts. Provider network tests need host OpenSSL.

```sh
npm run check
npm test
npm run check:docs
npm run check:contracts
npm run test:contract-validator
npm run test:applications
npm run test:capabilities
npm run test:compositions
npm run test:execution-ledger
npm run test:provider-network
npm run test:flowable-worker
npm run test:audit
npm run test:recovery
```

## Limitations

- Direct grants/execution are same-tenant backend authority. Human delegation, cross-tenant forwarding,
  public catalog and resolver HTTP endpoints are unavailable; schema compatibility proves structure only.
- Execution requires `sideEffects.kind: "none"` and `preconditions.approval: "none"` (otherwise
  422 `unsupported_execution_precondition`). Invocation approvals, arbitrary provider URLs/BPMN, retries,
  public cancellation and general resume are unsupported. Composition accepts no context.
- Leases belong to one Core process: no HA routing, unattended refresh or administrative/service-account
  substitution. Composition recovery is observation-driven, without restart scanning/automatic continuation;
  unobserved rows may retain active labels.
- Revoked initiators cannot read/finalize records; rows may remain nonterminal. Missing/multiple history needs investigation.
- Deadlines/timer reconciliation are not hard real-time. Results have at least 24-hour retention;
  no automatic purge or idempotency-key recycling. Preserve tombstones.
- Providers must honor redemption/side effects. Core cannot prove external behavior, exactly-once effects
  or correct consumer-declared subjects; providers must check input against declared subject/purpose.
- App suspension/revocation blocks consumer discovery/invocation and v2 use (owners/publishers keep registry
  management), but does not disable OAuth clients or change generic legacy record access. Owner transfer/physical deletion have no API; returned metadata cannot be recalled.
- Trusted database/host operators remain necessary; a `junctura_data`-only restore excludes identity, engine history and object data (use `npm run backup`/`restore` for all stores).
