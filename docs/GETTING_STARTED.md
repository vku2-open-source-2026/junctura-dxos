<!-- SPDX-FileCopyrightText: 2026 Junctura Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Start Junctura locally

This is the application developer's entry point. You need Git, Node 24 and Docker
Engine with Linux containers (Docker Desktop also works). No server, domain or
public TLS is needed. Windows PowerShell with Docker Desktop (Linux containers) is
exercised by the local release checks; Ubuntu 24.04 is exercised by CI. Other host
platforms are not verified here.

## Install, start, inspect and stop

Run these commands from the repository root in PowerShell or a shell:

```sh
git clone https://github.com/vku2-open-source-2026/junctura-dxos.git
cd junctura-dxos
npm run setup
npm run doctor
npm run local:demo
npm run healthcheck
```

Setup generates independent 256-bit secrets from the committed environment
template. It refuses to overwrite an existing `.env`. Preserve that file and the
database volumes; editing a password does not rotate an existing database account
or Keycloak realm. On Windows, keep the repository on a private user account and
check its filesystem permissions; Unix mode 0600 is not a Windows ACL guarantee.

Before startup, doctor reports available ports and stopped services. After startup,
it reports Gateway and Console readiness. It prints configuration key names, never
their secret values. Optional Python/OpenSSL diagnostics concern integration tests,
not the ordinary installation. C4A/C4B should both report disabled.

`local:demo` runs `setup` only when `.env` is missing, then `local:up` (build,
start, migrations, wait up to 300 seconds), `directory:provision`, `env:provision`, `demo:seed` and
`demo:console`, and prints the Console URL. Provisioning creates the read-only
`demo` account in tenant `demo` and `admin1`–`admin3` plus the read-only judge
`giamkhao` in tenant `production`; passwords are generated at run time, never
printed, and stored in `.junctura/demo-accounts.json` (mode 0600). Only `demo`
appears in the public login hints; the judge expiry defaults to 2026-12-15 and is
applied only when `env:provision` is re-run. Use `local:up` instead if you do not
want the simulated accounts and data. See [Operations](OPERATIONS.md#public-demo-server). `healthcheck` reads `.env` and requires both process
liveness and configured Foundation readiness. Expected final probe output:

```text
Gateway liveness and configured Foundation readiness passed
```

Open [Junctura Console](http://127.0.0.1:3000/#/getting-started). The API origin is
`http://127.0.0.1:8080`. The Console starts in synthetic PREVIEW mode; LIVE requires
a valid token and shows missing/rejected credentials explicitly. Its browser token
is memory-only. Never paste a confidential OAuth client secret into the Console.
The API Explorer lists Foundation operations; Capability administration uses its
separate documented HTTP contract, not invented Console controls.

```sh
npm run local:status
npm run local:down
```

Stopping preserves named database/object volumes. Do not use `down -v`, volume
pruning or migration adoption flags to fix startup errors. For process-only native
development (`npm start` without providers), use `node scripts/check-health.mjs`;
the full-stack `npm run healthcheck` deliberately also requires `/ready`.

## Operator tasks: issue and enroll application credentials

### Quick local enrollment (development/demo stacks)

For Layer-2/3 prototyping on a local stack, one command performs the flow below:

```sh
docker compose -f compose.yaml -f infra/openbao/compose.bootstrap.yaml up -d --wait
npm run app:enroll -- lichhop --display-name "Lịch họp"
node --env-file=.env.app.lichhop.local examples/sdk-foundation.mjs --enrolled
```

It creates the confidential Keycloak client `app-lichhop` and its tenant service
account, demo owner and independent approver identities
(`junctura-demo-owner-<tenant>`, `junctura-demo-approver-<tenant>`) with separated
permissions, the SQL enrollment bound to the verified service-account subject, then
registers, approves and activates the application. The command issues an AppRole
and writes its bootstrap settings to the Git-ignored `.env.app.lichhop.local`.
The Compose override publishes OpenBao on loopback port 18200 for local development.
Options include `--tenant`, `--origin https://exact.origin` and `--display-name`.
Run it only on development/demo stacks; production enrollment follows the reviewed
manual flow below.

### Reviewed manual flow

The generated `tenant-a`, `tenant-b` and `reader` clients are synthetic identity
fixtures. They prove Foundation authentication; they are **not** active enrolled
applications and cannot access app-private v2 resources. `core-writer` does not
confer application administration, enrollment or approval authority.

A trusted local operator must perform the existing reviewed flow:

1. Create a confidential Keycloak backend client and service account. Verify the
   enabled client, exact issuer, tenant attribute and administrator-owned tenant
   group membership by reading them back through authenticated administration.
2. Verify separate human owner and approver identities and their management
   clients. Enroll the owner and independent approver with only the permissions
   needed, using the SQL in [Application Registration](CAPABILITIES.md#application-registration).
3. Enroll the exact OAuth client, owner and canonical HTTPS provider origin. Bind
   `resource_subject` to the verified service-account user ID using
   [resource enrollment](SECURITY.md#resource-authorization). Never infer it from a username
   or accept a tenant/owner override from an application.
4. The human owner POSTs `/v1/applications`. The separate approver creates a digest-
   and revision-bound application approval at `/v1/approvals`, then POSTs
   `/v1/applications/{appId}/approve` with that approval and exact `If-Match`.
   Follow the [complete API flow](CAPABILITIES.md#application-registration).
5. Once Core activates the app and writes its connection bundle, issue the app's
   scoped AppRole as documented below. Deliver the OpenBao origin, RoleID and
   SecretID through the deployment's private configuration channel. Record the
   operator change.

Use human authorization-code + PKCE for management and independent approval.
Backend client-credentials tokens authenticate only their enrolled service account.
Core verifies issuer, live token activity, tenant/group/roles and exact client/subject
binding server-side. Ownership and grants are rechecked by private SQL authority.

The existing `npm run test:applications` is an operator-only executable rehearsal:
it creates its own synthetic users/clients, performs real PKCE approval, runs the
record/object/workflow/share example and removes its own identity fixtures. Run it
only on a disposable development stack. It does not return reusable privileged
credentials or grant self-service enrollment to normal applications.

## Bootstrap a server-side application

Core needs the Keycloak application synchronization account and OpenBao configured.
Use the OpenBao operator identity to enable AppRole at `auth/approle` and install
the Core policy for the deployment's KV v2 mount. In local Compose, `secrets-init`
does both. For an active app, the operator can issue a RoleID and SecretID using
`sh scripts/provision-app-bootstrap.sh issue "$TENANT" "$APP_ID"`. Run it in a trusted
operator shell and direct its output to protected deployment configuration.
Set `SECRETS_MOUNT` on Core and the operator command when using a custom mount and
adapt the paths in [the Core policy](../infra/openbao/junctura-core.hcl).

The AppRole only reads `<mount>/data/tenants/<tenant>/connections/<appId>`. The
operator-provided `junctura_bundle` metadata in the AppRole login response tells the
SDK which path to read. See the [OpenBao AppRole API](https://openbao.org/docs/api/auth/approle/#generate-new-secret-id).
The bundle contains the app and tenant IDs, Gateway origin,
OIDC issuer and realm, token and discovery endpoints, and current client credentials.
The bootstrap command issues two-minute OpenBao tokens and SecretIDs valid for 24 hours.
Reissue a SecretID through the operator before expiry. For a retired deployment use
`sh scripts/provision-app-bootstrap.sh revoke "$TENANT" "$APP_ID"` after confirming its
identity. For an app activated before bundle provisioning was deployed, rotate its
OIDC secret once through [Core](CORE_API.md#application-deployment-and-access).

Provide the following private settings to the backend process. Use HTTPS for a remote
OpenBao service. Keep the SecretID and bundle in server-side configuration and memory.

```text
JUNCTURA_OPENBAO_URL=https://openbao.example.org
JUNCTURA_OPENBAO_ROLE_ID=<app role ID>
JUNCTURA_OPENBAO_SECRET_ID=<app secret ID>
```

```sh
node --env-file=.env.app.lichhop.local examples/sdk-foundation.mjs --enrolled
```

The example prints the verified identity and a confirmation that it created, read and deleted
its application-private record.
The larger [HTTP example](../examples/foundation-http.mjs) covers objects, workflow
and expiring read sharing; its required grantee settings are documented in
[DEVELOPING](DEVELOPING.md#developer-journey-and-cleanup).

An independent application's server can use the client directly:

```js
import { createAppBootstrap, createJuncturaClient } from './sdk/node/index.mjs';
const loadBundle = createAppBootstrap({
  url: process.env.JUNCTURA_OPENBAO_URL,
  roleId: process.env.JUNCTURA_OPENBAO_ROLE_ID,
  secretId: process.env.JUNCTURA_OPENBAO_SECRET_ID,
});
let junctura = createJuncturaClient(await loadBundle());
const identity = await junctura.identity();
const record = await junctura.createRecord('documents', { synthetic: true });
const read = await junctura.getRecord('documents', record.id);

// After the operator confirms an OIDC rotation, replace the runtime client.
junctura = createJuncturaClient(await loadBundle({ refresh: true }));
```

The loader caches the bundle in memory for 30 seconds by default and coalesces concurrent
reads. Set `cacheMs: 0` to fetch on each load. Use `refresh: true` to fetch immediately
after rotation. If refresh fails, the load rejects. Recreate the Gateway client with
the latest bundle to use updated credentials.
See [SDK error codes](../sdk/node/README.md#bootstrap-errors).

Convenience methods cover identity, v2 records/objects, workflow definitions/start,
authorized capability discovery, invocation/composition submission and bounded status
polling. `request(path, options)` returns a standard `Response` for other documented
Foundation/Registry/Trust APIs, including ETags and approval responses. There is no
automatic enrollment, grant creation or approval. The OpenAPI contracts remain
authoritative; the small declarations do not claim complete generated model coverage.

OAuth client-credentials tokens stay in process memory and refresh for subsequent
explicit requests. There are no mutation retries. Persist your original idempotency
key and request before submission; a timeout can mean the server accepted work.
`JuncturaError` carries sanitized `status`, `code` and optional `requestId`, without
echoing the raw upstream body. Never log the client configuration or request bodies.

## Publish, grant, discover and execute

1. The operator enrolls the provider and consumer as described above. The provider
   owner needs explicit Registry and Trust permissions; a separate human approver
   needs the corresponding independent approval permissions.
2. The owner POSTs a closed manifest at `/v1/capabilities/{encodedCapabilityId}/versions`.
   Use an exact version, restricted schemas, an enrolled provider, declared permissions
   and `sideEffects=none`. POST its `/validate` route using the returned ETag.
3. A separate approver POSTs `/v1/approvals` with `resourceType=capability-version`,
   exact resource ID/version, digest, revision and bounded expiry. An authorized
   publisher POSTs the version's `/publish` route with that approval and ETag.
4. The provider owner POSTs `/v1/trust/grants` binding the exact provider, different
   consumer, capability version/digest, declared permissions, expiry and direct subject.
   Request `discover` and `invoke` separately. The separate administrator records
   a grant approval then activates it with `/v1/trust/grants/{grantId}/activate`.
5. The consumer calls `junctura.discover()`. Only currently granted metadata is visible;
   an invoke-only grant does not authorize discovery. No consumer-supplied provider URL
   or tenant header can add authority.
6. For a reviewed operator configuration with C4A enabled and exact approved HTTPS
   origins, submit one capability reference:

```js
// `reference` comes from currently authorized, published discovery metadata.
const accepted = await junctura.execute(
  { kind: 'capability', capability: reference },
  { value: 'synthetic input' },
  originalPersistedUuid,
);
const result = await junctura.waitForExecution(accepted.executionId);
```

The provider must authenticate independently and redeem its single-use input-bound
ticket through `/v1/capability-authorizations/introspect` before executing. Input and
output must match the published schemas. The SDK is a consumer client, not a provider
server implementation. It never supplies Core credentials to a provider.

7. For C4B, the enrolled consumer with explicit `compositions.write` creates a plan at
   `/v1/compositions`. Use 1–16 ordered steps with exact capability pins, full-value
   previous-output bindings and supported C3 compatibility. Validate the exact version
   with ETag. A different human with `compositions.approve` must approve its digest and
   revision; an authorized publisher then publishes it. Every step needs its own current
   exact invoke grant. POST/PUT/approval bodies and plan fixtures are linked from
   [bounded composition](CAPABILITIES.md#composition).

```js
const accepted = await junctura.execute({
  kind: 'composition', compositionId, version: '1.0.0', compositionDigest,
}, { value: 'synthetic input' }, originalPersistedUuid);
const result = await junctura.waitForExecution(accepted.executionId);
```

Polling stops on `auth_required` as well as terminal outcomes. It does not reauthorize,
restart or redispatch work. Treat `outcome_unknown` as uncertain external receipt.
C4B has no supported resume, arbitrary DAG/loops, retries, HA credentials or exactly-once
external effect guarantee. Revoking the exact grant prevents later dispatch/redemption;
an approved replacement grant cannot revive an existing pinned reservation.

## Optional Capability demonstration

Install development-only validators and ensure host OpenSSL is available:

```sh
python -m pip install -r requirements-contracts.txt
npm run test:capabilities
npm run test:compositions
```

These are operator-run demonstrations/regression suites, not normal app setup.
Run them sequentially on a disposable local stack. They create synthetic authority,
independent humans, two private technical providers and a consumer. Real HTTP/OIDC,
PostgreSQL and Flowable prove registration, manifest publication, independent
approval, exact grants, discovery, invocation, ordered composition and revocation.
Private fixture Core instances opt in; the ordinary Gateway retains C4A/C4B disabled.
The suites retain synthetic SQL/audit evidence and clean their own identity/container
fixtures. They need operator fixture credentials; never run them on real user data.

For your own provider integration, read the ordered HTTP recipe in
[Capability Registry](CAPABILITIES.md#capability-registry), [Direct Trust](CAPABILITIES.md#direct-trust-grants),
[guarded invocation](CAPABILITIES.md#capability-execution) and [bounded composition](CAPABILITIES.md#composition).
The [Capability OpenAPI](contracts/capability-api-v1.openapi.json) is authoritative
for exact request bodies, independent permissions, ETags and supported states.

## Troubleshooting

| Symptom | Next action |
| --- | --- |
| Docker Linux engine unavailable | Start the Docker engine (on Windows/macOS: Docker Desktop with Linux containers), rerun doctor. |
| `.env already exists` | Keep it; compare key names with `.env.example`. Do not rerun setup over it. |
| Port occupied / wrong service | Run `local:status`; stop the conflicting project or choose distinct ports before a fresh install. |
| 401 | Check issuer, expiry, enabled OAuth client and credentials; never retry a write blindly. |
| 403 / `verified_client_required` | Ask the operator to verify enrollment, service-account subject and explicit permission. |
| 404 on app-private data or capability | Confirm current ownership/grants; concealed foreign resources also return 404. |
| 412 / 428 | Read the current resource and send its exact ETag as `If-Match`. |
| 409 idempotency conflict | Reuse the original request with its original key, or deliberately create new work with a new key. |
| 503 / not ready | Run doctor and `local:status`; inspect only the failing service's logs privately. |
| Migration checksum/drift refusal | Preserve data; follow [migration diagnostics](DEVELOPING.md#database-migrations). Never edit applied SQL. |
| C4 endpoint 404 | Execution is opt-in and disabled by default; use private test fixtures or a reviewed operator configuration. |
| `auth_required` / `outcome_unknown` | Stop polling as active work; inspect the documented recovery limits. Do not resubmit external effects. |

Resolved Compose configuration and provider logs can contain secrets. Review them
locally before sharing. See [operations](OPERATIONS.md), [upgrade/release guide](RELEASE.md)
and [security review](SECURITY.md) for the remaining operational limits.
