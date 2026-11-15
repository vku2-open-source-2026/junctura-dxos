<!-- SPDX-FileCopyrightText: 2026 Junctura Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# OLP PMNM 2026 — Competition Compliance

The [consolidated requirement matrix](architecture/OLP_REQUIREMENT_TRACEABILITY.md)
records the official pages read on 2026-10-26, baseline evidence, broader service
groups, four technical principles and unresolved submission risks. This file
remains the quick submission checklist; the organizer's pages remain authoritative.

## Đối chiếu nhanh (tiếng Việt)

| Yêu cầu của đề | Junctura đáp ứng bằng |
| --- | --- |
| Định danh, đăng nhập một lần (SSO) | Keycloak (OIDC, PKCE), vai trò `core-reader` / `core-writer` |
| Cổng API (API Gateway) | Nginx: một cửa duy nhất, kiểm tra token qua `auth_request`, giới hạn tần suất |
| Quản trị dữ liệu có cấu trúc | PostgreSQL + PostgREST, Row-Level Security, migration có checksum |
| Quản trị dữ liệu phi cấu trúc | SeaweedFS, ClamAV quét mã độc trước khi nhận tệp |
| Động cơ luồng công việc | Flowable REST (BPMN), idempotency key chống chạy trùng |
| Headless, không giao diện người dùng | Core chỉ cung cấp API; Console là công cụ quản trị tách riêng |
| Zero-Trust, an toàn thông tin | Xác thực tại cổng, cô lập tenant/ứng dụng, OpenBao, audit được bảo vệ |
| Sao lưu và khôi phục | Kiểm thử `pg_dump`/`pg_restore` cô lập, kiểm tra lại RLS và audit |
| Ít nhất một ứng dụng Tầng 2 trong H-P-D-I | [junctura-workspace](https://github.com/vku2-open-source-2026/junctura-workspace) (repo riêng); ứng dụng nghiệp vụ Tầng 3 ở các repo Clinic, Pharmacy, Hospital, Insurance |
| Tầng trên đổi nghiệp vụ không ảnh hưởng tầng nền | Lõi trung lập miền: quy trình nghiệp vụ do ứng dụng cấp khi triển khai, Console không ghi cứng tên nghiệp vụ, `npm run check:neutral` chặn từ vựng nghiệp vụ trong CI |

## Official references

- Problem statement: https://vfossa.vn/tin-tuc/de-thi-phan-mem-nguon-mo-olp-2026-798.html
- Rules/scoring: https://vfossa.vn/tin-tuc/the-le-olp-phan-mem-nguon-mo-nam-2026-760.html

Verify the latest organizer announcements before submission. The references, not this summary, are authoritative.

## Product scope

- Layer 1: reusable, **headless** PaaS Core. Minimum capabilities: (1) Identity/SSO, (2) API Gateway, (3) structured data management, (4) unstructured data management, (5) workflow engine.
- Layer 2: at least **one functional GUI application** in H/P/D/I that uses the Core.
- Open-core means independently reusable services, not simply a single application's backend split into folders.
- Technology examples in the problem are **references, not required brands**.

## Source openness and submission

- Publish project source in an accessible Internet repository under an OSI-approved license, with compatible rights to distributed components.
- Maintain versioned source releases, reproducible source-build instructions, documented dependencies, README, change history, and issue tracking.
- The official problem's submission section gives **2026-12-06 17:00 Vietnam time**; verify later organizer notices before submitting.
- The official rules split scoring into 50 points for FOSS/project practices and 50 points for product quality. Review the detailed rows, including the archive-format clarification recorded in the matrix.

## Pre-submission review

- [x] Confirm updated official rules/deadline (re-read 2026-11-15: submission 2026-12-06 17:00, source review 2026-12-07 to 12-09, final demo 2026-12-10).
- [x] Public repository, license and third-party notices in place.
- [x] A versioned release exists (Layer 1: `v0.1.0`, tar.gz with checksum; see [RELEASE](RELEASE.md#publishing-a-github-release)). Publish the next release before 2026-12-06.
- [x] Clone/build/run on a clean environment without editing source to configure it (CI builds and starts the full stack on a fresh runner for every push; configuration lives in `.env`).
- [x] Only open-source tools are required to build and run (Docker Engine, Docker Compose, Node.js).
- [x] Required five Core capabilities work together.
- [x] Layer 1 is domain-neutral and the Console decides platform access only (`npm run check:neutral`).
- [ ] Layer 2 GUI uses Core in an end-to-end scenario.
- [x] README, setup, architecture, dependency list, changelog, and issue tracker are usable.

**Note:** Rules part I (50 points) deducts for: no web/open VCS use; missing per-file license, conflicting licenses, missing license notice or full text; no versioned release or a closed archive format; missing build instructions, manual edits in source, closed or self-made build tools, location-bound builds; bundled or modified dependencies; missing bug tracker, changelog or README. Re-check each item against the official rules before the final release.
