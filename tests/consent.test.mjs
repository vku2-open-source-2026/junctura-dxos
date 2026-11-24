// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { after, before, mock, test } from "node:test";
import { createApi } from "../src/api.mjs";
import { handleConsent, isConsentPath } from "../src/modules/consent/consent.mjs";
import { validateExecutionContext } from "../src/modules/capability/execution/execution.mjs";
import { HttpError, json } from "../src/platform/http/http.mjs";

const CONSENT = "dcf6b718-7d02-41cc-8a2b-bb4aa9026d71";
const EXECUTION = "aaaaaaaa-0000-4000-8000-000000000005";
let identity = { tenantId: "tenant-a", subject: "subject-1", issuer: "https://id.example", clientId: "portal", roles: ["core-reader"], subjectId: "person-1" };
let reply = () => ({ status: 200, value: { consents: [] } });
let seen = [];
const config = { dataUrl: "https://data.example.invalid", dataSecret: "x".repeat(32) };
before(() => {
  mock.method(globalThis, "fetch", async (url, options) => {
    const body = JSON.parse(options.body);
    const claims = JSON.parse(Buffer.from(options.headers.Authorization.split(".")[1], "base64url"));
    seen.push({ url: new URL(url).pathname, body, role: claims.role, sub: claims.sub, subjectId: claims.subject_id,
      actor: claims.actor_sub, unit: claims.resource_unit, app: claims.human_app_id });
    const value = reply(body);
    return value === "down" ? new Response(null, { status: 503 }) : Response.json(value);
  });
});
after(() => mock.restoreAll());
async function call(path, method = "GET", body, headers = body === undefined ? {} : { "content-type": "application/json" }) {
  const bytes = body === undefined ? [] : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))];
  const request = Object.assign(Readable.from(bytes), { method, headers });
  const outgoing = new Headers();
  let result;
  const response = {
    setHeader: (name, value) => outgoing.set(name, value),
    writeHead(status, values) {
      this.status = status;
      for (const [name, value] of Object.entries(values)) outgoing.set(name, value);
    },
    end(value) { result = new Response(value, { status: this.status, headers: outgoing }); },
  };
  try { await handleConsent(request, response, identity, config, new URL(path, "http://core")); }
  catch (error) { json(response, error instanceof HttpError ? error.status : 500, { error: error.message }); }
  return result;
}

test("consent routes are recognised exactly and the API module loads them", () => {
  for (const path of ["/v1/me/consents", `/v1/me/consents/${CONSENT}/revoke`, "/v1/emergency-accesses", `/v1/emergency-accesses/${EXECUTION}/review`]) assert.ok(isConsentPath(path), path);
  for (const path of ["/v1/me/data-access", "/v1/me", "/v1/emergency", undefined]) assert.equal(isConsentPath(path), false, String(path));
  assert.equal(typeof createApi, "function");
  assert.throws(() => validateExecutionContext({ purpose: "review", dataSubjectKind: "canonical" }), /invalid_execution_context/);
  assert.doesNotThrow(() => validateExecutionContext({ purpose: "review", dataSubject: "person-1", dataSubjectKind: "canonical" }));
});

test("people list, create and revoke only their own consents through the subject role", async () => {
  seen = [];
  assert.equal((await call("/v1/me/consents")).status, 200);
  const proposal = { consumerAppId: "11111111-1111-4111-8111-111111111111", capabilityId: "urn:junctura:capability:22222222-2222-4222-8222-222222222222:vaccination", purposes: ["review"], expiresAt: "2026-12-01T00:00:00.000Z" };
  reply = () => ({ status: 201, value: { consentId: CONSENT, state: "active" } });
  const created = await call("/v1/me/consents", "POST", proposal,
    { "content-type": "application/json", "idempotency-key": "11111111-1111-4111-8111-111111111111" });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get("location"), `/v1/me/consents/${CONSENT}`);
  assert.equal(created.headers.get("cache-control"), "no-store");
  assert.equal((await call("/v1/me/consents", "POST", proposal)).status, 400, "the key is required for grants");
  reply = () => ({ status: 200, value: { consentId: CONSENT, state: "revoked" } });
  assert.equal((await call(`/v1/me/consents/${CONSENT}/revoke`, "POST", {})).status, 200);
  assert.deepEqual(seen.map(item => [item.url, item.role, item.sub, item.subjectId, item.body.operation]), [
    ["/rpc/subject_consent", "junctura_subject_api", "subject-1", "person-1", "list"],
    ["/rpc/subject_consent", "junctura_subject_api", "subject-1", "person-1", "create"],
    ["/rpc/subject_consent", "junctura_subject_api", "subject-1", "person-1", "revoke"],
  ]);
  assert.deepEqual(seen[1].body.payload.consent, proposal);
  assert.equal(seen[1].body.payload.key, "11111111-1111-4111-8111-111111111111");
  assert.match(seen[1].body.payload.digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(seen[2].body.payload, { consentId: CONSENT });
});

test("consent requests are strict and failures stay closed", async () => {
  assert.equal((await call("/v1/me/consents?subject=other")).status, 400);
  assert.equal((await call("/v1/me/consents", "POST", '{"purposes":["a"],"purposes":["b"]}')).status, 400, "duplicate keys");
  assert.equal((await call("/v1/me/consents", "POST", "[]")).status, 400);
  assert.equal((await call("/v1/me/consents", "POST", "{}", {})).status, 415);
  assert.equal((await call("/v1/me/consents/not-a-uuid/revoke", "POST", {})).status, 400);
  assert.equal((await call(`/v1/me/consents/${CONSENT}/revoke`, "POST", { reason: "x" })).status, 400);
  assert.equal((await call("/v1/me/consents", "DELETE")).status, 405);
  reply = () => ({ status: 404, error: "not_found" });
  const refused = await call("/v1/me/consents", "POST",
    { consumerAppId: "11111111-1111-4111-8111-111111111111", capabilityId: "urn:junctura:capability:22222222-2222-4222-8222-222222222222:vaccination", purposes: ["review"], expiresAt: "2026-12-01T00:00:00.000Z" },
    { "content-type": "application/json", "idempotency-key": "11111111-1111-4111-8111-111111111111" });
  assert.equal(refused.status, 404);
  reply = () => "down";
  assert.equal((await call("/v1/me/consents")).status, 503);
});

test("legacy consent callers reach the subject RPC using only their own login", async () => {
  seen = [];
  identity = { ...identity, subjectId: undefined };
  reply = ({ operation }) => ({ status: 200, value: operation === "list" ? { consents: [] } : { consentId: CONSENT } });
  assert.equal((await call("/v1/me/consents")).status, 200);
  assert.equal((await call(`/v1/me/consents/${CONSENT}/revoke`, "POST", {})).status, 200);
  assert.deepEqual(seen.map(({ sub, subjectId }) => [sub, subjectId]), [["subject-1", undefined], ["subject-1", undefined]]);
});

test("emergency reviews use the trust role and need a writer to decide", async () => {
  seen = [];
  identity = { ...identity, subject: "admin", clientId: "management" };
  reply = () => ({ status: 200, value: { reviews: [] } });
  assert.equal((await call("/v1/emergency-accesses")).status, 200);
  assert.equal((await call(`/v1/emergency-accesses/${EXECUTION}/review`, "POST", { decision: "justified", note: "ok" })).status, 403, "readers cannot decide");
  identity = { ...identity, roles: ["core-reader", "core-writer"] };
  reply = () => ({ status: 200, value: { executionId: EXECUTION, state: "justified" } });
  assert.equal((await call(`/v1/emergency-accesses/${EXECUTION}/review`, "POST", { decision: "justified", note: "Đã xác minh" })).status, 200);
  assert.equal((await call(`/v1/emergency-accesses/${EXECUTION}/review`, "POST", { decision: "justified" })).status, 400);
  assert.deepEqual(seen.map(item => [item.role, item.body.operation]), [["junctura_trust_api", "list"], ["junctura_trust_api", "review"]]);
  assert.deepEqual(seen[1].body.payload, { executionId: EXECUTION, decision: "justified", note: "Đã xác minh" });
});

test("emergency context needs a subject and a justification", () => {
  assert.ok(validateExecutionContext({ purpose: "emergency_care", dataSubject: "p", emergency: true, justification: "Tình huống khẩn cấp" }));
  for (const context of [{ purpose: "emergency_care", emergency: true, justification: "Tình huống khẩn cấp" },
    { purpose: "emergency_care", dataSubject: "p", emergency: true }, { purpose: "emergency_care", dataSubject: "p", justification: "Tình huống khẩn cấp" },
    { purpose: "emergency_care", dataSubject: "p", emergency: false, justification: "Tình huống khẩn cấp" },
    { purpose: "emergency_care", dataSubject: "p", emergency: true, justification: "short" }]) {
    assert.throws(() => validateExecutionContext(context), error => error.status === 422, JSON.stringify(context));
  }
});

test("resource consent requests carry the verified unit and keep subject decisions on the subject role", async () => {
  seen = [];
  const sender = "/v1/resource-consent-requests";
  const subject = "/v1/me/resource-consent-requests";
  const proposal = { resourceType: "record", resourceId: CONSENT, purpose: "Review the selected record", expiresAt: "2030-01-01T00:00:00Z" };
  const login = { ...identity, subject: "subject-1", subjectId: "person-1", roles: ["core-reader"] };
  const delegated = { ...login, actor: { sub: "service-1" }, humanAppId: CONSENT, resourceUnit: "unit-b" };
  assert.ok(isConsentPath(sender));
  assert.ok(isConsentPath(`${subject}/${EXECUTION}/accept`));
  reply = ({ operation }) => ({ status: operation === "create" ? 201 : 200, value: { requestId: EXECUTION } });
  identity = login;
  assert.equal((await call(sender, "POST", proposal)).status, 403);
  identity = delegated;
  assert.equal((await call(subject)).status, 403);
  assert.equal((await call(sender, "POST", { ...proposal, recipientUnit: "unit-a" })).status, 400);
  assert.equal((await call(sender, "POST", { ...proposal, expiresAt: undefined })).status, 400);
  assert.equal((await call(`${sender}/${EXECUTION}/accept`, "POST", {})).status, 404);
  assert.equal((await call(`${sender}/${EXECUTION}/get`)).status, 404);
  const submitted = await call(sender, "POST", proposal);
  assert.equal(submitted.status, 201);
  assert.equal(submitted.headers.get("location"), `${sender}/${EXECUTION}`);
  assert.equal(submitted.headers.get("cache-control"), "no-store");
  assert.equal((await call(`${sender}/${EXECUTION}`)).status, 200);
  const ok = reply;
  reply = () => ({ status: 409, error: "consent_request_not_pending" });
  const conflict = await call(`${sender}/${EXECUTION}/cancel`, "POST", {});
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: "consent_request_not_pending" });
  reply = ok;
  identity = login;
  assert.equal((await call(subject)).status, 200);
  assert.equal((await call(`${subject}/${EXECUTION}/accept`, "POST", { reason: "Unexpected" })).status, 400);
  assert.equal((await call(`${subject}/${EXECUTION}/accept`, "POST", {})).status, 200);
  assert.equal((await call(`${subject}/${EXECUTION}/decline`, "POST", { reason: "   " })).status, 400);
  assert.equal((await call(`${subject}/${EXECUTION}/decline`, "POST", { reason: "A shorter duration would work" })).status, 200);
  assert.ok(seen.every(entry => entry.url === "/rpc/resource_consent_request_command"));
  assert.deepEqual(seen.map(({ role, actor, unit, app, body }) => [role, actor, unit, app, body.operation]), [
    ...["create", "get", "cancel"].map(operation => ["junctura_resource_api", "service-1", "unit-b", CONSENT, operation]),
    ...["list", "accept", "decline"].map(operation => ["junctura_subject_api", undefined, undefined, undefined, operation]),
  ]);
  assert.deepEqual(seen[0].body.payload, proposal);
  assert.deepEqual(seen.at(-1).body.payload, { requestId: EXECUTION, reason: "A shorter duration would work" });
});
