<!-- SPDX-FileCopyrightText: 2026 Junctura Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Changelog

All notable changes to Junctura are recorded here. Versions follow
[Semantic Versioning](https://semver.org/).

## Unreleased

- **Domain-neutral workflow samples (issue #28):** the three medical BPMN
  workflows in `src/modules/workflow/definitions/` are replaced by "Phê duyệt
  yêu cầu", "Xác minh hồ sơ" and "Đối soát chứng từ" (each has three named steps
  assigned to a unit). `workflow.mjs`, `summary.mjs`, the Console diagrams and
  i18n (vi/en), the API docs and the tests use the new process keys
  (`junctura_phe_duyet_yeu_cau`, `junctura_xac_minh_ho_so`,
  `junctura_doi_soat_chung_tu`). Workflow behavior is unchanged; Layer 1 no longer
  carries medical terms or data.

- **Layer 1 no longer seeds health data (removed):** `npm run seed:health`, its
  `scripts/lib/seed-health-*` helpers and tests, and `npm run demo:seed` are gone.
  Layer 1 stays domain-neutral; the health scenario (applications, capabilities,
  grants, records) is created from the Layer-2 repository with `npm run demo:setup`
  in `junctura-health`. `npm run demo:provision` is unchanged and still creates the
  demo administrators and the read-only `viewer`. Earlier Unreleased notes that
  mention `seed:health` describe behavior that no longer exists. The Console shows
  no applications or capabilities until a Layer-2 scenario registers them.

- **Stack survives a host reboot:** long-running Compose services now use
  `restart: unless-stopped`, while init and migration jobs stay one-shot. After a
  reboot, OpenBao may return sealed; `npm run local:up` re-runs the init jobs.
- **Public demo login is read-only:** `npm run demo:provision` now also creates a
  `viewer` account (reader role, `audit.read` only) and publishes only that account
  in `/login-hints.json`. The `admin1`–`admin3` passwords move to the private
  `.junctura/demo-accounts.json` (mode `0600`) and are replaced on the first run,
  because the previous ones were served publicly. `--public-admins` restores the
  old behavior for loopback-only development.
- **Competition demo provisioning:** `npm run demo:provision` recreates the
  local `admin1`–`admin3` Keycloak users, upserts their Console permissions and
  writes the Git-ignored browser login hints, and `npm run demo:console` rebuilds
  the packaged Console. The packaged Nginx now serves a readable `/login-hints.json` without
  changing the `/api` allowlist. See [the demo server guide](docs/COMPETITION_DEMO.md).

- **Console layout cleanup:** Tổ chức now uses a full-width tree with an anchored detail note, Cài đặt uses the full width, Tài liệu opens the guide from the sidebar, and record collections are labelled datasets.

- **Console data structure and folder file browser:** Dữ liệu now opens a
  read-only collection structure panel from `GET /v1/storage/collections` with
  field names, Vietnamese data types, fill-rate bars, record counts, last update
  and owning application; record values and sample rows are never returned.
  Kho tệp is now a folder browser built on `GET /v1/storage/files`: the left
  column selects an application, the main panel navigates one directory level
  with a breadcrumb, shows folders and masked file names exactly as the API
  returns them, table/grid views and name/size/date sorting, with no download,
  preview, delete or upload action. The Tổ chức page was re-laid out into
  separate tree, relation and detail regions so nothing overlaps at mobile,
  tablet or wide desktop widths, and now distinguishes expired sessions with a
  retry action.

- **Console application detail and state-based sharing review:** the Ứng dụng
  list now opens a full detail page with owning unit, registrant and approver,
  registration/approval times, provided and used capabilities, sharing
  relations and storage totals; technical identifiers are collapsed. The
  Console no longer creates application registrations — applications register
  through the API, and administrators can only approve or reject a pending
  registration or revoke an existing application. Quyền truy cập is now a
  state-based sharing table (proposed, effective, rejected, revoked, expired)
  built from `GET /v1/trust/graph` and `audit.read` events; approve, reject and
  revoke are the only actions, and reject/revoke require a reason before calling
  the real Trust routes. Consents and emergency access became read-only
  oversight pages with aggregate figures and status lists, and the Bí mật screen
  was removed from navigation until a read-only listing API exists
  (`console/REMOVED-UNTIL-API.md`).

- **Console feature traffic and read-only workflow dashboard:** Lưu lượng now
  renders a fixed 60-minute table from `GET /v1/metrics/features?minutes=60`
  with one row per feature, request/error counts, average and peak latency, a
  hand-written per-minute SVG sparkline and a comparison bar, sorted by request
  count. The longer 6-hour and 24-hour selectors are gone; Tổng quan keeps the
  60-minute chart and the six latest requests. Quy trình is now observe-only:
  `GET /v1/workflows/summary` drives the workflow cards, owning-product table
  and step drawer, while `GET /v1/workflows/executions` drives a paginated case
  table that omits current step, assignee, content and per-case progress.
  Start, complete, cancel and trial-run controls and their client methods were
  removed; a note states that administrators only observe and each unit's
  application processes its own cases.

- **Storage file browser and collection structure APIs:**
  `GET /v1/storage/files` returns one level of an application's private file
  tree with folder totals and partially masked file names, sizes, scan status
  and timestamps. `GET /v1/storage/collections` returns inferred field names,
  JSON types and fill rates from at most the 200 newest records of each
  collection. Both require `audit.read`; the new migration 026 adds the private
  `junctura_storage_collections_api` role and `core.storage_collections(jsonb)`.
  Neither route returns record values, object keys, internal filer paths or
  bytes. `npm run seed:health` now also writes deterministic Vietnamese document
  folders (`ho-so/chuyen-tuyen/2026/...`, `ho-so/don-thuoc/...`,
  `giay-to/ket-qua-xet-nghiem/...`) through the real scanned object flow.

- **Per-feature traffic and workflow summary:** `GET /v1/metrics/features` groups
  the in-memory request counters by product feature and `GET /v1/workflows/summary`
  returns a read-only dashboard of business workflows (owning product, steps,
  running/completed/cancelled counts). Both require `audit.read`; neither can start,
  approve or stop anything and neither exposes patient data.
- **Console data, file and workflow overviews:** the Dữ liệu screen now reads
  `GET /v1/storage/summary` and shows per-application collection counts, total
  records and update times without exposing record content or write forms. A new
  Kho tệp screen shows aggregate file counts, storage and quarantine per
  application without file names or bytes, and is reachable from the Tệp function
  card and chips rather than the sidebar. Quy trình lists every tenant case from
  `GET /v1/workflows/executions` with Đang chờ / Đã duyệt / Bị từ chối filters,
  friendly Vietnamese workflow names, the current step, responsible unit and a
  horizontal progress row for running cases. The overview links the running-case
  count to the waiting filter.

- **Storage summary API:** `GET /v1/storage/summary` returns aggregate record
  counts per collection and application plus total file count, bytes,
  quarantine count and last update time. It requires `audit.read`, uses the
  private `junctura_storage_api` role added by migration 025, and never returns
  record content, object keys, file names or bytes. Record counts come from the
  real structured tables; file metadata is reduced from the object filer.

- **Workflow history API:** `GET /v1/workflows/executions` lists every workflow
  execution of the caller tenant, newest first, with `limit` (1–100) and
  `status=running|completed|cancelled`. Each row carries the real definition,
  status, timestamps, a safe business title, the active step and candidate
  groups for running executions; patient names, identifiers and workflow
  variables are excluded. The route requires `audit.read` through the private
  `junctura_workflow_audit_api` role.

- **Business workflow definitions:** the local workflow initializer now deploys
  fictional Vietnamese processes "Chuyển tuyến bệnh nhân", "Xác minh đơn thuốc"
  and "Xác minh chi phí bảo hiểm" with named steps and assigned units.
  `npm run seed:health` refreshes those definitions, starts pending and completed
  executions for them, and distributes records and files across the scenario
  applications. Its ClamAV check submits the harmless EICAR test string; the
  upload is rejected and never published.

- **Directory shows only active relations:** migration 024 replaces
  `core.directory_organizations(jsonb)` so `GET /v1/directory/organizations`
  lists a trust relation only when its grant is `active` and unexpired.
  Pending proposals, revoked grants and expired grants no longer appear as
  granted access in the organization tree. Migration 022/023 stay immutable;
  024 preserves the private role, ownership, ACLs and row limits.

- **Console directory clarity:** the Tổ chức screen now shows the Junctura
  platform card above a responsive grid of unit cards with right-angle SVG
  connectors, no horizontal scrolling and no arrow labels overlapping buttons.
  Unit cards show provided/used capability counts and relation counts; a
  separate “Quan hệ giữa các đơn vị” list renders each trust relation as
  provider → consumer · capability. Selecting a unit highlights only its
  relations and opens an incoming/outgoing detail card; selecting the platform
  card shows aggregate unit, relation and capability totals. The Người dùng
  screen is a clear table with display name + job title, organisation, kind
  (administrator/application), status and a “Xem quyền” drawer that lists
  permissions in Vietnamese, plus organisation/kind filters, name/organisation
  search and a “Bạn” badge for the signed-in operator. List screens across the
  Console now use empty states that explain what the list is for, why it is
  empty and what makes data appear.

- **Console operator shell:** the sidebar is now a flat seven-item menu
  (Tổng quan, Việc cần duyệt, Ứng dụng, Năng lực, Người dùng, Tổ chức, Nhật ký
  kiểm toán) plus Tài liệu API and Cài đặt. The Chức năng overlay drops the
  identity and gateway cards, keeps the six shared-function cards and their
  page chips, and the header count now matches those six cards. The overview
  uses three tabs — Tổng quan, Lưu lượng and Nhật ký
  request — with a hand-written SVG traffic chart, 1h/6h/24h aggregation and
  status/method filters, all read from the real metrics API. Người dùng and Tổ
  chức render the real directory principals and tenant/application relationship
  tree (including labelled trust relations, collapse and pan, with the Junctura
  root scrolled to the centre on open) with no sample data and no invented
  organisation links.

- **Tenant directory APIs:** `GET /v1/directory/principals` lists the caller
  tenant's enrolled management principals (subject, issuer, management client,
  permissions, enabled) and `GET /v1/directory/organizations` returns the real
  tenant/application tree with current trust relations labelled by the published
  capability title. Both require `audit.read`, are read-only and `no-store`, and
  use the private `junctura_directory_api` database role added by migration 022;
  neither calls the Keycloak admin API or returns secrets. `GET /v1/identity`
  also exposes the caller's own safe `preferred_username` as
  `preferredUsername` for display.

- **Principal profiles:** migration 023 adds nullable `display_name`,
  `organization`, `job_title` and `kind` (`admin` or `application`) columns to
  `app_private.principals` and replaces `core.directory_principals(jsonb)` so
  `GET /v1/directory/principals` returns `displayName`, `organization`,
  `jobTitle` and `kind` (each `null` when unset). The local `npm run seed:health`
  fills three administrator profiles and two application profiles idempotently.
  It also seeds real workflow requests, a small approval queue and subject
  consents through the HTTP API; capability execution remains opt-in.

- **Traffic metrics for the operator overview:** `GET /v1/metrics/traffic` returns
  chronological one-minute buckets for the last `minutes` (default 60, max 1440) with
  requests, 4xx/5xx errors, average and maximum latency, plus totals; `GET
  /v1/metrics/requests` returns the newest observed requests (default 20, max 100).
  Counters are real, in-memory observations recorded as responses finish, per Core
  process, with no database or migration, and reset on restart. The request ring keeps
  only method, normalized path (no query, fragment, tokens or identifiers), status and
  duration. Both routes require `audit.read`, are `no-store`, reject non-GET with `405`
  and malformed parameters with `400`.

- **Console password sign-in:** the login page is now a single form with username and
  password fields, prefilled from the Git-ignored `/login-hints.json` when present, plus
  a compact account picker when the file lists several accounts. SSO remains a secondary
  action. The `junctura-console` Keycloak client enables the password grant for internal
  environments only; production realms should disable `directAccessGrantsEnabled`.

- **Health context seed:** `npm run seed:health` enrolls or reuses the five Layer-2
  health applications, publishes their example capabilities, and now creates the
  five provider→consumer trust relationships (referral summary, prescription
  verification, claim verification, pre-visit summary, vaccination history)
  through the real propose/approve/activate Trust API with separate owner and
  approver identities. It then writes deterministic, entirely fictional
  `benh-nhan`, `chuyen-tuyen`, `don-thuoc` records and referral objects through
  the real v2 API. Idempotent, no direct database data writes, no secrets in
  output.

- **Audit event listing:** `GET /v1/audit-events` returns the caller tenant's protected audit
  events, newest first, filtered by `since`/`until` with `limit` (max 100) and an opaque
  `cursor`. Management principals with `audit.read` only; read-only, `no-store`, backed by
  the existing `core.audit_query` (no migration). Documented as `listAuditEvents`.

- **SDK on npm:** `sdk/node` is published as `@junctura/server-client` (Apache-2.0,
  with npm provenance) by the `Publish SDK` workflow on a `sdk-vX.Y.Z` tag, so Layer 2
  applications install it instead of copying it. New `redeemTicket()` and
  `inputDigest()` for capability providers; `ExecutionContext` types now include
  `emergency` and `justification`.
- **Internal capability providers:** C4A/C4B can call Layer 2 services that run next
  to the platform. Exact `https://*.internal` origins only, private (RFC 1918 / ULA)
  addresses only, TLS verified solely against the operator's provider CA; all other
  invocation controls unchanged. Configured with `C4A_INTERNAL_PROVIDER_ORIGINS`,
  `C4B_INTERNAL_PROVIDER_ORIGINS` and `PROVIDER_CA_FILE`, plus `compose.providers.yaml`.
- `npm run provider:pki -- <name>...`: dependency-free local provider CA and server
  certificates (ECDSA P-256) in the Git-ignored `.junctura/pki`.
- TLS verification failures such as an unknown issuer are reported as `tls_error`.
- **Purpose-bound calls and "who accessed my data"** (migration 020): C4A requests may
  carry `context: { purpose, dataSubject }`, bound into the idempotent request, sealed
  into the audit chain (`execution.subject_accessed`, subject only as SHA-256) and passed
  to the provider on redemption. `GET /v1/me/data-access` lists, for the signed-in person
  only, the calls that named them. The SDK `execute()` accepts the context.
- **Data subject consent and emergency access** (migration 021): calls that name a
  person need that person's active consent for the consumer, capability and purpose,
  re-checked at ticket redemption; people grant, list and revoke consents at
  `/v1/me/consents`. Emergency (break-glass) calls with a justification skip consent,
  are sealed (`execution.emergency_access`), shown to the person and reviewed by
  `trust.approve` administrators at `/v1/emergency-accesses` (at most five pending per
  consumer).

## 0.1.0 — Layer 1 release (2026-11-04)

First public release of the Junctura DX-OS Layer 1 platform for OLP'26: a headless
core that lets independent applications share data and capabilities with explicit,
expiring, revocable and audited permission.

### Platform
- Five headless Foundation services behind one Nginx gateway: Keycloak SSO,
  PostgreSQL/PostgREST with row-level security, SeaweedFS with ClamAV ingress
  scanning, Flowable workflows and OpenBao secrets.
- Capability Services: application registration with independent approval, expiring
  resource shares, C1 Registry, C2 cross-app trust, C3 compatibility resolver,
  opt-in C4A invocation and C4B composition, and protected audit.
- **Tamper-evident audit** (migration 018): per-tenant SHA-256 hash chain over the
  protected audit log and `POST /v1/audit-events/verify` (requires `audit.read`).
  Detects modified, deleted, reordered and truncated sealed events; never seals over
  a broken chain.
- **Trust graph** (migration 019): read-only `GET /v1/trust/graph` returns the tenant's
  applications and direct grants with effective state and expiry (administrators see
  the tenant, writers only providers they own).
- Gateway JSON access log with request IDs (paths only, no query strings or headers).

### Console
- **Capability sharing** screen with an interactive trust graph: state filters,
  expiring-soon hints and one-click revocation with a required reason.
- **Verify integrity** card on the Security screen for the audit hash chain.
- Capability screens now reflect the implemented C1–C4B modules instead of the old
  "planned" roadmap; Console, SDK and platform share version 0.1.0.

### Operations and developer experience
- `npm run app:enroll -- <name>`: one-command local enrollment of a Layer-2 backend
  application with separated demo owner/approver and an ignored per-app env file.
- `npm run backup` / `npm run restore`: checksummed backups of the identity, data and
  workflow databases and the object volume; restore verifies, takes a safety backup,
  recreates databases with original ACLs/RLS and restarts the stack.
- Local demos through the real Gateway: `npm run trust:demo` (four sample apps, three
  published capabilities, active, expiring, pending and revoked grants; `-- token`
  prints an approver token for the Console) and `npm run audit:demo` (verify, tamper,
  restore). Shared demo identity helpers live in `scripts/lib/demo-stack.mjs`.
- Packaging accepts final semantic versions and writes a reproducible `.tar.gz` with
  its own SHA-256 sidecar; `release:verify` checks both. GitHub Release steps documented.
- Issue templates for bugs and tasks.
- Every tracked file that can hold a comment now carries an inline SPDX header
  (Markdown, HTML, SVG, TypeScript config, ignore files); `npm run check` enforces it and
  REUSE.toml covers only comment-hostile files. README explains the license and its terms.

### Project
- **Renamed from Rosetta to Junctura DX-OS** (Latin for "joint") before the first
  release, everywhere: code, SDK (`createJuncturaClient`), settings (`JUNCTURA_*`),
  database names and roles (`junctura_*`), Keycloak realm `junctura`, capability URNs
  (`urn:junctura:`), Compose project `junctura`, Console branding and J monogram logo.
  Pre-release local installations are recreated on the next `npm run local:up`
  (new Compose project and volumes; old `rosetta` volumes are left untouched).
  Migration checksums, contract digests and fixtures were regenerated for the new names.
- Vietnamese product README with architecture, security model, quick start and API
  overview; the full English reference is `docs/README_EN.md`, and
  `docs/OLP_REQUIREMENTS.md` maps the contest requirements.
- Internal engineering notes renamed to `ENGINEERING_HISTORY.md` and
  `IMPLEMENTATION_BACKLOG.md`.

### Known issues
- Upstream container images carry unresolved advisories recorded in
  [docs/SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md).
- Loopback-only local installation; production deployment, TLS termination and HA are
  out of scope for this release. Human delegation is not implemented.

## 0.1.0-rc.1 — local candidate preparation (2026-11-02)

- Preserve the implemented five Foundation services and opt-in bounded C1–C4B.
- Reject missing historical migration files and duplicate versions before applying SQL;
  preserve migration bytes 001–017 and existing checksum/lock/drift controls.
- Check side-effect module imports and close workers on listener startup errors.
- Upgrade development-only Vitest to 4.1.12 after Node/Vite compatibility assessment.
- Generate grouped local configuration, provide doctor and start/stop/status commands,
  and require configured Foundation readiness in the host healthcheck.
- Add a dependency-free server-side Node ESM client and executable synthetic example.
- Improve operator/developer onboarding and Console links; preserve upstream UI notices.
- Prepare allowlisted source archives, exact source manifests, checksums and release guides.
- Record dependency/container scan findings honestly; production and final publication
  remain deferred. See docs/SECURITY_REVIEW.md and implementation status for open gates.

Earlier implementation history and exact verification checkpoints remain in
[the engineering history](docs/architecture/ENGINEERING_HISTORY.md) and Git.
