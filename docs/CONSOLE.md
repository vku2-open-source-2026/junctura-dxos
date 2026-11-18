<!--
SPDX-FileCopyrightText: 2026 Junctura Contributors
SPDX-License-Identifier: Apache-2.0
-->

# Junctura Console — Layer-1 Operator Tool

> The Console is the Core's Layer-1 operator tool (like Supabase Studio): it views platform state and decides **platform access** only (application registration and state, sharing grants; capabilities, consents and emergency accesses are shown read-only, and their decisions use the Core API). It never starts, completes, cancels or approves **business work**, which belongs to Layer-2/3 applications. It is domain-neutral and shows workflow, owner, step and collection names exactly as applications supply them. Core runs fully without the Console.

In the current screens, the decisions an operator can take are application registration (approve/reject/revoke) and sharing grants (approve/reject/revoke); capabilities and emergency accesses are shown read-only (see [Limitations](#limitations)).

The shared design system supports light/dark themes, text sizing and bilingual text: Vietnamese (`vi`) by default, English (`en`) selectable.

## Environment banner

After sign-in, the environment banner shows the verified tenant from `/v1/identity`:
`demo` shows the demo, simulated-data, read-only label; `production` shows the operations
environment label; any other tenant shows its name only. There is no banner without a user.

## Terminology

| Concept | Vietnamese | English | Meaning |
| --- | --- | --- | --- |
| tenant | tổ chức | organization | One organization whose data is kept apart from every other. |
| access token | mã truy cập | access token | A temporary code that proves who is calling. |
| idempotency key | mã chống gửi trùng | retry key | Lets a request be sent again without running twice. |
| capability | năng lực | capability | A function one application lets another application call. |
| consent | đồng ý | consent | A person's permission to use their data for one purpose until a date. |
| grant / permission | quyền | permission | Allows one application to call one capability for a purpose until a date. |
| resource share | chia sẻ dữ liệu | data share | Read-only access to one item, with an expiry date. |
| digest / hash | mã kiểm tra (mã băm) | check code (hash) | Changes if the content changes, so edits are detected. |
| audit log | nhật ký kiểm toán | audit log | A tamper-evident record of who did what. |
| API gateway | cổng API | API gateway | The single entrance every application uses to reach the platform. |
| request | lệnh gọi | request / call | One message an application sends to the platform. |
| backend / provider origin | phần máy chủ của ứng dụng; địa chỉ máy chủ ứng dụng | application server; application server address | The part of an application that runs on a server and can keep secrets. |
| consumer / provider | ứng dụng gọi / ứng dụng cung cấp | calling / providing application | Who uses a capability and who offers it. |
| workflow | quy trình | workflow | A BPMN process an application starts; the platform runs its steps in order. |
| workflow definition | định nghĩa quy trình | workflow definition | The installed description of a workflow's steps. |
| execution | lượt chạy | execution | One run of a workflow, started by an application. |
| application-handled step | bước do ứng dụng xử lý | step handled in an application | A workflow step handled by an application; Console administrators only view its status. |

- Use one name per concept in [vi.ts](../console/src/locales/vi.ts) and [en.ts](../console/src/locales/en.ts); explain a term the first time it appears on a screen. Write short sentences, one idea each.
- Keep technical names such as `tenant_id`, API paths and HTTP codes in developer areas (API reference, security details), never as the only explanation.
- Vietnamese and English must mean the same; errors must say what happened and what to do next.

## Navigation

[modules.ts](../console/src/constants/modules.ts) defines the current sidebar entries in this order; permission checks can hide restricted entries. The footer contains Docs and Settings.

| Screen ID | Vietnamese sidebar label |
| --- | --- |
| `dashboard` | Tổng quan |
| `ecosystem` | Hệ sinh thái |
| `queue` | Việc cần duyệt |
| `apps` | Ứng dụng |
| `caps` | Năng lực |
| `users` | Người dùng |
| `orgs` | Tổ chức |
| `audit` | Nhật ký kiểm toán |
| `docs` (footer) | Tài liệu API |
| `settings` (footer) | Cài đặt |

Other screens (`records`, `files`, `workflows`, `connect-map`, `grants`, `consents`, `emergency`, `traffic`, `requests`) are reached through function panels, the command palette or related chips/tabs. `SIDEBAR_SCREEN_MAP` maps `traffic`/`requests` to `dashboard`, `connect-map`/`grants` to `caps`, and `consents`/`emergency` to `audit`; other mapped screens map to themselves. Data, Files and Workflows have no sidebar entry. The account menu opens Profile.

## Screens and actions

Reads below are `GET` unless stated otherwise; paths are Gateway paths before the default `/api` proxy prefix. Sources: [API client](../console/src/services/apiClient.ts) and [screens](../console/src/components/screens). UI visibility does not grant server authority. Data, Files, Users, Organizations, Audit, Consents and Emergency are marked `audit.read` in the module definitions.

| Screen | Reads | Allowed actions and boundaries |
| --- | --- | --- |
| Overview (`dashboard`) | `/v1/metrics/traffic?minutes=60`, `/v1/metrics/requests?limit=6`; with `audit.read`, `/v1/workflows/executions?status=running&limit=100` | Refresh; open traffic, request log or running executions. Traffic and recent requests refresh every 30 seconds. |
| Ecosystem (`ecosystem`, Hệ sinh thái) | `/v1/applications/stats` with `audit.read` | Read-only totals and an application table: state, last activity, calls in/out, connections, published capabilities, records and files. Rows open the application detail; a link opens the connection map. No mutation controls. |
| Traffic (`traffic`, Lưu lượng) | `/v1/metrics/features?minutes=60` | Refresh; inspect requests, errors and latency by feature, sorted by request count; refreshes every 30 seconds. |
| Requests (`requests`, Nhật ký request) | `/v1/metrics/requests?limit=100` | Refresh; filter by status and method; refreshes every 30 seconds. |
| Approval queue (`queue`) | `/v1/trust/graph`; application/grant lookup when deciding | Approve/reject pending application registrations and sharing grants; reject requires a reason. Own proposals are blocked. The queue refreshes every 15 seconds. |
| Applications (`apps`) | `/v1/trust/graph`, `/v1/applications/{id}`; detail also reads capabilities, storage summary and, with `audit.read`, `/v1/applications/stats`, audit events and directory principals | Search/filter; inspect owner, capabilities, sharing, storage, activity and approval metadata. Approve/reject only pending registrations; revoke an existing application with a reason. Applications register through the API; no registration form. Technical identifiers are collapsed. |
| Capabilities (`caps`) | `/v1/capabilities?limit=100` | Search/filter the catalogue by state; refresh. Read-only; no publication or invocation controls. |
| Connection map (`connect-map`, Sơ đồ kết nối) | `/v1/trust/graph` | Inspect/filter relations; revoke with a reason when permitted (`trust.write` or `trust.approve`). |
| Sharing grants (`grants`, Quyền truy cập) | `/v1/trust/graph`; optional `/v1/audit-events?limit=100` and `/v1/directory/principals` with `audit.read` | Search/filter pending, active, rejected, revoked and expired relations; inspect proposer/decision metadata. Approve/reject pending proposals or revoke effective grants (`trust.approve`); reject/revoke require a reason. No create, propose or extend action. |
| Data (`records`, Dữ liệu) | `/v1/storage/summary`, `/v1/storage/collections?application={id}` | Read-only aggregates and collection structure: field names/types, fill rates, counts and update times. No record values, sample rows or mutation forms. |
| Files (`files`, Tệp) | `/v1/storage/summary`, `/v1/storage/files?application={id}&path={folder}` | Browse one directory level, sort, switch table/grid. Masked names appear exactly as returned, alongside size/type/scan status. No download, preview, upload or delete. |
| Workflows (`workflows`, Quy trình) | `/v1/workflows/summary`, `/v1/workflows/executions?limit=100` | Read-only definition/owner/ordered-step summaries and execution IDs, workflow, owning application, status, start/end times. Filter running/completed/cancelled and paginate locally. No per-case content, assignee or detailed progress; no start, complete, approve or cancel. |
| Users (`users`) | `/v1/directory/principals` | Search name/organization/job title; filter organization/kind; inspect enabled state and grouped translated permissions. Current operator has a “Bạn” badge. No user/role editing. |
| Organizations (`orgs`) | `/v1/directory/organizations` | Select platform/unit cards to inspect capability counts and incoming/outgoing relations. Read-only tenant/application tree; retry permission/session/load errors. |
| Audit (`audit`) | `/v1/audit-events?limit=100` | Search/filter loaded events; export filtered CSV; `POST /v1/audit-events/verify` checks chain integrity. No event editing. |
| Consents (`consents`, Đồng ý của người dùng) | `/v1/me/consents` | Read-only counts and searchable status list for the current subject; no withdrawal or acting for another user. |
| Emergency (`emergency`, Truy cập khẩn cấp) | `/v1/emergency-accesses` | Read-only review counts/list, search and state filters; no emergency-access request or review decision controls. |
| Functions (`platform`) | `/health`, `/ready` | Inspect function descriptions, refresh aggregate service status, open related screens/docs; explanatory simulations do not call business APIs. |
| Docs (`docs`) | Bundled guides and generated API metadata | Search grouped API reference, expand parameters/responses, copy base URL/cURL; no interactive API execution. |
| Settings (`settings`) | Connection test: `/health` | Save an approved Gateway URL locally; choose language, theme and text size. No server configuration writes. |
| Profile (`profile`) | Verified `/v1/identity` session already held in memory | Inspect identity/roles/permissions; change language/theme; sign out. |
| Landing (`welcome`) | Static content | Open sign-in. |
| Sign-in (`login`) | `/login-hints.json`; OIDC endpoints described below, followed by `/v1/identity` | Password sign-in or PKCE SSO; retry identity verification. |

Application decisions use `POST /v1/approvals`, then `POST /v1/applications/{id}/approve` or `/state`; revocation uses `/state`. Sharing approval first reads `GET /v1/trust/grants/{id}`, creates an approval, then calls `POST /v1/trust/grants/{id}/activate`. Sharing rejection/revocation uses `POST /v1/trust/grants/{id}/revoke`. Revision-bound writes send `If-Match`.

The application detail also shows an Activity card from `/v1/applications/stats`, only with
`audit.read`: last activity, calls, connections, published capabilities, records and files.
A missing entry shows a neutral message, and a failed request shows inline error text.
The API client validates the complete statistics response; malformed data produces the
error state with retry in both the Ecosystem page and the Activity card, never zero-filled
numbers.

## Security

- Access tokens stay in tab memory only; startup deletes legacy persisted tokens and reload requires sign-in again. OIDC transaction state/verifier/nonce temporarily use `sessionStorage`, then are cleared; they are not persisted access tokens.
- [oidc.ts](../console/src/services/oidc.ts) and [LoginForm](../console/src/components/screens/login/LoginForm.tsx) implement both authorization-code SSO with S256 PKCE and a username/password form using the password grant. Both use client `junctura-console` at `/identity/realms/junctura/protocol/openid-connect/{auth,token,logout}` on the configured Gateway origin (same origin for relative `/api`). The supplied realm enables both flows. Login can prefill supplied public demo hints; see [Operations](OPERATIONS.md).
- Session identity comes only from `/v1/identity`; missing, rejected, forbidden, unavailable and timeout states remain distinct. UI permissions derive from verified roles; Core and database authorization remain authoritative. Identity requests time out after 6 seconds.
- Gateway URLs are restricted to relative same-origin paths or HTTP(S) loopback origins (`localhost`, `127.0.0.1`, `[::1]`), with no credentials/query/fragment on absolute URLs. Invalid stored URLs are removed; the client refuses to send bearer credentials to an unapproved destination. Keep application backend secrets outside browser code.
- The [Dockerfile](../console/Dockerfile) uses pinned multi-stage Node/Nginx images and runs as non-root `nginx`. [Compose](../compose.yaml) makes its root filesystem read-only, drops all Linux capabilities, sets `no-new-privileges` and supplies a small `/tmp` tmpfs. The runtime serves static assets without Node/Vite.

## Run locally

Use Node.js 24; run from the repository root. Start/configure Core using [Getting started](GETTING_STARTED.md).

```bash
npm ci --prefix console
npm run console                        # Vite development server
npm run console:test                   # unit/component/example checks
npm run console:build                  # TypeScript check and production build
npm run console:check:endpoints        # generated endpoint freshness
npm --prefix console run check:api-reference
npm run test:console-container         # packaged image/proxy contract (Docker required)
docker compose --profile console up --build -d
# Stop only the Console; preserve Core services and volumes:
docker compose --profile console stop console
```

Vite serves `http://localhost:3000/` and proxies `/api` to `http://127.0.0.1:8080`, stripping `/api`; it also proxies `/identity` to that Gateway. The packaged Console binds `http://127.0.0.1:3000/` (`CONSOLE_PORT` overrides the host port) and proxies to `gateway:8080` on the Compose `edge` network. Core can run alone with `docker compose up -d`; Console is an optional profile. Image builds require the repository-root context for license notices.

### Signing in with the packaged Console

The packaged image proxies only `/api/*` to the Gateway and has no `/identity/` location. With the default relative `/api` base, the OIDC endpoints are requested at `/identity/realms/junctura/protocol/openid-connect/{auth,token,logout}` on the Console origin, so the image alone cannot complete sign-in. In Compose, the Gateway ([infra/nginx/default.conf](../infra/nginx/default.conf)) serves `/identity/` on port 8080 and the Console publishes its own port 3000. To sign in through the packaged Console, place one reverse proxy origin in front that routes `/identity/` to the Gateway and all other paths to the Console, as in the public demo configuration in [Operations](OPERATIONS.md). The Vite development server ([vite.config.ts](../console/vite.config.ts)) proxies both `/identity` and `/api` to `http://127.0.0.1:8080`.

## Packaged proxy contract

The table mirrors every API location in [default.conf](../console/nginx/default.conf), with `/api` stripped from forwarded paths. `{id}` means a lowercase UUID; `{executionId}` matches `[A-Za-z0-9:_-]{1,128}`. An allowed route does not imply a Console control: the Console only reads workflows and never performs business workflow writes.

| Gateway path | Allowed methods |
| --- | --- |
| `/health` | GET |
| `/ready` | GET |
| `/v1/identity` | GET |
| `/v1/applications/{id}` | GET |
| `/v1/applications/stats` | GET |
| `/v1/applications/{id}/approve`, `/v1/applications/{id}/state` | POST |
| `/v1/applications` | POST |
| `/v1/approvals` | POST |
| `/v1/audit-events` | GET |
| `/v1/audit-events/verify` | POST |
| `/v1/capabilities` | GET |
| `/v1/me/consents` | GET |
| `/v1/emergency-accesses` | GET |
| `/v1/metrics/traffic` | GET |
| `/v1/metrics/requests` | GET |
| `/v1/metrics/features` | GET |
| `/v1/directory/principals` | GET |
| `/v1/directory/organizations` | GET |
| `/v1/trust/graph` | GET |
| `/v1/trust/grants/{id}` | GET |
| `/v1/trust/grants/{id}/activate`, `/v1/trust/grants/{id}/revoke` | POST |
| `/v1/workflows/definitions` | GET |
| `/v1/workflows/executions` | GET |
| `/v1/workflows/summary` | GET |
| `/v1/storage/summary` | GET |
| `/v1/storage/files` | GET |
| `/v1/storage/collections` | GET |
| `/v1/workflows/executions/{executionId}` | GET |
| `/api` (not forwarded) | None: 404 |
| All other `/api/*` paths (not forwarded) | None: 404 |

- Other `/api` paths return 404; a wrong method on an allowed route returns 405. Encoded slash/backslash/dot, percent, NUL, question/hash characters, literal dot segments or duplicate `//` in the path return 400.
- SPA fallback requires `Accept: text/html`. Missing assets/source maps and API failures never become the SPA shell. Upstream errors remain errors; [proxy.conf](../console/nginx/proxy.conf) sets a 3-second connect timeout and 15-second send/read timeouts, disables upstream retries and redirect rewriting, and forwards caller authorization to allowed routes.
- `/healthz` returns `ok` for the image health check; `/login-hints.json` serves the supplied JSON file or 404, without SPA fallback.
- Headers include `nosniff`, frame denial, `no-referrer`, disabled camera/microphone/geolocation, and same-origin opener/resource policies. CSP defaults to self, restricts scripts to self, permits inline styles and Google Fonts styles/fonts/connections, permits self/data images/fonts, and sets `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`, `form-action 'self'`. The supplied HTTP configuration has no HSTS.
- Adding a Console call to a new Gateway route requires updating [default.conf](../console/nginx/default.conf) and [scripts/check-console-container.mjs](../scripts/check-console-container.mjs).

## OpenAPI examples

[generate-endpoints.mjs](../console/scripts/generate-endpoints.mjs) derives `foundationEndpoints.json` from [foundation-api.openapi.json](contracts/foundation-api.openapi.json). [openapiData.ts](../console/src/constants/openapiData.ts) generates cURL and TypeScript Fetch examples with actual methods, parameters, content types, bearer placement, required `If-Match`/`Idempotency-Key`, binary handling and empty `204` responses. Examples use synthetic identifiers and placeholder credentials; time-sensitive Foundation bodies generate future timestamps.

[generate-api-reference.mjs](../console/scripts/generate-api-reference.mjs) supplements Foundation metadata with response/permission details and the Capability contract. The current reference screen exposes cURL copying. After contract changes, regenerate with `npm --prefix console run generate:endpoints` and `npm --prefix console run generate:api-reference`, then run both freshness checks above; CI checks both outputs, tests examples and builds the Console.

## Limitations

- Lists are bounded: capabilities, audit events and workflow executions load at most 100 entries here. Audit does not follow `nextCursor`; workflow pagination only covers loaded entries, and the Overview running count is capped by its fetched list.
- Function status repeats aggregate `/health` and `/ready`, without per-provider telemetry or host CPU/RAM. There are no application-hosting/deployment controls, user/organization mutation screens, capability publication controls or emergency-review actions. Secrets browsing is absent because no read-only listing contract exists; see [removed screens](../console/REMOVED-UNTIL-API.md).
- API reference examples can cover routes outside the packaged allowlist. Google Fonts requires network access; offline use falls back to system fonts. No service worker, managed TLS/domain setup or complete accessibility certification is supplied.

See [Architecture](ARCHITECTURE.md), [Core API](CORE_API.md), [Security](SECURITY.md) and [Operations](OPERATIONS.md) for related contracts and deployment boundaries.
