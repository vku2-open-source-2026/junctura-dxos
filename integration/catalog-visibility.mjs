// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { main as provisionDirectory } from "../scripts/provision-directory.mjs";
import { verifyContracts } from "./contract.mjs";
import { createAuthorityFixture } from "./fixtures/authority.mjs";
import { base, issuer, jsonResult as json, recordTestSupport } from "./record-test-support.mjs";

const prefix = `catalog-vis-${randomBytes(6).toString("hex")}`;
const tenant = "tenant-a";
const redirectUri = "http://127.0.0.1:9876/callback";
const [unitA, unitB] = [`${prefix}-a`, `${prefix}-b`];
const clientIds = [], users = [], cases = [];
const { api: request, sql, q } = recordTestSupport(prefix);
const api = (path, who, body, headers, method = body === undefined ? "GET" : "POST") =>
  request(path, who, { body, headers, method });
const fixture = createAuthorityFixture({ base, prefix, sql, q, clientIds, users,
  api: (path, who, body, headers, method = body === undefined ? "GET" : "POST") => request(path, who, { method, body, headers }) });

let owner, administrator, publisher, userUnitA, userUnitB, foreignOwner, foreignAdmin;
let provider, consumerA, consumerB, browserApp, foreignConsumer, capabilityId, versionRoute;
const manifestTemplate = JSON.parse(readFileSync(new URL("../docs/contracts/examples/capability-manifest.json", import.meta.url)));

function manifest() {
  return { ...structuredClone(manifestTemplate), capabilityId, providerAppId: provider.app.appId, version: "1.0.0",
    title: `Catalog visibility echo ${randomBytes(3).toString("hex")}`,
    requiredPermissions: [`urn:junctura:permission:${provider.app.appId}:invoke`] };
}

async function publish() {
  const created = await api(`/v1/capabilities/${encodeURIComponent(capabilityId)}/versions`, owner, manifest());
  assert.equal(created.status, 201, await created.clone().text());
  const draft = await created.json();
  assert.equal(draft.visibility, "hidden");
  assert.deepEqual(draft.visibilityUnits, []);
  assert.deepEqual(draft.visibilityApps, []);
  const validated = await api(`${versionRoute}/validate`, owner, {}, { "If-Match": created.headers.get("etag") });
  assert.equal(validated.status, 200, await validated.clone().text());
  const decision = await api("/v1/approvals", administrator, {
    resourceType: "capability-version", resourceId: `${capabilityId}@1.0.0`, resourceDigest: draft.digest,
    resourceRevision: draft.revision, requesterSubject: owner.id, requesterAppId: provider.app.appId,
    decision: "approve", expiresAt: new Date(Date.now() + 120000).toISOString() });
  assert.equal(decision.status, 201, await decision.clone().text());
  const published = await api(`${versionRoute}/publish`, publisher, { approvalId: (await decision.json()).approvalId },
    { "If-Match": created.headers.get("etag") });
  assert.equal(published.status, 200, await published.clone().text());
  const value = await published.json();
  assert.equal(value.state, "published");
  assert.equal(value.visibility, "hidden", "published versions start hidden");
  cases.push({ schema: "CapabilityVersion", value });
  return { ...value, etag: published.headers.get("etag") };
}

after(async () => {
  if (!clientIds.length) return;
  const subjects = users.map(q).join(",") || "NULL";
  // Applications are never deleted: audit rows reference them. Each tenant
  // cleanup transaction opens with the tenant claims so RLS stays enforced.
  for (const cleanupTenant of ["tenant-a", "tenant-b"]) {
    const apps = `SELECT app_id FROM app_private.applications WHERE tenant_id=${q(cleanupTenant)} AND owner_subject IN (${subjects})`;
    const units = [unitA, unitB].map(q).join(",");
    try {
      await sql(`BEGIN;
        SELECT set_config('request.jwt.claims', ${q(JSON.stringify({ tenant_id: cleanupTenant }))}, true);
        DELETE FROM app_private.capability_publication_approvals WHERE tenant_id=${q(cleanupTenant)} AND requester_app_id IN (${apps});
        DELETE FROM app_private.capability_versions WHERE tenant_id=${q(cleanupTenant)} AND provider_app_id IN (${apps});
        DELETE FROM app_private.app_assignments WHERE tenant_id=${q(cleanupTenant)} AND app_id IN (${apps});
        DELETE FROM app_private.approvals WHERE tenant_id=${q(cleanupTenant)} AND app_id IN (${apps});
        UPDATE app_private.applications SET state='revoked',owner_unit=NULL,deployment_units='{}'
          WHERE tenant_id=${q(cleanupTenant)} AND app_id IN (${apps});
        DELETE FROM app_private.enrollments WHERE tenant_id=${q(cleanupTenant)} AND owner_subject IN (${subjects});
        DELETE FROM app_private.principals WHERE tenant_id=${q(cleanupTenant)} AND subject IN (${subjects});
        DELETE FROM app_private.directory_memberships WHERE tenant_id=${q(cleanupTenant)} AND unit IN (${units});
        DELETE FROM app_private.directory_members WHERE tenant_id=${q(cleanupTenant)} AND unit IN (${units});
        DELETE FROM app_private.directory_groups WHERE tenant_id=${q(cleanupTenant)} AND unit IN (${units});
        DELETE FROM app_private.directory_units WHERE tenant_id=${q(cleanupTenant)} AND unit IN (${units});
        DELETE FROM app_private.directory_unit_types WHERE tenant_id=${q(cleanupTenant)} AND unit_type=${q(prefix)};
        COMMIT;`);
    } catch (error) { console.error(`cleanup of ${cleanupTenant} failed: ${error.message}`); }
  }
  try {
    await fixture.operatorToken();
    for (const id of clientIds) await fixture.admin(`clients/${id}`, undefined, "DELETE");
    for (const id of users) await fixture.admin(`users/${id}`, undefined, "DELETE");
    for (const groupTenant of ["tenant-a", "tenant-b"]) {
      const roots = await json(await fixture.admin(`groups?search=${groupTenant}&exact=true`), 200);
      const root = roots.find(group => group.path === `/${groupTenant}`);
      if (root) for (const group of await json(await fixture.admin(`groups/${root.id}/children`), 200)) {
        if ([unitA, unitB].includes(group.name)) await fixture.admin(`groups/${group.id}`, undefined, "DELETE");
      }
    }
  } catch (error) { console.error(`identity cleanup failed: ${error.message}`); }
});

test("catalog visibility: default hidden, tenant, units, applications and tenant isolation", { timeout: 180_000 }, async () => {
  await provisionDirectory([], { log: () => {} });
  await fixture.operatorToken();
  const [template] = await json(await fixture.admin(`clients?clientId=${tenant}`), 200);
  const { protocolMappers } = await json(await fixture.admin(`clients/${template.id}`), 200);
  for (const clientTenant of ["tenant-a", "tenant-b"]) {
    const mappers = structuredClone(protocolMappers);
    for (const mapper of mappers) delete mapper.id;
    mappers.find(mapper => mapper.name === "tenant").config["claim.value"] = clientTenant;
    const management = await fixture.admin("clients", {
      clientId: `${prefix}-management-${clientTenant}`, enabled: true, protocol: "openid-connect", publicClient: true,
      standardFlowEnabled: true, directAccessGrantsEnabled: false, redirectUris: [redirectUri],
      attributes: { "pkce.code.challenge.method": "S256" }, protocolMappers: mappers }, "POST");
    assert.equal(management.status, 201);
    clientIds.push(management.headers.get("location").split("/").at(-1));
  }
  owner = await fixture.human("owner", tenant, ["applications.register", "capabilities.write"]);
  administrator = await fixture.human("administrator", tenant,
    ["applications.approve", "trust.approve", "audit.read", "directory.write", "capabilities.approve"]);
  publisher = await fixture.human("publisher", tenant, ["capabilities.write", "capabilities.publish", "audit.read"]);
  userUnitA = await fixture.human("user-a", tenant, []);
  userUnitB = await fixture.human("user-b", tenant, []);
  foreignOwner = await fixture.human("foreign-owner", "tenant-b", ["applications.register"]);
  foreignAdmin = await fixture.human("foreign-admin", "tenant-b", ["applications.approve", "trust.approve"]);

  const put = (path, body) => api(`/v1/directory/${path}`, administrator, body, {}, "PUT").then(response => json(response, 201));
  await put(`unit-types/${prefix}`, { name: "Catalog visibility fixture" });
  await put(`units/${unitA}`, { name: "Unit A", unitType: prefix });
  await put(`units/${unitB}`, { name: "Unit B", unitType: prefix });
  await put(`units/${unitA}/members/${userUnitA.id}`, { groups: [] });
  await put(`units/${unitB}/members/${userUnitB.id}`, { groups: [] });

  // Membership in the unit group of the token puts unitA into the caller's
  // catalog context; userUnitB stays without a unit.
  const root = (await json(await fixture.admin(`groups?search=${tenant}&exact=true`), 200)).find(group => group.path === `/${tenant}`);
  const unitGroupA = (await json(await fixture.admin(`groups/${root.id}/children`), 200)).find(group => group.name === unitA);
  assert.ok(unitGroupA, "directory provisioning creates the Keycloak unit group");
  assert.equal((await fixture.admin(`users/${userUnitA.id}/groups/${unitGroupA.id}`, undefined, "PUT")).status, 204);
  userUnitA = { ...userUnitA, token: await fixture.login(userUnitA.username, userUnitA.password, userUnitA.clientId) };
  userUnitB = { ...userUnitB, token: await fixture.login(userUnitB.username, userUnitB.password, userUnitB.clientId) };

  provider = await fixture.backend("provider", owner, administrator);
  consumerA = await fixture.backend("consumer-a", owner, administrator);
  consumerB = await fixture.backend("consumer-b", owner, administrator);
  browserApp = await fixture.backend("browser", owner, administrator, tenant, true, undefined, redirectUri);
  foreignConsumer = await fixture.backend("foreign-consumer", foreignOwner, foreignAdmin, "tenant-b");
  capabilityId = `urn:junctura:capability:${provider.app.appId}:echo`;
  versionRoute = `/v1/capabilities/${encodeURIComponent(capabilityId)}/versions/1.0.0`;

  const applicationPath = `/v1/applications/${browserApp.app.appId}`;
  const original = await api(applicationPath, administrator);
  assert.equal(original.status, 200);
  const updated = await json(await api(applicationPath, administrator,
    { ownerUnit: unitA, deploymentUnits: [unitA, unitB] }, { "If-Match": original.headers.get("etag") }, "PATCH"), 200);
  assert.deepEqual([...updated.deploymentUnits].sort(), [unitA, unitB].sort());
  const assignment = await json(await api(`${applicationPath}/assignments`, administrator,
    { unit: unitA, targetType: "unit", target: unitA, role: "viewer" }), 200);
  assert.ok(assignment.synchronized, "the browser application assignment synchronizes inline");
  const tokenUrl = `${issuer}/protocol/openid-connect/token`;
  async function signIn(user) {
    const verifier = randomBytes(32).toString("base64url");
    const query = new URLSearchParams({ client_id: browserApp.app.oauthClientId, response_type: "code", scope: "openid",
      redirect_uri: redirectUri, code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url") });
    const auth = await fetch(tokenUrl.replace(/token$/, `auth?${query}`), { redirect: "manual" });
    assert.equal(auth.status, 200);
    const cookies = auth.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
    const form = (await auth.text()).match(/<form[^>]*action="([^"]+)"/); assert.ok(form);
    const signed = await fetch(form[1].replaceAll("&amp;", "&"), { method: "POST", redirect: "manual",
      headers: { Cookie: cookies, Accept: "text/html", "Accept-Language": "en" },
      body: new URLSearchParams({ username: user.username, password: user.password }) });
    assert.equal(signed.status, 302);
    const code = new URL(signed.headers.get("location")).searchParams.get("code"); assert.ok(code);
    const issued = await json(await fetch(tokenUrl, { method: "POST", body: new URLSearchParams({
      grant_type: "authorization_code", client_id: browserApp.app.oauthClientId, client_secret: browserApp.clientSecret,
      redirect_uri: redirectUri, code_verifier: verifier, code }) }), 200);
    return issued.access_token;
  }
  const tokenA = await signIn(userUnitA);

  const published = await publish();
  const managedRead = await api(versionRoute, publisher);
  assert.equal(managedRead.status, 200);
  const managed = await managedRead.json();
  cases.push({ schema: "CapabilityVersion", value: managed });
  assert.equal(managed.visibility, "hidden");
  assert.deepEqual(managed.visibilityUnits, []);
  assert.deepEqual(managed.visibilityApps, []);
  let etag = managedRead.headers.get("etag");

  // Default hidden: consumers, unit members and foreign callers see nothing.
  assert.deepEqual((await json(await api("/v1/capabilities", consumerA), 200)).items, []);
  assert.equal((await api(versionRoute, consumerA)).status, 404);
  assert.deepEqual((await json(await api("/v1/capabilities", userUnitA), 200)).items, []);
  assert.deepEqual((await json(await api("/v1/capabilities", foreignConsumer), 200)).items, []);
  assert.equal((await api(versionRoute, foreignConsumer)).status, 404);

  // Tenant exposure: everyone authorized inside the tenant sees the version.
  const setVisibility = (who, body, headers = {}) =>
    api(`${versionRoute}/visibility`, who, body, headers, "PUT");
  assert.equal((await setVisibility(publisher, { visibility: "tenant" })).status, 428);
  assert.equal((await setVisibility(publisher, { visibility: "tenant" },
    { "If-Match": '"capability-version-stale-1"' })).status, 412);
  const tenantSet = await setVisibility(publisher, { visibility: "tenant" }, { "If-Match": etag });
  assert.equal(tenantSet.status, 200, await tenantSet.clone().text());
  const tenantView = await tenantSet.json();
  assert.equal(tenantView.visibility, "tenant");
  assert.deepEqual(tenantView.visibilityUnits, []);
  assert.deepEqual(tenantView.visibilityApps, []);
  etag = tenantSet.headers.get("etag");
  cases.push({ schema: "CapabilityVersion", value: tenantView });
  const tenantItems = (await json(await api("/v1/capabilities", consumerA), 200)).items;
  assert.ok(tenantItems.some(item => item.capabilityId === capabilityId));
  const consumerRead = await api(versionRoute, consumerA);
  assert.equal(consumerRead.status, 200);
  const consumerVersion = await consumerRead.json();
  cases.push({ schema: "CapabilityVersion", value: consumerVersion });
  for (const concealed of ["createdBy", "updatedBy", "validation", "visibility", "visibilityUnits", "visibilityApps"]) {
    assert.equal(Object.hasOwn(consumerVersion, concealed), false, concealed);
  }
  assert.ok((await json(await api("/v1/capabilities", userUnitA), 200)).items.some(item => item.capabilityId === capabilityId));
  assert.ok((await json(await api("/v1/capabilities", userUnitB), 200)).items.some(item => item.capabilityId === capabilityId));

  // Units exposure: only callers whose token groups name unitA see it.
  const unitsSet = await setVisibility(publisher, { visibility: "units", units: [unitA] }, { "If-Match": etag });
  assert.equal(unitsSet.status, 200, await unitsSet.clone().text());
  const unitsView = await unitsSet.json();
  assert.equal(unitsView.visibility, "units");
  assert.deepEqual(unitsView.visibilityUnits, [unitA]);
  etag = unitsSet.headers.get("etag");
  cases.push({ schema: "CapabilityVersion", value: unitsView });
  assert.ok((await json(await api("/v1/capabilities", userUnitA), 200)).items.some(item => item.capabilityId === capabilityId));
  assert.equal((await json(await api("/v1/capabilities", userUnitB), 200)).items.some(item => item.capabilityId === capabilityId), false);
  assert.equal((await json(await api("/v1/capabilities", consumerA), 200)).items.some(item => item.capabilityId === capabilityId), false);
  assert.equal((await setVisibility(publisher, { visibility: "units", units: ["absent-unit-x"] },
    { "If-Match": etag })).status, 404);
  assert.equal((await setVisibility(publisher, { visibility: "tenant", units: [unitA] },
    { "If-Match": etag })).status, 400);

  // Applications exposure: only the designated consumer application sees it.
  const appsSet = await setVisibility(publisher,
    { visibility: "applications", applications: [consumerA.app.appId] }, { "If-Match": etag });
  assert.equal(appsSet.status, 200, await appsSet.clone().text());
  const appsView = await appsSet.json();
  assert.deepEqual(appsView.visibilityApps, [consumerA.app.appId]);
  etag = appsSet.headers.get("etag");
  cases.push({ schema: "CapabilityVersion", value: appsView });
  assert.ok((await json(await api("/v1/capabilities", consumerA), 200)).items.some(item => item.capabilityId === capabilityId));
  assert.equal((await api(versionRoute, consumerA)).status, 200);
  assert.equal((await json(await api("/v1/capabilities", consumerB), 200)).items.some(item => item.capabilityId === capabilityId), false);
  assert.equal((await api(versionRoute, consumerB)).status, 404);
  assert.equal((await json(await api("/v1/capabilities", userUnitA), 200)).items.some(item => item.capabilityId === capabilityId), false);
  assert.equal((await setVisibility(publisher,
    { visibility: "applications", applications: ["99999999-9999-4999-8999-999999999999"] },
    { "If-Match": etag })).status, 404);
  assert.equal((await setVisibility(userUnitA, { visibility: "hidden" },
    { "If-Match": etag })).status, 403, "catalog members cannot change exposure");

  // Consumer cursors stay bound to tenant and calling application; pagination
  // coverage itself lives in the capability registry suite.
  const pageOne = await api("/v1/capabilities?limit=1", consumerA);
  const cursor = (await pageOne.json()).nextCursor;
  if (cursor) {
    assert.equal((await api(`/v1/capabilities?limit=1&cursor=${cursor}`, consumerB)).status, 400);
    assert.equal((await api(`/v1/capabilities?limit=1&cursor=${cursor}`, foreignConsumer)).status, 400);
  }

  // Denial keeps its contract: a user calling through an assigned application
  // cannot browse the catalog and the refusal is audited with its request id.
  const denied = await api("/v1/capabilities", { token: tokenA });
  const denialBody = await json(denied, 403);
  assert.deepEqual(Object.keys(denialBody).sort(), ["error", "requestId"]);
  assert.equal(denialBody.error, "capability_not_granted");
  assert.equal(denialBody.requestId, denied.headers.get("x-request-id"));
  const auditItems = (await json(await api("/v1/audit-events?limit=100", administrator), 200)).items;
  const denialRows = auditItems.filter(row => row.event === "authorization.denied" && row.outcome === "denied" &&
    row.managementClient === browserApp.app.oauthClientId && row.subject === userUnitA.id);
  assert.equal(denialRows.length, 1);
  assert.equal(denialRows[0].reasonCode, "capability_not_granted");
  assert.equal(denialRows[0].reason, denialBody.requestId);

  // Every exposure change is audited with its level and actor.
  const changedRows = auditItems.filter(row => row.event === "capability.visibility_changed" &&
    row.managementClient === publisher.clientId);
  assert.deepEqual(changedRows.map(row => row.reasonCode).sort(), ["applications", "tenant", "units"].sort());
  for (const row of changedRows) {
    assert.equal(row.outcome, "success");
    assert.equal(row.subject, publisher.id);
    assert.equal(row.resourceType, "capability");
  }

  // Back to hidden clears the designations and revokes catalog exposure.
  const hiddenSet = await setVisibility(publisher, { visibility: "hidden" }, { "If-Match": etag });
  assert.equal(hiddenSet.status, 200, await hiddenSet.clone().text());
  const hiddenView = await hiddenSet.json();
  assert.equal(hiddenView.visibility, "hidden");
  assert.deepEqual(hiddenView.visibilityUnits, []);
  assert.deepEqual(hiddenView.visibilityApps, []);
  etag = hiddenSet.headers.get("etag");
  cases.push({ schema: "CapabilityVersion", value: hiddenView });
  assert.equal((await json(await api("/v1/capabilities", consumerA), 200)).items.some(item => item.capabilityId === capabilityId), false);
  assert.equal((await api(versionRoute, consumerA)).status, 404);
  const afterRead = await api(versionRoute, publisher);
  assert.equal(afterRead.status, 200);
  assert.equal(afterRead.headers.get("etag"), etag);

  await verifyContracts("catalog-visibility", cases, "--capability-runtime");
});
