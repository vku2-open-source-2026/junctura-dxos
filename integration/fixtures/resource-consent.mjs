// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after } from "node:test";
import { base, issuer, jsonResult as json, recordTestSupport } from "../record-test-support.mjs";
import { createAuthorityFixture } from "./authority.mjs";
import { provisionFixtureDirectory } from "./keycloak.mjs";

export function resourceConsentFixture(label, { includeRequesters = false } = {}) {
  const prefix = `${label}-${randomBytes(6).toString("hex")}`;
  const tenant = "tenant-a";
  const units = ["owner", "recipient", "outside"].map(label => `${prefix}-${label}`);
  const [ownerUnit, recipientUnit, outsideUnit] = units;
  const clientIds = [], users = [], keys = [];
  const { api: request, sql, q } = recordTestSupport(prefix);
  const fixture = createAuthorityFixture({ base, prefix, sql, q, clientIds, users,
    api: (path, who, body, headers, method = body === undefined ? "GET" : "POST") => request(path, who, { method, body, headers }) });
  const idempotency = () => {
    const key = randomUUID();
    keys.push(key);
    return { "Idempotency-Key": key };
  };
  const recordPath = `/v2/data/${prefix}`;
  const subjectId = randomUUID();
  const otherSubjectId = randomUUID();

  after(async () => {
    if (!clientIds.length) return;
    const subjects = users.map(q).join(",") || "NULL";
    const appIds = `SELECT app_id FROM app_private.applications WHERE tenant_id=${q(tenant)} AND owner_subject IN (${subjects})`;
    const unitKeys = units.map(q).join(",");
    try {
      await sql(`BEGIN;
        SELECT set_config('request.jwt.claims', ${q(JSON.stringify({ tenant_id: tenant }))}, true);
        DELETE FROM app_private.resource_consents WHERE tenant_id=${q(tenant)} AND login_subject IN (${subjects});
        DELETE FROM app_private.resource_consent_requests WHERE tenant_id=${q(tenant)} AND login_subject IN (${subjects});
        DELETE FROM app_private.object_upload_staging WHERE tenant_id=${q(tenant)} AND owner_app_id IN (${appIds});
        DELETE FROM app_private.resource_objects WHERE tenant_id=${q(tenant)} AND owner_app_id IN (${appIds});
        DELETE FROM app_private.object_quotas WHERE tenant_id=${q(tenant)} AND owner_app_id IN (${appIds});
        DELETE FROM core.app_records WHERE tenant_id=${q(tenant)} AND owner_app_id IN (${appIds});
        DELETE FROM app_private.record_collections WHERE tenant_id=${q(tenant)} AND owner_app_id IN (${appIds});
        DELETE FROM app_private.idempotency_results WHERE tenant_id=${q(tenant)} AND key IN (${keys.map(q).join(",") || "NULL"});
        DELETE FROM app_private.app_assignments WHERE tenant_id=${q(tenant)} AND app_id IN (${appIds});
        DELETE FROM app_private.approvals WHERE tenant_id=${q(tenant)} AND app_id IN (${appIds});
        UPDATE app_private.applications SET state='revoked'
          WHERE tenant_id=${q(tenant)} AND app_id IN (${appIds});
        DELETE FROM app_private.enrollments WHERE tenant_id=${q(tenant)} AND owner_subject IN (${subjects});
        DELETE FROM app_private.principals WHERE tenant_id IN (${q(tenant)},'tenant-b') AND subject IN (${subjects});
        DELETE FROM app_private.directory_memberships WHERE tenant_id=${q(tenant)} AND unit IN (${unitKeys});
        DELETE FROM app_private.directory_members WHERE tenant_id=${q(tenant)} AND unit IN (${unitKeys});
        DELETE FROM app_private.directory_units WHERE tenant_id=${q(tenant)} AND unit IN (${unitKeys});
        DELETE FROM app_private.directory_unit_types WHERE tenant_id=${q(tenant)} AND unit_type=${q(prefix)};
        ALTER TABLE app_private.subject_bindings DISABLE TRIGGER subject_binding_guard;
        DELETE FROM app_private.subject_bindings WHERE tenant_id IN (${q(tenant)},'tenant-b') AND issuer=${q(issuer)}
          AND subject_id IN (${q(subjectId)},${q(otherSubjectId)}) AND login_subject IN (${subjects});
        ALTER TABLE app_private.subject_bindings ENABLE TRIGGER subject_binding_guard;
        COMMIT;`);
    } finally {
      await fixture.operatorToken();
      for (const id of clientIds) await fixture.admin(`clients/${id}`, undefined, "DELETE");
      for (const id of users) await fixture.admin(`users/${id}`, undefined, "DELETE");
      const roots = await json(await fixture.admin(`groups?search=${tenant}&exact=true`), 200);
      const root = roots.find(group => group.path === `/${tenant}`);
      if (root) for (const group of await json(await fixture.admin(`groups/${root.id}/children`), 200)) {
        if (units.includes(group.name)) await fixture.admin(`groups/${group.id}`, undefined, "DELETE");
      }
    }
  });

  const redirectUri = "http://127.0.0.1:9876/callback";
  async function managementClient(tenant) {
    const [template] = await json(await fixture.admin(`clients?clientId=${tenant}`), 200);
    const { protocolMappers } = await json(await fixture.admin(`clients/${template.id}`), 200);
    const client = await fixture.admin("clients", {
      clientId: `${prefix}-management-${tenant}`, enabled: true, protocol: "openid-connect", publicClient: true,
      standardFlowEnabled: true, redirectUris: [redirectUri], attributes: { "pkce.code.challenge.method": "S256" },
      protocolMappers: protocolMappers.map(({ id, ...mapper }) => mapper),
    }, "POST");
    assert.equal(client.status, 201);
    clientIds.push(client.headers.get("location").split("/").at(-1));
  }

  async function setup() {
    await provisionFixtureDirectory(base);
    await fixture.operatorToken();
    await managementClient(tenant);

    const owner = await fixture.verifiedSubject(await fixture.human("owner", tenant, ["applications.register"]), subjectId);
    const admin = await fixture.human("admin", tenant, ["applications.approve", "trust.approve", "audit.read", "directory.write"]);
    const reader = await fixture.human("reader", tenant, []);
    const outsider = await fixture.verifiedSubject(await fixture.human("outsider", tenant, []), otherSubjectId);
    let peer, foreignSubject;
    if (includeRequesters) {
      peer = await fixture.human("peer", tenant, []);
      await managementClient("tenant-b");
      foreignSubject = await fixture.verifiedSubject(await fixture.human("foreign", "tenant-b", []), subjectId);
    }
    const put = (path, body) => request(`/v1/directory/${path}`, admin, { method: "PUT", body }).then(r => json(r, 201));
    await put(`unit-types/${prefix}`, { name: "Consent fixture" });
    for (const [unit, person] of [[ownerUnit, owner], [recipientUnit, reader], [outsideUnit, outsider]]) {
      await put(`units/${unit}`, { name: unit, unitType: prefix });
      await put(`units/${unit}/members/${person.id}`, { groups: [] });
    }

    if (peer) await put(`units/${recipientUnit}/members/${peer.id}`, { groups: [] });

    const backend = await fixture.backend("app", owner, admin, tenant, true, undefined, redirectUri);
    const { app: { appId }, clientId, clientSecret } = backend;
    const appPath = `/v1/applications/${appId}`;
    await json(await request(appPath, admin, { method: "PATCH", headers: { "If-Match": backend.etag },
      body: { ownerUnit, deploymentUnits: units } }), 200);
    const assign = (unit, user, role) => request(`${appPath}/assignments`, admin,
      { method: "POST", body: { unit, targetType: "subject", target: user.id, role } }).then(r => json(r, 200));
    const login = user => fixture.login(user.username, user.password, clientId, clientSecret);
    // Approval configures the browser flow and can invalidate the pre-approval token.
    const actorToken = await backend.issueToken();
    const callExchange = subjectToken => request("/v1/token-exchange", actorToken, { method: "POST", body: { subjectToken } });
    const exchange = async source => (await json(await callExchange(source), 200)).access_token;
    assert.equal((await json(await callExchange(reader.token), 403)).error, "not_assigned_to_app");
    await assign(ownerUnit, owner, "manager");
    const readerAssignment = await assign(recipientUnit, reader, "viewer");
    await assign(outsideUnit, outsider, "viewer");
    if (peer) await assign(recipientUnit, peer, "viewer");
    const ownerSource = await login(owner);
    const readerSource = await login(reader);
    const outsiderSource = await login(outsider);
    const peerSource = peer ? await login(peer) : undefined;
    const ownerToken = await exchange(ownerSource);
    await json(await request(`/v2/data-schemas/${prefix}`, ownerToken, { method: "PUT",
      body: { schema: { type: "object", properties: { label: { type: "string" } }, required: ["label"] },
        indexed: [], uniqueKey: null, searchable: [], sensitive: [] } }), 200);
    const record = await json(await request(recordPath, ownerToken, { method: "POST",
      headers: idempotency(), body: { data: { label: "Selected record" } } }), 201);
    const target = `${recordPath}/${record.id}`;
    const boundary = `consent${randomBytes(12).toString("hex")}`;
    const contents = "Selected object";
    const object = await json(await request("/v2/objects", ownerToken, { method: "POST",
      headers: { ...idempotency(), "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: Buffer.from([`--${boundary}`, 'Content-Disposition: form-data; name="file"; filename="object.bin"',
        "Content-Type: application/octet-stream", "", contents, `--${boundary}`,
        'Content-Disposition: form-data; name="recordRef"', "Content-Type: application/json", "",
        JSON.stringify({ collection: prefix, id: record.id }), `--${boundary}--`, ""].join("\r\n")) }), 201);
    const objectPath = `/v2/objects/${object.id}`;
    return { owner, admin, reader, outsider, foreignSubject, appId, appPath, clientId, exchange,
      ownerSource, readerSource, outsiderSource, peerSource, readerAssignment, record, target, object, objectPath, contents };
  }
  return { setup, request, sql, q, prefix, tenant, recipientUnit, outsideUnit, subjectId, idempotency };
}
