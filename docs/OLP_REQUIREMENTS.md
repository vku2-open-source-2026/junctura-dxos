<!-- SPDX-FileCopyrightText: 2026 Junctura Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# OLP 2026 requirements

Competition requirements, current Junctura coverage and submission checklist.

## Đối chiếu nhanh (tiếng Việt)

| Yêu cầu của đề | Junctura đáp ứng bằng |
| --- | --- |
| Định danh, đăng nhập một lần (SSO) | Keycloak (OIDC, PKCE), vai trò `core-reader` / `core-writer` |
| Cổng API (API Gateway) | Nginx: một cửa duy nhất, kiểm tra token qua `auth_request`, giới hạn tần suất |
| Quản trị dữ liệu có cấu trúc | PostgreSQL + PostgREST, Row-Level Security, migration có checksum |
| Quản trị dữ liệu phi cấu trúc | SeaweedFS; tệp vào vùng cách ly, ClamAV quét sạch rồi mới công bố |
| Động cơ luồng công việc | Flowable REST (BPMN), idempotency key chống chạy trùng |
| Headless, không giao diện người dùng | Core chỉ cung cấp API; Console là công cụ quản trị tách riêng |
| Zero-Trust, an toàn thông tin | Xác thực tại cổng, cô lập tenant/ứng dụng, OpenBao, audit được bảo vệ |
| Sao lưu và khôi phục | Kiểm thử `pg_dump`/`pg_restore` cô lập, kiểm tra lại RLS và audit |
| Ít nhất một ứng dụng Tầng 2 trong H-P-D-I | [junctura-workspace](https://github.com/vku2-open-source-2026/junctura-workspace) (repo riêng): không gian làm việc dùng chung, trung lập ngành, có giao diện người dùng cuối, thư viện `@junctura/ui`; giao diện end-to-end đang dựng. Các gói ngành và ứng dụng ở repo riêng |
| Tầng trên đổi nghiệp vụ không ảnh hưởng tầng nền | Lõi trung lập miền: quy trình nghiệp vụ do ứng dụng cấp khi triển khai, Console không ghi cứng tên nghiệp vụ, `npm run check:neutral` chặn từ vựng nghiệp vụ trong CI |

## Official references

- [Problem statement](https://vfossa.vn/tin-tuc/de-thi-phan-mem-nguon-mo-olp-2026-798.html): minimum capabilities (§3), technical principles (§4), submission/demo (§§5–6).
- [Rules and scoring](https://vfossa.vn/tin-tuc/the-le-olp-phan-mem-nguon-mo-nam-2026-760.html): participation, schedule and Parts I–II.

Verify the latest organizer announcements before submission. The references, not this summary, are authoritative.

## Product scope

- Layer 1: reusable, **headless** PaaS Core. Minimum capabilities: (1) Identity/SSO, (2) API Gateway, (3) structured data management, (4) unstructured data management, (5) workflow engine.
- Layer 2: at least **one functional GUI application** in H/P/D/I that uses the Core.
- Open-core means independently reusable services, not simply a single application's backend split into folders.
- Technology examples in the problem are **references, not required brands**.

Layer 2 is `junctura-workspace`, the shared workspace with an end-user GUI and `@junctura/ui`. Sector packs and applications live in separate repositories. Layer 3 apps use Layer 2 APIs and a limited part of Layer 1 with their own identity; see [TIER_MODEL.md](TIER_MODEL.md). Applications are migrating their data to Layer 1. When complete, Layer 2 and Layer 3 applications must store business state through the Core API. The end-to-end GUI experience is being completed for the submission round; the operator Console does not satisfy Layer 2.

See [architecture](ARCHITECTURE.md), [Core API](CORE_API.md), [capabilities](CAPABILITIES.md) and [Console](CONSOLE.md).

## Technical principles

Problem §4's four principles are mapped alongside authorization, secrets and data-management boundaries below.

| Principle | Current Junctura mapping | Limit / out of scope |
| --- | --- | --- |
| Governance / governed data flows | Keycloak, Core authorizer, PostgreSQL RLS, application enrollment, resource shares, capability grants and execution/audit history | No general data-lineage or report-quality automation. |
| Zero trust | Live token checks; tenant/app identity from verified tokens; private provider networks; fail-closed readiness | Local Compose controls; public TLS/WAF and device posture are not established. |
| CI / GitOps | GitHub Actions checks source, licenses, packaging, containers and integrations on `main` pushes and pull requests | No GitOps desired-state reconciliation or automatic disaster recovery. |
| Data lifecycle / speed separation | Separate providers, versioned object pointers, tombstones, workflow history and isolated SQL restore tests | No OLTP-to-historical analytical flow or automatic object reclamation; coordinated full-store recovery remains unproven. |
| Malware scanning / quarantine | ClamAV on the internal scanner network; object uploads follow quarantine → scan → publish; scanner failures deny publication | Object ingress only; quarantine cleanup is best-effort. |
| Secrets | OpenBao KV and Compose bootstrap credentials kept outside Git | No production auto-unseal or HA. |
| IT/OT convergence | IT/backend PaaS for independent applications | OT/ICS gateways, sensor integration and digital twins are outside current scope. |
| Lakehouse | Structured JSON records and object bytes behind authorized APIs | No lakehouse, analytical catalog or query engine is implemented. |

Object scanning, secrets and recovery procedures: [operations](OPERATIONS.md). Authorization and protected audit: [security](SECURITY.md).

## Source openness and submission

- Publish project source in an accessible Internet repository under an OSI-approved license, with compatible rights to distributed components.
- Maintain versioned source releases, reproducible source-build instructions, documented dependencies, [README](../README.md), [change history](../CHANGELOG.md), and public issue tracking; see [setup](GETTING_STARTED.md) and [development](DEVELOPING.md).
- Junctura uses Apache-2.0, `LICENSE`, `NOTICE` and per-file SPDX/REUSE metadata; full bundled-asset license review remains a release obligation.
- Submit team/member, lecturer and source-repository details plus the rights declaration by email, as specified in problem §§5–6.
- Participation: ≤3 members per team plus one supervisor; ≤2 teams per institution, registered through the institution.

Scoring: **50 points FOSS/project practices (Part I) + 50 points product quality (Part II)**.

**Note:** Rules part I (50 points) deducts for: no web/open VCS use; missing per-file license, conflicting licenses, missing license notice or full text; no versioned release or a closed archive format; missing build instructions, manual edits in source, closed or self-made build tools, location-bound builds; bundled or modified dependencies; missing bug tracker, changelog or README. Re-check each item against the official rules before the final release.

The rules list ZIP among penalized archive examples; this is a scoring instruction, not a technical classification of ZIP. Junctura ships **tar.gz + SHA-256**; see [release publishing](RELEASE.md#publishing-a-github-release).

## Schedule

- Submission: **2026-12-06 17:00 Vietnam time**, by email (problem §§5–6).
- Source review: **2026-12-07 to 2026-12-09** (rules).
- Final demonstration: **2026-12-10**; awards: **2026-12-11** (rules).
- Prepare a **15-minute presentation with a runnable demo** (problem §6).

## Pre-submission review

- [x] Confirm official rules, submission deadline, source review and final demo schedule.
- [x] Public repository, license and third-party notices in place.
- [x] A versioned release exists (Layer 1: `v0.1.0`, tar.gz with SHA-256; see [RELEASE](RELEASE.md#publishing-a-github-release)). Publish the next release before 2026-12-06.
- [x] Clone/build/run on a clean environment without editing source to configure it (CI builds and starts the stack on fresh `main`/PR runners; configuration lives in `.env`).
- [x] Only open-source tools are required to build and run (Docker Engine, Docker Compose, Node.js).
- [x] Required five Core capabilities work together.
- [x] Layer 1 is domain-neutral and the Console decides platform access only (`npm run check:neutral`).
- [ ] Layer-2 workspace GUI uses Core in an end-to-end scenario.
- [x] README, setup, architecture, dependency list, changelog, and issue tracker are usable.

## Remaining risks

- Complete a real Core-backed Layer-2 end-to-end GUI demo in the separate application repositories.
- Publish the next release before **2026-12-06**, with README download links matching its version and checksums.
- Complete the license/third-party inventory for all bundled assets and distributed artifacts; header checks alone do not establish redistribution rights.
- Prove coordinated full-store disaster recovery. Backup/restore tooling covers identity/data/workflow databases and object storage, but the tested SQL restore boundary does not prove cross-store consistency; OpenBao state and credentials require separate preservation.
