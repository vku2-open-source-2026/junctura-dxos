<!--
SPDX-FileCopyrightText: 2026 Junctura Contributors
SPDX-License-Identifier: Apache-2.0
-->

# Console glossary (Vietnamese / English)

Use one name per concept in the Console text (`console/src/locales/vi.ts` and
`en.ts`). Write short sentences, one idea each. Keep technical names such as
`tenant_id`, `GET /v1/identity` or HTTP codes only in the developer areas (API
reference, security details), never as the only explanation of what happened.

| Concept | Vietnamese | English | One-line meaning |
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
| workflow | quy trình | workflow | Steps done in order by people in different units. |

Rules of thumb: explain a term the first time it appears on a screen; a
Vietnamese text and its English text must mean the same; an error message says
what happened and what to do next.
