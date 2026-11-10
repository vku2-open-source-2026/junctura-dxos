<!-- SPDX-FileCopyrightText: 2026 Junctura Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Removed from Console navigation until an API exists

The Console no longer offers a feature here while the backend contract is
missing. Restore the screen only after the API ships with the documented
shape and authorization rules.

| Removed screen | Why it was removed | Suggested read-only API |
| --- | --- | --- |
| Bí mật / Secrets | `GET /v2/secrets/{name}` needs a caller-supplied name and returns only that secret's version metadata. There is no read-only listing, no per-application grouping and no count, so administrators cannot browse secrets without guessing names or being offered create/rotate/delete actions. | `GET /v2/secrets?application={appId}` returning only `{application, count, names:[{name, version}]}` for a verified management principal with `audit.read`; no values, no write routes in Console. |

Rules for a future screen:

- Show only key names, version and count grouped by application.
- Never return or render secret values.
- Do not add create, rotate or delete controls for administrators.
- Keep the page absent from the sidebar and page tabs until the API exists.
