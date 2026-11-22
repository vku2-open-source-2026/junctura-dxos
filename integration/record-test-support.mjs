// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { contractFetch } from "./contract.mjs";

export const base = process.env.PUBLIC_URL ?? "http://127.0.0.1:8080";
export const issuer = `${base}/identity/realms/junctura`;

export function recordTestSupport(prefix) {
  const clients = [];
  let adminToken;
  const run = promisify(execFile);
  const sql = async source => (await run("docker", ["compose", "exec", "-T", "database", "psql",
    "-U", "junctura_admin", "-d", "junctura_data", "-XAtq", "-v", "ON_ERROR_STOP=1", "-c", source],
  { timeout: 20000 })).stdout.trim();
  const q = value => "'" + String(value).replaceAll("'", "''") + "'";

  async function operatorToken() {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${base}/identity/realms/master/protocol/openid-connect/token`, {
          method: "POST",
          body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli",
            username: "junctura-admin", password: process.env.KEYCLOAK_ADMIN_PASSWORD }),
          signal: AbortSignal.timeout(5000),
        });
        if (response.status === 200) return (await response.json()).access_token;
      } catch { /* Retry while the identity service settles. */ }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error("operator authentication did not recover");
  }

  async function admin(path, method = "GET", body) {
    if (!adminToken) adminToken = await operatorToken();
    return fetch(`${base}/identity/admin/realms/junctura/${path}`, {
      method,
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
  }

  async function createBackend(suffix, { enroll = true } = {}) {
    adminToken = await operatorToken();
    const clientId = `${prefix.replaceAll("_", "-")}-${suffix}`;
    const template = (await (await admin("clients?clientId=tenant-a")).json())[0];
    if (!template?.id) throw new Error("tenant-a client template missing");
    const { protocolMappers } = await (await admin(`clients/${template.id}`)).json();
    const created = await admin("clients", "POST", {
      clientId, protocol: "openid-connect", enabled: true, publicClient: false, serviceAccountsEnabled: true,
      standardFlowEnabled: false, protocolMappers: protocolMappers.map(({ id, ...mapper }) => mapper),
    });
    if (created.status !== 201) throw new Error(`client creation failed: ${created.status}`);
    const client = created.headers.get("location").split("/").at(-1);
    clients.push(client);
    const { id: subject } = await (await admin(`clients/${client}/service-account-user`)).json();
    const group = (await (await admin("groups?search=tenant-a&exact=true")).json()).find(item => item.name === "tenant-a");
    if (!group) throw new Error("tenant-a group missing");
    if ((await admin(`users/${subject}/groups/${group.id}`, "PUT")).status !== 204) throw new Error("group membership failed");
    const roles = await Promise.all(["core-reader", "core-writer"].map(async name => (await admin(`roles/${name}`)).json()));
    if ((await admin(`users/${subject}/role-mappings/realm`, "POST", roles)).status !== 204) throw new Error("role mapping failed");
    const { value: secret } = await (await admin(`clients/${client}/client-secret`)).json();
    const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
      method: "POST",
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: secret }),
      signal: AbortSignal.timeout(10000),
    });
    if (response.status !== 200) throw new Error("client token failed");
    const { access_token: token } = await response.json();
    const appId = randomUUID();
    const provider = `https://${clientId}.example.invalid`;
    if (enroll) {
      await sql(`INSERT INTO app_private.applications
        (tenant_id,app_id,issuer,oauth_client_id,owner_subject,provider_origin,display_name,state,digest)
        VALUES ('tenant-a',${q(appId)},${q(issuer)},${q(clientId)},${q(subject)},${q(provider)},${q(`Record test ${suffix}`)},'active','sha256:${"0".repeat(64)}');
        INSERT INTO app_private.enrollments (tenant_id,issuer,oauth_client_id,owner_subject,provider_origin,resource_subject)
        VALUES ('tenant-a',${q(issuer)},${q(clientId)},${q(subject)},${q(provider)},${q(subject)});`);
    }
    return { appId, token, subject, clientId };
  }

  async function cleanup(backends) {
    try {
      for (const app of backends.filter(Boolean)) {
        await sql(`DELETE FROM app_private.record_export_snapshots WHERE owner_app_id='${app.appId}';
          DELETE FROM app_private.record_query_cursors WHERE owner_app_id='${app.appId}';`);
        await sql(`DELETE FROM app_private.idempotency_results WHERE concrete_path LIKE '%${prefix}%';
          DELETE FROM app_private.audit WHERE actor_app_id='${app.appId}' OR subject='${app.subject}';
          DELETE FROM app_private.resource_shares WHERE owner_app_id='${app.appId}' OR grantee_app_id='${app.appId}';
          DELETE FROM app_private.record_read_grants WHERE owner_app_id='${app.appId}';
          DELETE FROM app_private.principals WHERE tenant_id='tenant-a' AND management_client=${q(app.clientId)};
          DELETE FROM app_private.app_group_memberships WHERE app_id='${app.appId}';
          DELETE FROM core.app_records WHERE tenant_id='tenant-a' AND owner_app_id='${app.appId}';
          DELETE FROM app_private.record_collections WHERE tenant_id='tenant-a' AND owner_app_id='${app.appId}';
          DELETE FROM app_private.enrollments WHERE tenant_id='tenant-a' AND oauth_client_id=${q(app.clientId)};
          DELETE FROM app_private.applications WHERE tenant_id='tenant-a' AND app_id='${app.appId}';`);
      }
      await sql(`DELETE FROM app_private.app_groups WHERE tenant_id='tenant-a' AND app_group LIKE '%${prefix.replaceAll("_", "-")}%';`);
    } finally {
      if (clients.length) {
        adminToken = await operatorToken();
        for (const client of clients) await admin(`clients/${client}`, "DELETE");
      }
    }
  }

  function api(path, who, { method = "GET", body, headers = {}, signal } = {}) {
    return contractFetch(base + path, {
      method,
      headers: {
        ...(who ? { Authorization: `Bearer ${who.token ?? who}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(30000),
    });
  }

  return { sql, q, admin, createBackend, cleanup, api };
}

export async function jsonResult(response, status) {
  if (response.status !== status) throw new Error(`expected ${status}, received ${response.status}: ${await response.text()}`);
  return response.json();
}
