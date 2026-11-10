<!--
SPDX-FileCopyrightText: 2026 Junctura Contributors
SPDX-License-Identifier: Apache-2.0
-->

# Junctura Console — Layer-1 Operational Control Plane

> Audit qualification, 2026-10-26 at `3bd6a20` on main: IMPLEMENTED management UI,
> PARTIALLY VERIFIED. Read the [source-based findings](architecture/LAYER1_CORE_CATALOG.md#console-evidence-and-contradictions)
> before interpreting the screen inventory as live functionality. There is no
> Console PKCE implementation, hosting API or public protected audit viewer.
> S0 keeps bearer tokens in tab memory only, removes mock identity substitution
> in LIVE, and disables mock-only v2 writes in LIVE. These remain UI safeguards,
> not authentication or authorization guarantees. S0B packages the built assets
> behind a pinned, non-root Nginx container with a narrow Gateway allowlist; it
> does not add hosting or login APIs.

**Junctura Console** is the official operational control center for the **Junctura DX-OS** Layer-1 headless PaaS platform.

*Tagline:* **One platform. Many applications. Connected capabilities.**

> **Architectural Boundary Notice:**
> The Admin Console is a **Layer-1 operational control plane**, designed for platform operators to monitor infrastructure health, govern application registration and inspect foundation contracts. It is **not** a Layer-2 business application and does **not** replace the competition's mandatory Layer-2 demonstration application. The five foundational Cores remain completely headless and operational without this UI.

---

## 1. Visual Identity & Design System

The Junctura Console adheres to a restrained, premium SaaS infrastructure design system inspired by Linear, Stripe Dashboard, and Vercel:

- **Original Brandmark**: A custom geometric stone emblem with three layered, translating facets meeting at a central nexus, symbolizing Layer-1 Core, Layer-2 Applications, and Connected Capabilities.
- **Brand Palette**:
  - **Deep Stone Ink** (`#172F3D`): Primary text and dark structures.
  - **Junctura Blue** (`#176B80`): Primary interactive brand color.
  - **Mediterranean Teal** (`#18877A`): Integration health, success, and active status.
  - **Warm Sandstone** (`#C58B62`): Heritage-inspired accent for governance and proposals.
  - **Soft Limestone** (`#F0F2EE`): Subtle surface fills and card dividers.
  - **App Background** (`#F7F8F6` light / `#0B161E` dark): High-contrast, eye-friendly layout.
- **Typography**: Inter for UI and section hierarchy; JetBrains Mono for technical identifiers, UUIDs, hashes, and API endpoints.
- **Bilingual Localization**: Native Vietnamese as default interface language with full, complete English translation (100% dictionary coverage, no mixed strings).
- **Accessibility**: Source includes focus/ARIA/reduced-motion patterns. Complete WCAG 2.2 AA conformance is UNVERIFIED in the architecture audit; component tests are not an accessibility certification.

---

## 2. Navigation & Screen Architecture

The unified application shell contains a persistent, collapsible sidebar, top navigation with breadcrumbs, tenant context badge, mode toggle, language switcher, and theme toggle:

```
Junctura Console
├── Tổng quan          — Overview metrics (60 minutes), traffic, request log
├── Việc cần duyệt    — Two-person approval queue, with pending count
├── Ứng dụng           — Applications and approvals
├── Năng lực           — Capabilities, connection map and grants
├── Người dùng         — Tenant directory principals (audit.read)
├── Tổ chức            — Tenant/application relationship tree (audit.read)
├── Nhật ký kiểm toán  — Protected audit events and chain verification
├── Tài liệu API       — Documentation and generated API reference
└── Cài đặt            — Platform settings
```

The sidebar is intentionally flat: one level, exactly seven working screens plus
two footer destinations. The Dữ liệu, Kho tệp, workflows, connection map and
sharing screens remain reachable from the Chức năng panel, the command palette
and the related chips rather than from extra sidebar groups.

The Overview screen has three PageTabs backed by real APIs:

- **Tổng quan** — totals, error split and latency from
  `GET /v1/metrics/traffic?minutes=60`, a hand-written SVG minute chart and the
  six newest requests from `GET /v1/metrics/requests?limit=6`; auto-refreshes
  every 30 seconds.
- **Lưu lượng** — a fixed 60-minute table from
  `GET /v1/metrics/features?minutes=60`, one row per product feature with
  requests, 4xx/5xx errors, average and peak latency, a hand-written SVG
  per-minute sparkline and a proportional comparison bar. Rows are sorted by
  request count and feature names are translated for operators.
- **Nhật ký request** — up to 100 recent requests with status/method filters.
- **Hồ sơ đang xử lý** — running case count from
  `GET /v1/workflows/executions?status=running`; the card opens the workflow
  screen on the Đang chờ filter.

Dữ liệu reads `GET /v1/storage/summary` and shows only aggregates: applications
with records, collection count, total records, and per-application collection
counts with the latest update time and a proportional bar. Selecting a collection
calls `GET /v1/storage/collections?application=<id>` and opens a structure panel
listing field names, the type in Vietnamese (chuỗi, số, đúng-sai, đối tượng,
danh sách, nhiều kiểu, không xác định), a fill-rate bar, record count, last
update and owning application. The page never renders record values or sample
rows and has no create, edit or delete forms; it states that record content
belongs to each application and administrators only see structure and
aggregates.

Kho tệp reads the same storage summary for its totals and the left application
list (file count and storage), then calls
`GET /v1/storage/files?application=<id>&path=<folder>` one directory level at a
time. The main panel has a breadcrumb, folders with file count, size and last
update, and files with the masked name exactly as returned by the API, type,
size, scan status (clean, quarantined or unknown) and last update. Operators can
switch between table and grid views and sort by name, size or date. Names are
never reconstructed into full names, and there is no download, preview, delete or
upload action. The screen is part of the Tệp function card and chips, requires
`audit.read`, and is intentionally absent from the sidebar.

Quy trình is a read-only dashboard backed by `GET /v1/workflows/summary` and
`GET /v1/workflows/executions`. Four cards show installed workflows, waiting,
successful and failed cases. The per-workflow table shows the owning product,
the three counts and a success-rate bar; selecting a row opens a drawer with the
ordered steps and responsible units, never per-case progress. The case table
shows only case ID, workflow, owning product, status, start and end time, with
status filters and pagination. It deliberately omits the current step, assignee,
case content and detailed progress, which belong to each unit's Layer 2/3
application. The screen has no start, complete, approve, cancel or trial
controls; it states that administrators only observe and cases are processed in
the owning application.

Ứng dụng lists applications from `GET /v1/trust/graph` and opens a full
read-only detail page per application. The detail combines the application
record (`GET /v1/applications/{appId}`), published capabilities, sharing
relations from the trust graph, storage totals from `GET /v1/storage/summary`
and, when the caller has `audit.read`, the approving administrator and approval
time from `GET /v1/audit-events`. Identity details (application ID, OAuth client
ID, provider origin, tenant, revision and digest) are collapsed under “Chi tiết
kỹ thuật”. Applications register themselves through the API; the Console has no
registration form. Approve and reject appear only while an application is
pending, and revocation is the only other state action.

Quyền truy cập / Chia sẻ reads `GET /v1/trust/graph` plus `audit.read` events to
present one table of sharing relations grouped by lifecycle: proposed (pending),
effective, rejected, revoked and expired. A grant revoked before it was ever
activated is shown as rejected; one revoked after activation is shown as
revoked. Each row names the provider and consumer, the shared capability, the
proposing application and time, and the administrator decision with time and
reason when available. Administrators can only approve or reject a proposal and
revoke an effective share; reject and revoke require a reason and call the real
`/v1/trust/grants/{id}/activate` or `/revoke` routes. There is no create,
propose, publish or extend action. The screen states the lifecycle:
“Ứng dụng đề xuất → Quản trị viên duyệt → Hiệu lực → (Thu hồi/Hết hạn)”.

Đồng ý and Truy cập khẩn cấp are read-only oversight pages: aggregate cards and
status lists from `GET /v1/me/consents` and `GET /v1/emergency-accesses`, with no
withdraw-consent, emergency-review or citizen-acting controls. Each page states
that administrators only observe and the owning application/unit performs the
action. The Bí mật screen was removed from navigation because no read-only
listing contract exists; see `console/REMOVED-UNTIL-API.md`.

Người dùng reads `GET /v1/directory/principals` and renders a table with the
principal's `displayName` and `jobTitle` (falling back to “Chưa đặt tên” when
unset), `organization`, `kind` (administrator or application) and enabled state.
Search covers name and organisation; separate filters cover organisation and
kind. A “Xem quyền” action opens a drawer that lists the granted permissions in
Vietnamese grouped by area, so the raw permission codes never appear as a table
column. The signed-in operator carries a “Bạn” badge.

Tổ chức reads `GET /v1/directory/organizations` and renders the real
tenant/application tree as a responsive card grid under the Junctura platform
card, without overlapping or clipped regions from 375px through wide desktop.
Unit cards show provided/used capability counts and relation counts. Trust
relations are listed in their own block as “provider → consumer · capability”;
selecting a unit highlights only its relations and opens a detail card beside the
tree on desktop or below it on narrow screens, listing incoming and outgoing
relations by name. Selecting the platform card shows aggregate unit, relation
and capability totals. The screen distinguishes loading, permission, expired
session and generic errors and always offers a retry; neither page invents
organisational links or sample people.

List screens across the Console use empty states that explain what the list is
for, why it is empty and what action makes data appear (for example approval
queue, workflow cases, consents, emergency access, records, files, users and
organisations).

---

## 3. Screen Functionality & Feature Matrix

| Screen | Implemented Live UI Actions | Read-Only Views | Unavailable / Out-of-Scope APIs | Planned Roadmap |
| --- | --- | --- | --- | --- |
| **A. Overview** | Live/Preview mode switch, manual refresh, identity retry, quick action jumps | Process liveness (`/health`), dependency readiness (`/ready`), verified tenant ID and roles (`/v1/identity`); truthful missing/rejected/forbidden/unavailable/timeout states | Host CPU/RAM telemetry (omitted honestly; no fake metrics) | Platform-wide automated recovery |
| **B. Foundation Services** | Detailed inspection drawer for each of the 5 Cores | Provider technology, protocols, port boundaries, aggregate `GET /ready` status (no per-provider metrics) | Direct upstream admin ports (kept private in internal Docker network) | Automated core component failover |
| **C. Applications** | Approve or reject a pending registration and revoke an existing application, each through the real approval/state routes; no Console registration form | Full detail from `GET /v1/applications/{appId}`, trust-graph sharing relations, capabilities, storage totals and approval metadata from `audit.read`; technical identifiers collapsed | Global application directory listing (excluded in v1 to protect tenant isolation); per-application call history (no API) | Dynamic capability grant allocation |
| **C2. Sharing grants** | Approve or reject a pending proposal and revoke an effective share with a mandatory reason; calls `/v1/trust/grants/{id}/activate` and `/revoke` | State table from `GET /v1/trust/graph` (proposed, effective, rejected, revoked, expired), proposing application/time, approving or revoking administrator/time/reason from `audit.read` | Creating, proposing or extending grants; publishing capabilities from the Console | Grant renewal workflow |
| **D. Data & Files** | No admin record/file content mutation; aggregate overviews only | `GET /v1/storage/summary` aggregates for Dữ liệu and Kho tệp (`audit.read`); no record content, file names or object bytes | Per-application record browsing and file upload from the admin console | Per-application data browser with delegated credentials |
| **E. Workflows & Tasks** | None — read-only by design; administrators cannot start, approve, complete or stop a business case | Workflow summary (`GET /v1/workflows/summary`) with owning product, steps, counts and success rate; every tenant case (`GET /v1/workflows/executions`) with status filters, start/end times and pagination | Public BPMN XML upload / script deployment (operator-installed only); per-case progress and assignee (handled in Layer 2/3 applications) | Multi-step user task assignment |
| **F. API Explorer** | Search endpoints, tag filtering, copy cURL, copy TypeScript fetch | Request/response schemas, HTTP status codes, auth requirements for all 44 operations | Interactive API playground with privileged tokens (kept client-side safe) | Capability OpenAPI runtime testing |
| **G. Security** | Browser-generated session activity, labeled as diagnostics; uses the verified LIVE identity only | Architecture/audit guidance | `GET /v1/audit-events` (read-only, `audit.read`) over `core.audit_query(jsonb)`; `POST /v1/audit-events/verify` | Traffic metrics and identity directory contracts |
| **H. Hosting & Capabilities** | Specification file references and architecture comparison; visibly labelled planned | Architectural review of Registry, Resolver, Cross-App Trust, Composition and Junctura Cloud hosting | Active runtime APIs (clearly badged as "Planned / Design-Only") | Full Layer-2 Capability Runtime |
| **I. Getting Started** | Static prerequisites, enrollment link, executable example commands and cleanup guidance; never accepts or displays secrets | Links to product, developer, registration, authorization and API docs | No self-service enrollment or credential provisioning | Hosted onboarding and SDK quickstarts |

---

## 4. Security Architecture

1. **Authentication**: Console signs in through the Keycloak realm using either the PKCE SSO flow or the username/password form, and keeps the access token in tab memory only. Legacy persisted tokens are deleted on startup, and reloading signs the operator out. The `junctura-console` client enables the OAuth 2.0 resource-owner password grant (`directAccessGrantsEnabled`) for internal convenience only; disable it for production realms.
2. **Credential boundary**: Do not enter backend service secrets or credentials intended for application-private v2 calls in a browser. Gateway destinations are restricted to the same origin or loopback hosts; the Console refuses to send `Authorization` to any other origin and removes invalid persisted gateway URLs.
3. **Server enforcement**: Core and PostgreSQL fail closed. In LIVE mode the Console uses only `/v1/identity` for tenant, subject, roles and permissions. Missing, rejected, forbidden, unavailable and timeout identities are shown distinctly; preview identity is never substituted.
4. **Two-Person Rule Confirmation**: Sensitive operations (application activation, suspension, permanent revocation, execution cancellation, share deletion) require explicit confirmation dialogs with accessible focus traps.
5. **Mode Transparency**: Switching PREVIEW → LIVE clears preview applications, approvals, executions, records, shares and session events. LIVE listings contain only data fetched or created in the current session; endpoints without a listing contract show an explicit notice, and mock-only v2 mutations fail instead of appearing successful. Preview is the only mode that displays mock data.
6. **Packaged boundary**: The optional Console image is a multi-stage build with a pinned Node builder and the pinned Nginx runtime. It runs as the non-root `nginx` user with a read-only root filesystem, drops all Linux capabilities and sets `no-new-privileges`. Nginx serves only the built static bundle and proxies a fixed allowlist under `/api` to `gateway:8080` over the Compose `edge` network; it never uses container-local `127.0.0.1` for the Gateway. Unknown API paths return 404, unsupported methods return 405, encoded slash/traversal attempts return 400, and SPA fallback is limited to `Accept: text/html` navigation. Upstream 5xx/timeout responses stay errors and are not replaced with the SPA shell. The proxy forwards the caller's `Authorization` header only to allowed Gateway routes.

---

## 5. Missing Administrative Contracts & Recommendations

During our audit of the Foundation OpenAPI 3.1 specification, we identified the following missing administrative endpoints that would benefit future control plane releases:

1. **Administrative Application Directory (`GET /v1/admin/applications`)**:
   - *Current State:* `GET /v1/applications/{appId}` requires knowing the exact UUID.
   - *Recommendation:* Expose a tenant-scoped administrative listing endpoint restricted strictly to operators with the `admin` or `applications.approve` permission.
2. **Platform Audit Events (`GET /v1/admin/audit-events`)**:
   - *Current State:* Implemented as `GET /v1/audit-events` (paginated, time-filtered, `audit.read`, tenant-scoped). It maps to `core.audit_query(jsonb)` through the private audit role; the function is not exposed directly.
3. **Component Health Diagnostic (`GET /v1/admin/diagnostics`)**:
   - *Current State:* `/ready` returns a binary `ready` or `503 not_ready`.
   - *Recommendation:* Expose granular sub-component latency metrics for Identity, PostgREST, SeaweedFS, and Flowable to privileged operators.

---

## 6. Local Setup & Execution Instructions

### Method A: Local Development Server

From the project root:

```bash
# Install exactly the Console lockfile
npm ci --prefix console

# Run the console dev server with hot reload
npm run console

# Run unit and component tests
npm run console:test

# Type-check and build the production static bundle
npm run console:build

# Verify the committed OpenAPI endpoint inventory is current
npm run console:check:endpoints
```

The development server is available at `http://localhost:3000/`. Its Vite proxy
forwards `/api` to the host Gateway at `http://127.0.0.1:8080`; this is a
development-only convenience and is not used by the packaged image.

### Method B: Packaged Console with Docker Compose

The Console is an optional Compose profile; headless Core operation remains
unchanged. The image is a multi-stage build from the repository root so that
`LICENSE`, `NOTICE` and `THIRD-PARTY.md` are available for the runtime image.

```bash
# Build the image directly (root build context is required)
docker build --file console/Dockerfile --tag junctura-console:local .

# Start standard headless Core (Console does NOT run by default)
docker compose up -d

# Start headless Core PLUS the packaged Console
docker compose --profile console up --build -d
```

The Console is available at `http://127.0.0.1:3000/`. Nginx proxies the Console's
`/api` calls to `http://gateway:8080` over the Compose `edge` network. The host
Gateway port is not used by the container. For a public competition demo with
prefilled administrator accounts, see [COMPETITION_DEMO](COMPETITION_DEMO.md). The runtime is non-root (`nginx`),
read-only, capability-free and uses a small writable `/tmp` tmpfs; no Node/Vite
runtime is shipped.

The proxy allowlist is limited to the routes the Console currently calls:

| Methods | Gateway path | Console use |
| --- | --- | --- |
| GET | `/health`, `/ready` | Overview liveness and readiness |
| GET | `/v1/identity` | LIVE tenant/role identity |
| GET | `/v1/metrics/traffic`, `/v1/metrics/requests` | Overview traffic chart and request log |
| GET | `/v1/metrics/features` | Traffic table grouped by product feature |
| GET | `/v1/directory/principals`, `/v1/directory/organizations` | Users and organisations screens |
| POST | `/v1/applications` | Application proposal |
| GET | `/v1/applications/{appId}` | Application lookup |
| POST | `/v1/applications/{appId}/approve`, `/v1/applications/{appId}/state` | Two-person approval and state transition |
| POST | `/v1/approvals` | Approval challenge creation |
| GET | `/v1/storage/summary` | Dữ liệu and Kho tệp aggregate counts |
| GET | `/v1/storage/collections` | Dữ liệu collection field structure |
| GET | `/v1/storage/files` | Kho tệp one directory level |
| GET | `/v1/workflows/summary` | Read-only workflow dashboard |
| GET | `/v1/workflows/executions` | Every tenant workflow case with status filter |

All other `/api` paths return 404. Unsupported methods return 405. Paths with
encoded slash/backslash/dot segments or duplicate slashes return 400. The proxy
does not expose Keycloak, Flowable, PostgREST, PostgreSQL or SeaweedFS, and it
does not follow an open redirect. SPA fallback is served only for `text/html`
navigation; missing assets and API failures are not masked by `index.html`.
Adding a Console call to a new Gateway route requires updating
`console/nginx/default.conf` and the container contract test.

The image health check is `GET /healthz` on port 3000. If the Gateway is down,
`/api` requests fail with an HTTP error (502/504) instead of a successful SPA
shell. The proxy allows 15 seconds for upstream responses, matching the Console's
own identity timeout behavior. Browser security headers include CSP,
`nosniff`, frame denial, no-referrer and same-origin isolation. HSTS is not
enabled because local deployment is plain HTTP.

Google Fonts stylesheets are loaded from the public network. In an offline
environment the Console uses its system font fallback; no font files are
bundled. There is no service worker or hosted certificate/domain setup in this
slice.

### OpenAPI example generation

`console/scripts/generate-endpoints.mjs` derives the endpoint inventory from the
authoritative `docs/contracts/foundation-api.openapi.json`. The API Explorer uses
that metadata to generate cURL and TypeScript Fetch examples with the operation's
actual method, path/query parameters, request content type, required `If-Match` or
`Idempotency-Key` headers, bearer token placement, binary upload/download behavior
and empty `204` responses. Examples use synthetic UUIDs, placeholder tokens/ETags
and runtime-generated future timestamps; they contain no real credentials.

Run `npm run console:check:endpoints` after changing the OpenAPI spec. CI fails if
the committed inventory is stale or if an example does not match its schema,
content type or required headers.

### Verification and rollback

```bash
# Endpoint inventory and Console checks
npm run console:check:endpoints
npm run console:test
npm run console:build

# Container build, static/SPA, proxy allowlist, credential, error and timeout checks
npm run test:console-container

# Compose schema with the optional profile
docker compose --profile console config --quiet
```

To stop only the Console, run `docker compose --profile console stop console`
or `docker compose --profile console rm -sf console`. Core containers and data
volumes are unaffected. No migrations or Core configuration are changed by this
packaging slice.

---

## 7. Verification Summary

S0 added API and component coverage for token non-persistence, gateway origin
checks, identity failure states, PREVIEW → LIVE state clearing, and LIVE-mode
rejection of mock-only operations. S0B adds deterministic endpoint metadata and
executable request examples, then verifies the packaged Nginx image and proxy
allowlist. GitHub Actions runs the Console suite, build, endpoint freshness check
and container contract test. Full visual/accessibility QA remains out of scope;
[current evidence and CI gaps](architecture/LAYER1_CORE_CATALOG.md) take
precedence when assessing live functionality.

- **Console Vitest Suite**: 27 tests passed (`npm run console:test`) - 8 API client, 13 UI integration and 6 OpenAPI example/inventory tests.
- **Production Build**: Verified with TypeScript and Vite (`npm run console:build`).
- **Packaged Console Contract Test**: `npm run test:console-container` builds from a clean context and verifies non-root/read-only runtime, static assets, SPA fallback, proxy allowlist, bearer/conditional/idempotency forwarding, upstream error propagation and timeout behavior.
- **Core Unit Tests**: 22 unit tests passed (`npm test`).
- **Repository Hygiene & SPDX**: Verified with `npm run check`.
- **OpenAPI Contract Validation**: 44 operations validated with `npm run check:contracts`; the committed Console endpoint inventory must match the spec.
