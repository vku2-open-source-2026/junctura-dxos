// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { createAppBootstrap, createJuncturaClient } from "../sdk/node/index.mjs";
import { localAppRole, localOpenBaoUrl } from "../scripts/lib/local-app-bootstrap.mjs";
import { createAuthorityFixture } from "./fixtures/authority.mjs";
import { base, issuer, recordTestSupport } from "./record-test-support.mjs";

const prefix = `bootstrap-${randomUUID().slice(0, 8)}`;
const tenant = "tenant-a";
const clientIds = [], users = [], roles = [];
const { api: request, sql, q } = recordTestSupport(prefix);
const api = (path, who, body, headers) =>
  request(path, who, { body, headers, method: body === undefined ? "GET" : "POST" });
const fixture = createAuthorityFixture({ base, prefix, sql, q, api, clientIds, users });

after(async () => {
  try {
    for (const appId of roles) await localAppRole("revoke", tenant, appId);
  } finally {
    if (users.length) {
      const subjects = users.map(q).join(",");
      await sql(`BEGIN;
        SELECT set_config('request.jwt.claims', ${q(JSON.stringify({ tenant_id: tenant }))}, true);
        DELETE FROM app_private.approvals WHERE tenant_id=${q(tenant)} AND app_id IN
          (SELECT app_id FROM app_private.applications WHERE tenant_id=${q(tenant)} AND owner_subject IN (${subjects}));
        UPDATE app_private.applications SET state='revoked'
          WHERE tenant_id=${q(tenant)} AND owner_subject IN (${subjects});
        DELETE FROM app_private.enrollments WHERE tenant_id=${q(tenant)} AND owner_subject IN (${subjects});
        DELETE FROM app_private.principals WHERE tenant_id=${q(tenant)} AND subject IN (${subjects});
        COMMIT;`);
    }
    if (clientIds.length) await fixture.operatorToken();
    for (const id of clientIds) assert.equal((await fixture.admin(`clients/${id}`, undefined, "DELETE")).status, 204);
    for (const id of users) assert.equal((await fixture.admin(`users/${id}`, undefined, "DELETE")).status, 204);
  }
});

test("enrolled backends bootstrap from their own AppRole and reload the Keycloak secret after rotation", { timeout: 150_000 }, async () => {
  const url = await localOpenBaoUrl();
  await fixture.operatorToken();
  const [template] = await (await fixture.admin(`clients?clientId=${tenant}`)).json();
  const { protocolMappers } = await (await fixture.admin(`clients/${template.id}`)).json();
  const created = await fixture.admin("clients", {
    clientId: `${prefix}-management-${tenant}`, enabled: true, protocol: "openid-connect", publicClient: true,
    standardFlowEnabled: true, redirectUris: ["http://127.0.0.1:9876/callback"],
    attributes: { "pkce.code.challenge.method": "S256" }, protocolMappers: protocolMappers.map(({ id, ...mapper }) => mapper),
  }, "POST");
  assert.equal(created.status, 201);
  clientIds.push(created.headers.get("location").split("/").at(-1));
  const owner = await fixture.human("owner", tenant, ["applications.register"]);
  const approver = await fixture.human("approver", tenant, ["applications.approve", "trust.approve"]);
  const a = await fixture.backend("a", owner, approver);
  const b = await fixture.backend("b", owner, approver);

  async function issue({ app: { appId } }) {
    roles.push(appId);
    const env = await localAppRole("issue", tenant, appId);
    return { url, roleId: env.JUNCTURA_OPENBAO_ROLE_ID, secretId: env.JUNCTURA_OPENBAO_SECRET_ID };
  }
  const appRoleA = await issue(a);
  const loadA = createAppBootstrap(appRoleA);
  const loadB = createAppBootstrap(await issue(b));
  const [bundleA, bundleB] = await Promise.all([loadA(), loadB()]);
  for (const [bundle, backend] of [[bundleA, a], [bundleB, b]]) {
    assert.equal(bundle.appId, backend.app.appId);
    assert.equal(bundle.baseUrl, base);
    assert.equal(bundle.issuer, issuer);
    assert.equal(bundle.realm, "junctura");
    assert.equal(bundle.clientId, backend.clientId);
    assert.ok(bundle.clientSecret === backend.clientSecret, "bootstrap must return the current client secret");
    assert.equal((await createJuncturaClient(bundle).identity()).subject, backend.subject);
  }

  const login = await fetch(`${url}/v1/auth/approle/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role_id: appRoleA.roleId, secret_id: appRoleA.secretId }),
  });
  assert.equal(login.status, 200);
  const { auth } = await login.json();
  const headers = { "X-Vault-Token": auth.client_token, "Content-Type": "application/json" };
  const path = auth.metadata.junctura_bundle;
  assert.ok(path.endsWith(`/${a.app.appId}`));
  const otherApp = await fetch(`${url}/v1/${path.replace(a.app.appId, b.app.appId)}`, { headers });
  assert.equal(otherApp.status, 403);
  const forbiddenWrite = await fetch(`${url}/v1/${path}`, { method: "POST", headers, body: '{"data":{}}' });
  assert.equal(forbiddenWrite.status, 403);

  const key = randomUUID();
  const rotate = () => api(`/v1/applications/${a.app.appId}/oidc-keys`, approver, {}, { "Idempotency-Key": key });
  const rotated = await rotate();
  assert.equal(rotated.status, 200);
  const receipt = await rotated.json();
  assert.equal(receipt.items[0].rotationId, key);
  assert.ok(receipt.items[0].appliedAt);
  const refreshed = await loadA({ refresh: true });
  assert.ok(refreshed.clientSecret !== bundleA.clientSecret, "bootstrap must return the rotated client secret");
  assert.ok(!JSON.stringify(receipt).includes(refreshed.clientSecret));
  assert.equal((await createJuncturaClient(refreshed).identity()).subject, a.subject);
  await assert.rejects(createJuncturaClient(bundleA).identity(), { status: 401, code: "authentication_failed" });
  assert.equal((await rotate()).status, 200);
  assert.ok((await loadA({ refresh: true })).clientSecret === refreshed.clientSecret);
  assert.ok((await loadB({ refresh: true })).clientSecret === bundleB.clientSecret);

  const cli = await promisify(execFile)(process.execPath, ["examples/sdk-foundation.mjs", "--enrolled"], {
    env: { ...process.env, JUNCTURA_OPENBAO_URL: url,
      JUNCTURA_OPENBAO_ROLE_ID: appRoleA.roleId, JUNCTURA_OPENBAO_SECRET_ID: appRoleA.secretId },
    timeout: 30_000,
  });
  assert.match(cli.stdout, /Application-private record created/);
});
