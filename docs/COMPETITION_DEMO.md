<!-- SPDX-FileCopyrightText: 2026 Junctura Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Competition demo server

This page reproduces the full local demo on a single public server so judges can
open the Console, sign in with a prefilled read-only account and browse the
seeded health scenario. It is a **demo deployment only**; it is not the production
hosting model and it intentionally publishes the credentials of that one
read-only account.

## What gets recreated

Local data lives in Docker volumes and in Keycloak, not in Git. A fresh server
therefore needs the same scripts, not a database copy:

| Local artifact | Recreated by |
| --- | --- |
| `admin1`, `admin2`, `admin3` and read-only `viewer` Keycloak users | `npm run demo:provision` |
| Console permissions in `app_private.principals` | `npm run demo:provision` |
| `console/public/login-hints.json` (Git-ignored, `viewer` only) | `npm run demo:provision` |
| `.junctura/demo-accounts.json` (Git-ignored, mode `0600`, every demo password) | `npm run demo:provision` |
| Health applications, records, files, trust, workflows, consents | `npm run seed:health` |

`npm run demo:seed` runs all of them in order. The generated hints file is
written with mode `0644` so the packaged Nginx container can serve it.

## Fresh server

Requirements: Node 24, Docker with Compose, a domain and an HTTPS reverse proxy.
Run every command from the repository root on the server host.

```sh
git clone https://github.com/vku2-open-source-2026/junctura-dxos.git
cd junctura-dxos
npm run setup
```

Edit `.env` before the first start:

```dotenv
PUBLIC_URL=https://demo.example
PORT=8080
CONSOLE_PORT=3000
```

`PUBLIC_URL` must be the public HTTPS origin with no trailing slash and no
`/identity` suffix. Keycloak derives its issuer from it. Changing it after the
first import does not rewrite existing users, so set it before `local:up` on a
fresh stack.

```sh
npm run local:up          # build and start Core + Console
npm run demo:seed         # administrators, principals, hints, health data
npm run demo:console      # rebuild Console so the hints file is in the image
```

Open `https://demo.example/`. The login form is prefilled from
`/login-hints.json`; the same file is readable by anyone who visits the demo, by
design. It contains only `viewer`, which holds the `core-reader` role and the
`audit.read` permission: it can open every page, and Core rejects every approval,
revocation, registration or other write it attempts. The administrator passwords
are written to `.junctura/demo-accounts.json` on the host and are never served.
Sign in as `admin1`–`admin3` by typing a password from that file.

To verify the static hints and Console health:

```sh
curl -fsS https://demo.example/healthz
curl -fsS -H 'Accept: application/json' https://demo.example/login-hints.json
```

## Reverse proxy routes

The Console container proxies `/api` to the Gateway, but it deliberately does not
proxy Keycloak. The public reverse proxy must route `/identity/` to the Gateway
and everything else to the Console:

```nginx
server {
    listen 443 ssl;
    server_name demo.example;

    # Keep the Keycloak administration surface private.
    location ^~ /identity/admin/          { return 404; }
    location ^~ /identity/realms/master/  { return 404; }

    location /identity/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

`npm run demo:provision` talks to Keycloak through loopback
(`--admin-base http://127.0.0.1:8080` by default), so blocking the two admin
paths above does not break provisioning. If the reverse proxy is another
container or runs on another host, pass `--admin-base` explicitly.

The password form works with the generated hints. SSO PKCE redirect URIs in
`infra/keycloak/realm.json` are loopback-only; adapting them for the public
domain is a separate decision and is not required for the prefilled login flow.

## Update, rotate and reset

Re-running the seed is idempotent and does not duplicate health records:

```sh
npm run demo:seed
```

Rotate every demo password, then rebuild the Console so the new hints are
shipped:

```sh
npm run demo:provision -- --reset-passwords
npm run demo:console
```

To return to a clean demo state, remove the demo volumes and start again. This is
destructive and deletes every database and object; keep `.env`:

```sh
docker compose --profile console down -v
npm run local:up
npm run demo:seed
npm run demo:console
```

## Security checklist

- Only the read-only `viewer` is published. `admin1`–`admin3` hold the full
  local administrator permission set, so keep `.junctura/demo-accounts.json`
  private and share those passwords out of band.
- An administrator password that was ever served in `/login-hints.json` is
  treated as disclosed: the first `demo:provision` after upgrading replaces it.
- `--public-admins` publishes the administrators again. Use it on a loopback-only
  development machine, never on a public server.
- Do not commit `console/public/login-hints.json` or `.junctura/`; both are
  already Git-ignored.
- Keep HTTPS enabled. The password grant sends the password on every login.
- Block `/identity/admin/` and `/identity/realms/master/` at the public proxy as
  shown above. Rotate `KEYCLOAK_ADMIN_PASSWORD` and disable the
  `junctura-console` direct-access grant after the event.
- The Console keeps bearer tokens in tab memory only; reloading signs the
  operator out.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Login page has no prefilled account | Rebuild the Console after `demo:seed`; request `/login-hints.json` with `Accept: application/json`. |
| `401`/`login_failed` on password login | Reverse proxy must route `/identity/` to the Gateway; `PUBLIC_URL` must match the public origin. |
| `missing` in the Users page | Run `npm run demo:provision`; it upserts the four principals for the current issuer. |
| Empty data pages | Run `npm run seed:health` with the stack running; the script is idempotent. |
| Wrong issuer after changing `PUBLIC_URL` | Recreate the volumes, then run `demo:seed` again; existing principal rows are bound to the old issuer. |
