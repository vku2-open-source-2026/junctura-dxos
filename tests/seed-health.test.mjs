// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createHealthClient, ensureHealthRelations, fetchClientToken, seedHealth } from "../scripts/seed-health.mjs";
import {
  HEALTH_APPS,
  HEALTH_CAPABILITIES,
  HEALTH_RELATIONS,
  generateHealthDataset,
  objectIdFor,
} from "../scripts/lib/seed-health-data.mjs";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function bodyOf(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function fakeStack({ clientId = "app-so-suc-khoe", clientSecret = "synthetic-secret" } = {}) {
  const records = new Map();
  const objects = new Map();
  const tokenRequests = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const json = (status, value) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.method === "POST" && url.pathname === "/identity/realms/junctura/protocol/openid-connect/token") {
      const form = new URLSearchParams((await bodyOf(request)).toString("utf8"));
      tokenRequests.push(Object.fromEntries(form));
      if (form.get("grant_type") !== "client_credentials" || form.get("client_id") !== clientId || form.get("client_secret") !== clientSecret) {
        return json(401, { error: "invalid_client" });
      }
      return json(200, { access_token: "synthetic-token", token_type: "Bearer" });
    }
    if (request.headers.authorization !== "Bearer synthetic-token") return json(401, { error: "unauthorized" });
    const collection = url.pathname.match(/^\/v2\/data\/([a-z][a-z0-9_-]{0,62})$/)?.[1];
    if (collection && request.method === "GET") return json(200, { items: records.get(collection) ?? [] });
    if (collection && request.method === "POST") {
      const parsed = JSON.parse((await bodyOf(request)).toString("utf8"));
      if (!parsed.data || typeof parsed.data !== "object") return json(400, { error: "data_object_required" });
      const row = { id: randomUUID(), collection, data: parsed.data, created_at: new Date().toISOString() };
      records.set(collection, [...(records.get(collection) ?? []), row]);
      return json(201, row);
    }
    const objectId = url.pathname.match(/^\/v2\/objects\/([0-9a-f-]+)$/)?.[1];
    if (objectId && request.method === "PUT") {
      if (request.headers["content-type"] !== "application/octet-stream") return json(415, { error: "binary_required" });
      const bytes = await bodyOf(request);
      if (bytes.toString("utf8").includes("EICAR-STANDARD-ANTIVIRUS-TEST-FILE")) {
        return json(422, { error: "malware_detected" });
      }
      const created = !objects.has(objectId);
      objects.set(objectId, bytes);
      return json(created ? 201 : 200, { id: objectId, size: bytes.length });
    }
    return json(404, { error: "not_found" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    records,
    objects,
    tokenRequests,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

function healthAppsFixture() {
  const apps = {};
  for (const app of HEALTH_APPS) {
    apps[app.name] = {
      appId: `app-${app.name}`,
      subject: `subject-${app.name}`,
      token: `token-${app.name}`,
    };
  }
  return apps;
}

function healthPublishedFixture(apps) {
  const published = {};
  for (const capability of HEALTH_CAPABILITIES) {
    const appId = apps[capability.app].appId;
    published[`${capability.app}/${capability.name}`] = {
      capabilityId: `urn:junctura:capability:${appId}:${capability.name}`,
      version: "1.0.0",
      digest: `digest-${capability.name}`,
      manifest: {
        title: capability.title,
        requiredPermissions: [`urn:junctura:permission:${appId}:invoke`],
      },
    };
  }
  return published;
}

async function fakeTrustStack() {
  const grants = [];
  const calls = [];
  let next = 1;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const json = (status, value, headers = {}) => {
      response.writeHead(status, { "Content-Type": "application/json", ...headers });
      response.end(JSON.stringify(value));
    };
    const auth = request.headers.authorization;
    const payload = async () => JSON.parse((await bodyOf(request)).toString("utf8"));
    if (request.method === "GET" && url.pathname === "/v1/trust/graph") {
      if (auth !== "Bearer approver-token") return json(403, { error: "forbidden" });
      return json(200, { edges: grants.map(grant => ({ ...grant })) });
    }
    if (request.method === "POST" && url.pathname === "/v1/trust/grants") {
      if (auth !== "Bearer owner-token") return json(403, { error: "forbidden" });
      const value = await payload();
      calls.push({ path: url.pathname, auth, body: value });
      if (!value.providerAppId || !value.consumerAppId || !Array.isArray(value.capabilities)) {
        return json(400, { error: "invalid_grant" });
      }
      const grantId = `grant-${next++}`;
      const grant = {
        grantId,
        digest: `digest-${grantId}`,
        revision: 1,
        state: "pending",
        providerAppId: value.providerAppId,
        consumerAppId: value.consumerAppId,
        capabilityId: value.capabilities[0].capabilityId,
        version: value.capabilities[0].version,
        subjectIds: value.subjectIds,
      };
      grants.push(grant);
      return json(201, { grantId, digest: grant.digest, revision: 1 }, { ETag: `"${grantId}-1"` });
    }
    if (request.method === "POST" && url.pathname === "/v1/approvals") {
      if (auth !== "Bearer approver-token") return json(403, { error: "forbidden" });
      const value = await payload();
      calls.push({ path: url.pathname, auth, body: value });
      if (value.resourceType !== "grant" || !value.resourceId || !value.requesterSubject) {
        return json(400, { error: "invalid_approval" });
      }
      return json(201, { approvalId: `approval-${value.resourceId}` });
    }
    const activation = url.pathname.match(/^\/v1\/trust\/grants\/([^/]+)\/activate$/);
    if (request.method === "POST" && activation) {
      if (auth !== "Bearer approver-token") return json(403, { error: "forbidden" });
      const grant = grants.find(value => value.grantId === activation[1]);
      if (!grant) return json(404, { error: "not_found" });
      if (request.headers["if-match"] !== `"${grant.grantId}-1"`) return json(412, { error: "stale" });
      const value = await payload();
      calls.push({ path: url.pathname, auth, body: value });
      if (!value.approvalId) return json(400, { error: "approval_required" });
      grant.state = "active";
      return json(200, { ...grant }, { ETag: `"${grant.grantId}-2"` });
    }
    return json(404, { error: "not_found" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    grants,
    calls,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

test("the synthetic health dataset is deterministic, bounded, referentially valid and unique", () => {
  const first = generateHealthDataset();
  const second = generateHealthDataset();
  assert.deepEqual(first, second);
  for (const collection of ["benh-nhan", "chuyen-tuyen", "don-thuoc"]) {
    assert.ok(first[collection].length >= 30 && first[collection].length <= 50, `${collection} count`);
  }
  const patientCodes = new Set(first["benh-nhan"].map(row => row.ma_benh_nhan));
  const referralCodes = new Set(first["chuyen-tuyen"].map(row => row.ma_chuyen_tuyen));
  const prescriptionCodes = new Set(first["don-thuoc"].map(row => row.ma_don_thuoc));
  assert.equal(patientCodes.size, first["benh-nhan"].length);
  assert.equal(referralCodes.size, first["chuyen-tuyen"].length);
  assert.equal(prescriptionCodes.size, first["don-thuoc"].length);
  for (const referral of first["chuyen-tuyen"]) {
    assert.ok(patientCodes.has(referral.ma_benh_nhan));
    assert.equal(typeof referral.chan_doan, "string");
  }
  for (const prescription of first["don-thuoc"]) {
    assert.ok(patientCodes.has(prescription.ma_benh_nhan));
    assert.ok(referralCodes.has(prescription.ma_chuyen_tuyen));
    assert.ok(prescription.thuoc.length >= 1 && prescription.thuoc.length <= 3);
  }
  const documentIds = first.documents.map(document => document.id);
  assert.equal(new Set(documentIds).size, documentIds.length);
  for (const document of first.documents) {
    assert.match(document.id, uuid);
    const referral = first["chuyen-tuyen"].find(row => row.tai_lieu === document.id);
    assert.ok(referral, "document is linked from a referral");
    assert.ok(document.content.includes(referral.ma_chuyen_tuyen));
    assert.equal(document.id, objectIdFor(document.key));
  }
  const different = generateHealthDataset({ seed: 7 });
  assert.notDeepEqual(different["benh-nhan"], first["benh-nhan"]);
});

test("dataset validation rejects counts outside the 30-50 scenario range", () => {
  assert.throws(() => generateHealthDataset({ patients: 29 }), /patients count/);
  assert.throws(() => generateHealthDataset({ referrals: 51 }), /referrals count/);
  assert.throws(() => generateHealthDataset({ documents: 99 }), /documents/);
});

test("client credentials and API seeding work against a fake stack and are idempotent", async () => {
  const stack = await fakeStack();
  try {
    const token = await fetchClientToken({ baseUrl: stack.baseUrl, clientId: "app-so-suc-khoe", clientSecret: "synthetic-secret" });
    assert.equal(token, "synthetic-token");
    assert.equal(stack.tokenRequests.length, 1);
    const client = createHealthClient({ baseUrl: stack.baseUrl, token });
    const dataset = generateHealthDataset({ seed: 42 });
    const first = await seedHealth({ client, dataset });
    assert.equal(first.objectsCreated, dataset.documents.length);
    assert.equal(first.recordsCreated, 40 + 45 + 50);
    assert.equal(first.recordsExisting, 0);
    assert.equal(stack.records.get("benh-nhan").length, 40);
    assert.equal(stack.records.get("chuyen-tuyen").length, 45);
    assert.equal(stack.records.get("don-thuoc").length, 50);
    assert.equal(stack.objects.size, dataset.documents.length);
    assert.equal(stack.objects.get(dataset.documents[0].id).toString("utf8"), dataset.documents[0].content);
    const second = await seedHealth({ client, dataset });
    assert.equal(second.recordsCreated, 0);
    assert.equal(second.objectsCreated, 0);
    assert.equal(second.recordsExisting, 135);
    assert.equal(second.objectsExisting, dataset.documents.length);
    assert.equal(first.malwareBlocked, true);
    assert.ok(![...stack.objects.values()].some(bytes => bytes.toString("utf8").includes("EICAR")));
  } finally {
    await stack.close();
  }
});

test("health trust relations are proposed and approved independently, then reused", async () => {
  const stack = await fakeTrustStack();
  try {
    const apps = healthAppsFixture();
    const published = healthPublishedFixture(apps);
    const owner = { id: "owner-id", token: "owner-token" };
    const approver = { id: "approver-id", token: "approver-token" };
    const api = (path, token, body, headers = {}, method = body === undefined ? "GET" : "POST") =>
      fetch(stack.baseUrl + path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    const first = await ensureHealthRelations({ api, owner, approver, apps, published });
    assert.deepEqual(first, { created: HEALTH_RELATIONS.length, existing: 0 });
    assert.equal(stack.grants.length, HEALTH_RELATIONS.length);
    for (const relation of HEALTH_RELATIONS) {
      const capability = published[`${relation.provider}/${relation.capability}`];
      const grant = stack.grants.find((value) =>
        value.providerAppId === apps[relation.provider].appId &&
        value.consumerAppId === apps[relation.consumer].appId &&
        value.capabilityId === capability.capabilityId
      );
      assert.ok(grant, `missing grant for ${relation.provider} → ${relation.consumer}`);
      assert.equal(grant.state, "active");
      assert.deepEqual(grant.subjectIds, [apps[relation.consumer].subject]);
    }
    const proposals = stack.calls.filter(call => call.path === "/v1/trust/grants");
    const approvals = stack.calls.filter(call => call.path === "/v1/approvals");
    assert.equal(proposals.length, HEALTH_RELATIONS.length);
    assert.equal(approvals.length, HEALTH_RELATIONS.length);
    assert.ok(proposals.every(call => call.auth === "Bearer owner-token"));
    assert.ok(approvals.every(call => call.auth === "Bearer approver-token"));

    const second = await ensureHealthRelations({ api, owner, approver, apps, published });
    assert.deepEqual(second, { created: 0, existing: HEALTH_RELATIONS.length });
    assert.equal(stack.grants.length, HEALTH_RELATIONS.length);
  } finally {
    await stack.close();
  }
});

test("records and files are distributed through each application's own client", async () => {
  const tram = await fakeStack();
  const hospital = await fakeStack();
  try {
    const dataset = generateHealthDataset({ seed: 91 });
    const stats = await seedHealth({ clients: {
      "tram-y-te": createHealthClient({ baseUrl: tram.baseUrl, token: "synthetic-token" }),
      "benh-vien": createHealthClient({ baseUrl: hospital.baseUrl, token: "synthetic-token" }),
    }, dataset });
    assert.equal(tram.records.get("benh-nhan").length, 12);
    assert.equal(tram.records.get("chuyen-tuyen").length, 15);
    assert.equal(tram.records.get("don-thuoc"), undefined);
    assert.equal(hospital.records.get("chuyen-tuyen").length, 15);
    assert.equal(hospital.records.get("benh-nhan"), undefined);
    assert.equal(tram.objects.size, 3);
    assert.equal(hospital.objects.size, 2);
    assert.equal(stats.recordsCreated, 12 + 15 + 15);
    assert.equal(stats.objectsCreated, 5);
    assert.equal(stats.byApplication["tram-y-te"].recordsCreated, 27);
    assert.equal(stats.byApplication["benh-vien"].recordsCreated, 15);
    assert.equal(stats.malwareBlocked, true);
  } finally {
    await tram.close();
    await hospital.close();
  }
});

test("failed authentication does not echo the client secret", async () => {
  const stack = await fakeStack();
  try {
    await assert.rejects(
      fetchClientToken({ baseUrl: stack.baseUrl, clientId: "app-so-suc-khoe", clientSecret: "wrong-secret-value" }),
      error => !error.message.includes("wrong-secret-value") && /401/.test(error.message),
    );
  } finally {
    await stack.close();
  }
});
