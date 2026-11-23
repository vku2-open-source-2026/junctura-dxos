// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { verifyContracts } from "./contract.mjs";
import { base, issuer as realmIssuer, recordTestSupport } from "./record-test-support.mjs";

const { sql, q, admin } = recordTestSupport("audit-app");
const tenant = `audit-${randomUUID()}`;
const issuer = "https://audit.example.invalid";
const app = randomUUID();
const claims = { tenant_id: tenant, iss: issuer, sub: "service", client_id: "app", role: "junctura_audit_api", resource_writer: true };
const management = { ...claims, sub: "manager", client_id: "console" };
const regulator = { ...claims, sub: "regulator", client_id: "regulator", regulator: true, units: ["unit-a"] };
const subject = { ...claims, sub: "person-login", subject_id: "person-42", client_id: "person" };
const sqlJson = value => `${q(JSON.stringify(value))}::jsonb`;
async function audit(call, who = claims, role = "junctura_audit_api") {
  const output = await sql(`SET ROLE ${role}; SELECT set_config('request.jwt.claims',${q(JSON.stringify(who))},false);
    SELECT ${call};`);
  return JSON.parse(output.split("\n").at(-1));
}
const query = (payload, who) => audit(`core.audit_query(${sqlJson(payload)})`, who);
const verify = () => audit("core.audit_verify('{}')", management);
const append = (body, key = randomUUID()) => audit(`core.audit_app_append(${sqlJson({ body, key })})`);
const archive = (operation, payload, who = management) =>
  audit(`core.audit_app_export(${q(operation)},${sqlJson(payload)})`, who);
const body = { action: "record.viewed", subjectId: subject.subject_id, resourceRef: { type: "object", id: randomUUID() },
  outcome: "success", purpose: "service_review", meta: { channel: "app" } };

test("application audit shares the platform chain and enforces archive, regulator and subject visibility", async () => {
  await sql(`INSERT INTO app_private.applications
      (tenant_id,app_id,issuer,oauth_client_id,owner_subject,provider_origin,display_name,state,digest)
    VALUES(${q(tenant)},${q(app)},${q(issuer)},'app','owner','https://audit-app.example.invalid','Fixture','active','sha256:${"0".repeat(64)}');
    INSERT INTO app_private.enrollments(tenant_id,issuer,oauth_client_id,owner_subject,provider_origin,resource_subject)
    VALUES(${q(tenant)},${q(issuer)},'app','owner','https://audit-app.example.invalid','service');
    INSERT INTO app_private.principals(tenant_id,issuer,subject,management_client,permissions)
    VALUES(${q(tenant)},${q(issuer)},'manager','console',ARRAY['audit.read']);
    INSERT INTO app_private.directory_unit_types(tenant_id,unit_type,name,generation,synced_generation)
    VALUES(${q(tenant)},'office','Office',1,1);
    INSERT INTO app_private.directory_units(tenant_id,unit,unit_type,name,generation,synced_generation)
    VALUES(${q(tenant)},'unit-a','office','Office',1,1);
    INSERT INTO app_private.audit_app_units VALUES(${q(tenant)},${q(app)},'unit-a');
    INSERT INTO app_private.subject_bindings(tenant_id,issuer,subject_id,login_subject)
    VALUES(${q(tenant)},${q(issuer)},${q(subject.subject_id)},${q(subject.sub)});
    INSERT INTO app_private.app_audit_actions VALUES
      (${q(tenant)},${q(app)},'record.viewed','standard',true),(${q(tenant)},${q(app)},'record.restricted','restricted',true);`);

  const empty = await archive("start", {});
  assert.equal(empty.value.head.sequence, 0);
  assert.equal(empty.value.head.hash, null);
  await archive("end", { snapshotId: empty.value.snapshotId });

  await audit(`app_private.audit_append('audit.platform_fixture','audit',${q(randomUUID())},1)`, management, "junctura_app_owner");
  const old = await verify();
  assert.deepEqual([old.value.verified, old.value.entries], [true, 1]);

  const unknownKey = randomUUID();
  assert.equal((await append({ ...body, action: "record.unknown" }, unknownKey)).error, "unknown_action");
  assert.equal((await append(body, unknownKey)).error, "idempotency_key_reused");
  const rollbackKey = randomUUID();
  await sql(`BEGIN; SET LOCAL ROLE junctura_audit_api;
    SELECT set_config('request.jwt.claims',${q(JSON.stringify(claims))},true);
    SELECT core.audit_app_append(${sqlJson({ body, key: rollbackKey })});
    ROLLBACK;`);
  assert.deepEqual((await query({ app: "self" }, claims)).value.items, []);
  assert.equal(await sql(`SELECT count(*) FROM app_private.idempotency_results WHERE key=${q(rollbackKey)};`), "0");
  const key = randomUUID();
  const [accepted, restricted, retry] = await Promise.all([
    append(body, key), append({ ...body, action: "record.restricted" }), append(body, key),
  ]);
  assert.equal(accepted.status, 201);
  assert.deepEqual(accepted, retry);
  assert.equal(restricted.status, 201);
  assert.deepEqual(accepted.value.actor, { kind: "application" });

  const self = await query({ app: "self" }, claims);
  assert.equal(self.value.items.length, 2);
  assert.equal(self.value.items[0].unit, "unit-a");
  assert.equal((await query({ app: "self" }, management)).status, 403);
  const managementItems = (await query({}, management)).value.items;
  assert.equal(managementItems.length, 3);
  assert.equal(managementItems[2].event, "audit.platform_fixture");
  assert.equal("actor" in managementItems[0], false);
  assert.equal((await query({ subjectId: body.subjectId }, management)).status, 403);
  const regulated = (await query({ unit: "unit-a" }, regulator)).value.items;
  assert.equal(regulated.length, 2);
  assert.equal(regulated.find(entry => entry.sensitivity === "standard").subjectId, body.subjectId);
  assert.equal("subjectId" in regulated.find(entry => entry.sensitivity === "restricted"), false);
  assert.equal((await query({ subjectId: body.subjectId }, regulator)).value.items.length, 1);
  assert.equal((await query({ unit: "unit-b" }, regulator)).status, 403);
  assert.deepEqual((await query({}, { ...regulator, units: ["unit-b"] })).value.items, []);

  await sql(`UPDATE app_private.app_audit_actions SET visible_to_subject=false WHERE tenant_id=${q(tenant)};`);
  const visible = await audit(`(SELECT jsonb_agg(event_id) FROM app_private.audit_subject_entries(${q(body.subjectId)}))`,
    subject, "junctura_app_owner");
  assert.deepEqual(visible, [accepted.value.eventId]);
  assert.equal(await audit(`(SELECT jsonb_agg(event_id) FROM app_private.audit_subject_entries(${q(body.subjectId)}))`,
    { ...subject, sub: "other-login" }, "junctura_app_owner"), null);

  const snapshot = await archive("start", { app: "self" }, claims);
  assert.equal(snapshot.value.head.sequence, 3);
  const [late, sealed] = await Promise.all([append(body), verify()]);
  assert.equal(late.status, 201);
  assert.equal(sealed.value.verified, true);
  const page = await archive("page", { snapshotId: snapshot.value.snapshotId }, claims);
  assert.deepEqual(page.value.lines.map(line => line.sequence), [2, 3]);
  assert.equal(page.value.lines[1].hash, snapshot.value.head.hash);
  await archive("end", { snapshotId: snapshot.value.snapshotId }, claims);
  assert.equal((await verify()).value.entries, 4);

  const delegated = { ...subject, client_id: "app", units: ["unit-a"] };
  assert.equal((await query({ app: "self" }, delegated)).status, 403);
  await sql(`INSERT INTO app_private.audit_app_delegates VALUES(${q(tenant)},${q(app)},${q(subject.sub)});`);
  const delegate = await audit(`core.audit_app_append(${sqlJson({ body, key: randomUUID() })})`, delegated);
  assert.equal(delegate.status, 201);
  assert.deepEqual(delegate.value.actor, { kind: "user", subject: subject.subject_id });
  assert.equal((await query({ units: ["unit-a"] }, delegated)).status, 400);
  assert.equal((await verify()).value.entries, 5);

  await sql(`UPDATE app_private.audit_app_payloads SET visible_to_subject=false
    WHERE tenant_id=${q(tenant)} AND event_id=${q(accepted.value.eventId)};`);
  assert.equal((await verify()).value.firstBreak.reason, "content_modified");
  await sql(`UPDATE app_private.audit_app_payloads SET visible_to_subject=true
    WHERE tenant_id=${q(tenant)} AND event_id=${q(accepted.value.eventId)};
    DELETE FROM app_private.audit_app_payloads WHERE tenant_id=${q(tenant)} AND event_id=${q(restricted.value.eventId)};
    DELETE FROM app_private.audit WHERE tenant_id=${q(tenant)} AND event_id=${q(restricted.value.eventId)};`);
  assert.equal((await verify()).value.firstBreak.reason, "missing_entry");
});

test("gateway append, self query and NDJSON export match the application audit contract", { timeout: 90000 }, async () => {
  const httpTenant = `audit-http-${randomUUID()}`, httpApp = randomUUID(), clientId = httpTenant;
  let group, client;
  const create = async (path, body) => {
    const result = await admin(path, "POST", body);
    assert.equal(result.status, 201, await result.text());
    return result.headers.get("location").split("/").at(-1);
  };
  try {
    const [template] = await (await admin("clients?clientId=tenant-a")).json();
    const { protocolMappers } = await (await admin(`clients/${template.id}`)).json();
    group = await create("groups", { name: httpTenant });
    client = await create("clients", { clientId, protocol: "openid-connect", enabled: true, publicClient: false,
      serviceAccountsEnabled: true, standardFlowEnabled: false,
      protocolMappers: protocolMappers.map(({ id, ...mapper }) => ({
        ...mapper, config: mapper.name === "tenant" ? { ...mapper.config, "claim.value": httpTenant } : mapper.config,
      })),
    });
    const { id: login } = await (await admin(`clients/${client}/service-account-user`)).json();
    assert.equal((await admin(`users/${login}/groups/${group}`, "PUT")).status, 204);
    const roles = await Promise.all(["core-reader", "core-writer"].map(async name => (await admin(`roles/${name}`)).json()));
    assert.equal((await admin(`users/${login}/role-mappings/realm`, "POST", roles)).status, 204);
    const { value: secret } = await (await admin(`clients/${client}/client-secret`)).json();
    const issued = await fetch(`${realmIssuer}/protocol/openid-connect/token`, {
      method: "POST", body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: secret }),
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(issued.status, 200);
    const { access_token: token } = await issued.json();
    const tenantSql = q(httpTenant), provider = "https://audit-http.example.invalid";
    await sql(`INSERT INTO app_private.applications
        (tenant_id,app_id,issuer,oauth_client_id,owner_subject,provider_origin,display_name,state,digest)
      VALUES (${tenantSql},${q(httpApp)},${q(realmIssuer)},${q(clientId)},${q(login)},${q(provider)},'Fixture','active','sha256:${"0".repeat(64)}');
      INSERT INTO app_private.enrollments(tenant_id,issuer,oauth_client_id,owner_subject,provider_origin,resource_subject)
      VALUES (${tenantSql},${q(realmIssuer)},${q(clientId)},${q(login)},${q(provider)},${q(login)});
      INSERT INTO app_private.app_audit_actions VALUES (${tenantSql},${q(httpApp)},'record.viewed','standard',true);`);
    const get = (url, init = {}) => fetch(base + url, { ...init,
      headers: { Authorization: `Bearer ${token}`, ...init.headers }, signal: AbortSignal.timeout(15000),
    });
    const send = (event, key) => get("/v1/audit-events", { method: "POST", body: JSON.stringify(event),
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    });
    const rejected = await send({ ...body, action: "record.undeclared" }, randomUUID());
    assert.equal(rejected.status, 422, await rejected.clone().text());
    assert.equal((await rejected.json()).error, "unknown_action");
    const key = randomUUID();
    const posted = await send(body, key);
    assert.equal(posted.status, 201, await posted.clone().text());
    const receipt = await posted.json();
    assert.deepEqual(await (await send(body, key)).json(), receipt);
    const listed = await get("/v1/audit-events?app=self&action=record.viewed");
    assert.equal(listed.status, 200, await listed.clone().text());
    const page = await listed.json();
    assert.deepEqual(page.items.map(item => item.eventId), [receipt.eventId]);
    const exported = await get("/v1/audit-events:export?app=self");
    assert.equal(exported.status, 200, await exported.clone().text());
    assert.match(exported.headers.get("content-type"), /^application\/x-ndjson/);
    const lines = (await exported.text()).trimEnd().split("\n").map(line => JSON.parse(line));
    assert.equal(lines.length, 2);
    const [head, entry] = lines;
    assert.deepEqual([head.sequence, head.hash], [entry.sequence, entry.hash]);
    assert.equal(entry.event.eventId, receipt.eventId);
    await verifyContracts("audit-app", [
      { schema: "AppAuditWrite", value: body },
      { schema: "AppAuditReceipt", value: receipt },
      { schema: "AuditQueryPage", value: page },
      { schema: "AuditExportHead", value: head },
      { schema: "AuditExportLine", value: entry },
    ], "--capability-runtime");
  } finally {
    try {
      const scope = `tenant_id=${q(httpTenant)}`;
      await sql(`DELETE FROM app_private.audit_export_snapshots WHERE ${scope};
        DELETE FROM app_private.audit_app_payloads WHERE ${scope};
        DELETE FROM app_private.audit WHERE ${scope};
        DELETE FROM app_private.audit_chain_heads WHERE ${scope};
        DELETE FROM app_private.idempotency_results WHERE ${scope};
        DELETE FROM app_private.enrollments WHERE ${scope};
        DELETE FROM app_private.applications WHERE ${scope};`);
    } finally {
      if (client) await admin(`clients/${client}`, "DELETE");
      if (group) await admin(`groups/${group}`, "DELETE");
    }
  }
});
