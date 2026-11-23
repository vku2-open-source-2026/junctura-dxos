// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { contractFetch, verifyContracts } from "./contract.mjs";

const env = name => {
  const value = process.env[`APP_ACCESS_TEST_${name}`];
  assert.ok(value, `Missing APP_ACCESS_TEST_${name} for the isolated app-access fixture`);
  return value;
};

test("application management, provider login, unit isolation, audit, and OIDC key rotation", async () => {
  const base = env("BASE").replace(/\/$/, "");
  const admin = env("ADMIN_TOKEN");
  const appId = env("APP_ID");
  const secret = env("CLIENT_SECRET");
  const unitA = env("UNIT_A");
  const unitB = env("UNIT_B");
  const groupB = env("GROUP_B");
  const userA = { username: env("USER_A"), password: env("PASSWORD_A"), subject: env("SUBJECT_A") };
  const userB = { username: env("USER_B"), password: env("PASSWORD_B"), subject: env("SUBJECT_B") };
  const redirectUri = env("REDIRECT_URI");
  const path = `/v1/applications/${appId}`;
  const call = (route, { token = admin, method = "GET", body, headers } = {}) => contractFetch(base + route, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(25_000),
  });
  async function json(response, status) {
    assert.equal(response.status, status);
    return response.json();
  }
  const original = await call(path);
  const registered = await json(original, 200);
  const displayName = `App X ${randomBytes(4).toString("hex")}`;
  const metadata = { displayName, ownerUnit: unitA, deploymentUnits: [unitA, unitB] };
  assert.equal((await call(path, { method: "PATCH", body: metadata })).status, 428);
  const update = { method: "PATCH", body: metadata, headers: { "If-Match": original.headers.get("etag") } };
  const updated = await json(await call(path, update), 200);
  assert.equal(updated.displayName, displayName);
  assert.equal(updated.ownerUnit, unitA);
  assert.deepEqual([...updated.deploymentUnits].sort(), [unitA, unitB].sort());
  assert.equal(updated.revision, registered.revision + 1);
  assert.equal((await call(path, update)).status, 412);
  const filtered = new URLSearchParams({ q: displayName.toLowerCase(), unit: unitB, state: "active", limit: "1" });
  const listed = await json(await call(`/v1/applications?${filtered}`), 200);
  assert.deepEqual(listed.items.map(item => item.appId), [appId]);
  assert.equal(listed.nextCursor, null);
  const first = await json(await call("/v1/applications?limit=1"), 200);
  assert.ok(first.nextCursor, "fixture tenant must contain another app for pagination");
  const next = await json(await call(`/v1/applications?limit=1&cursor=${first.nextCursor}`), 200);
  assert.notEqual(first.items[0].appId, next.items[0].appId);

  const tokenUrl = `${base}/identity/realms/junctura/protocol/openid-connect/token`;
  const clientId = registered.oauthClientId;
  const consoleDenied = await fetch(tokenUrl, { method: "POST", headers: { "Accept-Language": "en" },
    body: new URLSearchParams({ grant_type: "password", client_id: "junctura-console",
      username: userA.username, password: userA.password }) });
  assert.equal(consoleDenied.status, 401);
  assert.match(await consoleDenied.text(), /data-error-code="not_assigned_to_app"/);
  async function signIn(user, allowed) {
    const verifier = randomBytes(32).toString("base64url");
    const query = new URLSearchParams({ client_id: clientId, response_type: "code", scope: "openid",
      redirect_uri: redirectUri, code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url") });
    const auth = await fetch(tokenUrl.replace(/token$/, `auth?${query}`), { redirect: "manual" });
    assert.equal(auth.status, 200);
    const cookies = auth.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
    const form = (await auth.text()).match(/<form[^>]*action="([^"]+)"/);
    assert.ok(form);
    const signed = await fetch(form[1].replaceAll("&amp;", "&"), { method: "POST", redirect: "manual",
      headers: { Cookie: cookies, "Accept-Language": "en" },
      body: new URLSearchParams({ username: user.username, password: user.password }) });
    if (!allowed) {
      assert.equal(signed.status, 401);
      assert.match(await signed.text(), /data-error-code="not_assigned_to_app"/);
      return;
    }
    assert.equal(signed.status, 302);
    const code = new URL(signed.headers.get("location")).searchParams.get("code");
    assert.ok(code);
    const issued = await json(await fetch(tokenUrl, { method: "POST", body: new URLSearchParams({
      grant_type: "authorization_code", client_id: clientId, client_secret: secret,
      redirect_uri: redirectUri, code_verifier: verifier, code,
    }) }), 200);
    assert.ok(issued.access_token);
    assert.equal(issued.refresh_token, undefined);
    return issued.access_token;
  }

  await signIn(userA, false);
  const assign = body => call(`${path}/assignments`, { method: "POST", body }).then(r => json(r, 200));
  const revoke = id => call(`${path}/assignments/${id}`, { method: "DELETE" });
  const a = await assign({ unit: unitA, targetType: "unit", target: unitA, role: "manager" });
  const b = await assign({ unit: unitB, targetType: "group", target: groupB, role: "viewer" });
  const subject = await assign({ unit: unitB, targetType: "subject", target: userB.subject, role: "editor" });
  assert.equal((await assign({ unit: unitA, targetType: "unit", target: unitA, role: "manager" })).assignmentId, a.assignmentId);
  assert.ok(a.synchronized && b.synchronized && subject.synchronized);
  assert.equal((await json(await call(`${path}/assignments`), 200)).items.length, 3);

  const tokenA = await signIn(userA, true);
  const tokenB = await signIn(userB, true);
  assert.deepEqual((await json(await call("/v1/identity", { token: tokenA }), 200)).units, [unitA]);
  assert.deepEqual((await json(await call("/v1/identity", { token: tokenB }), 200)).units, [unitB]);
  const collection = `scope_${randomBytes(5).toString("hex")}`;
  const recordPath = `/v2/data/${collection}`;
  const definition = { schema: { type: "object", properties: { label: { type: "string" } }, required: ["label"] } };
  assert.equal((await call(`/v2/data-schemas/${collection}`, { token: tokenA, method: "PUT", body: definition })).status, 201);
  const insert = (token, label) => call(recordPath, { token, method: "POST", body: { data: { label } },
    headers: { "Idempotency-Key": randomUUID() } });
  const recordA = await json(await insert(tokenA, "A"), 201);
  const recordB = await json(await insert(tokenB, "B"), 201);
  assert.notEqual(recordA.id, recordB.id);
  const auditReasons = [];
  const fixtureSubjects = [userA.subject, userB.subject];
  const accessDenials = async () => (await json(await call("/v1/audit-events?limit=100"), 200)).items
    .filter(row => row.event === "authorization.denied" && row.outcome === "denied" &&
      row.managementClient === clientId && fixtureSubjects.includes(row.subject));
  const previousDenials = new Set((await accessDenials()).map(row => row.eventId));
  async function denial(response, code) {
    const body = await json(response, 403);
    assert.deepEqual(Object.keys(body).sort(), ["error", "requestId"]);
    assert.equal(body.error, code);
    assert.equal(body.requestId, response.headers.get("x-request-id"));
    auditReasons.push(body);
  }
  await denial(await call(`${recordPath}/${recordB.id}`, { token: tokenA }), "unit_mismatch");
  assert.deepEqual((await json(await call(recordPath, { token: tokenA }), 200)).items.map(item => item.id), [recordA.id]);
  assert.deepEqual((await json(await call(recordPath, { token: tokenB }), 200)).items.map(item => item.id), [recordB.id]);

  assert.equal((await revoke(subject.assignmentId)).status, 204);
  await denial(await insert(tokenB, "B2"), "capability_not_granted");
  assert.equal((await revoke(a.assignmentId)).status, 204);
  await denial(await call("/v1/identity", { token: tokenA }), "not_assigned_to_app");
  await signIn(userA, false);
  assert.equal((await revoke(a.assignmentId)).status, 204);
  assert.equal((await revoke(b.assignmentId)).status, 204);
  const denials = (await accessDenials()).filter(row => !previousDenials.has(row.eventId));
  const byRequestId = (a, b) => a.requestId.localeCompare(b.requestId);
  assert.deepEqual(denials.map(row => ({ error: row.reasonCode, requestId: row.reason })).sort(byRequestId),
    auditReasons.sort(byRequestId));

  const history = await json(await call(`${path}/oidc-keys`), 200);
  const rotationId = randomUUID();
  const rotate = { method: "POST", body: {}, headers: { "Idempotency-Key": rotationId } };
  const rotated = await json(await call(`${path}/oidc-keys`, rotate), 200);
  assert.deepEqual((await json(await call(`${path}/oidc-keys`, rotate), 200)).items, rotated.items);
  assert.equal(rotated.items[0].rotationId, rotationId);
  assert.ok(rotated.items[0].appliedAt);
  assert.ok(!JSON.stringify(rotated).includes(secret));
  assert.ok(!history.items.some(item => item.rotationId === rotationId));
  const old = await fetch(tokenUrl, { method: "POST", body: new URLSearchParams({
    grant_type: "client_credentials", client_id: clientId, client_secret: secret,
  }) });
  assert.equal(old.status, 401);
  await verifyContracts("app-access");
});
