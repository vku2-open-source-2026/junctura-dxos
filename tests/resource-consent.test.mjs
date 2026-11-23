// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { readResourceConsent } from "../src/modules/consent/consent.mjs";
import { requestIdFor } from "../src/platform/http/http.mjs";

test("the exact reader checks consent only with an exchanged identity and preserves policy refusals", async (t) => {
  const config = { dataUrl: "http://data.test", dataSecret: "test-key" };
  const request = { headers: {} };
  const identity = { tenantId: "tenant-a", issuer: "issuer", subject: "reader", clientId: "app", roles: ["core-reader"],
    humanAppId: randomUUID(), resourceUnit: "recipient" };
  const target = { kind: "record", id: randomUUID(), collection: "items" };
  let result;
  const fetcher = t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.match(url, /\/rpc\/resource_consent_read/);
    const claims = JSON.parse(Buffer.from(options.headers.Authorization.split(".")[1], "base64url"));
    assert.equal(claims.role, "junctura_resource_api");
    assert.equal(claims.actor_sub, "app-service");
    assert.equal(claims.resource_unit, "recipient");
    assert.equal(claims.sub, "reader");
    assert.deepEqual(JSON.parse(options.body), { payload: { ...target, requestId: requestIdFor(request) } });
    return Response.json(result);
  });
  assert.equal(await readResourceConsent(request, config, identity, target), null);
  assert.equal(fetcher.mock.callCount(), 0);

  const delegated = { ...identity, actor: { sub: "app-service" } };
  result = { status: 200, value: { id: target.id } };
  assert.deepEqual(await readResourceConsent(request, config, delegated, target), result);
  for (const code of ["consent_revoked", "consent_expired", "unit_mismatch", "not_assigned_to_app"]) {
    result = { status: 403, error: code };
    await assert.rejects(readResourceConsent(request, config, delegated, target), { status: 403, message: code });
  }
  result = { status: 404, error: "not_found" };
  assert.equal(await readResourceConsent(request, config, delegated, target), null);
});
