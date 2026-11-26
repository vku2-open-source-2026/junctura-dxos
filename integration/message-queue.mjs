// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { verifyContracts } from "./contract.mjs";
import { issuer, jsonResult, recordTestSupport } from "./record-test-support.mjs";

const name = `queue-test-${randomUUID().slice(0, 8)}`;
const path = `/v1/queues/${name}`;
const { api, cleanup, createBackend, q, sql } = recordTestSupport(name);
const post = (suffix, app, body, headers) => api(path + suffix, app, { method: "POST", body, headers });
const send = (app, payload, key = randomUUID(), delaySeconds) =>
  post("/messages", app, { payload, delaySeconds }, { "Idempotency-Key": key });
const lease = async (app, visibilityTimeoutSeconds = 30) =>
  (await jsonResult(await post("/lease", app, { visibilityTimeoutSeconds }), 200)).message;
const settle = (action, app, { messageId, leaseToken }) => post(`/messages/${messageId}/${action}`, app, { leaseToken });
const deadLetters = async (app, query = "") => jsonResult(await api(`${path}/dead-letters${query}`, app), 200);
const replay = (app, messageId) => post(`/dead-letters/${messageId}/replay`, app, {});

async function eventually(read) {
  const deadline = Date.now() + 10000;
  do {
    const result = await read();
    if (result) return result;
    await sleep(200);
  } while (Date.now() < deadline);
  assert.fail("job did not reach the expected state");
}

async function seedGrant(owner, caller, approver) {
  const versionId = randomUUID(), grantId = randomUUID(), approvalId = randomUUID();
  const capabilityId = `urn:junctura:capability:${owner.appId}:jobs`;
  const digest = `sha256:${"1".repeat(64)}`;
  const capabilities = [{ capabilityId, version: "1.0.0", manifestDigest: digest }];
  const proposal = { delegationAllowed: false, acceptDelegation: false, capabilities,
    subjectIds: [caller.subject], operations: ["invoke"], permissions: [] };
  const decision = { resourceType: "grant", resourceId: grantId, resourceDigest: digest, resourceRevision: 1,
    requesterSubject: owner.subject, requesterAppId: owner.appId, decision: "approve" };
  await sql(`BEGIN;
    INSERT INTO app_private.principals (tenant_id, issuer, subject, management_client, permissions) VALUES
      ('tenant-a', ${q(issuer)}, ${q(owner.subject)}, ${q(owner.clientId)}, ARRAY['trust.write']),
      ('tenant-a', ${q(issuer)}, ${q(approver.subject)}, ${q(approver.clientId)}, ARRAY['trust.approve']);
    INSERT INTO app_private.capability_versions (tenant_id, version_id, capability_id, provider_app_id, version, manifest,
      digest, state, revision, validation_status, validation_digest, validation_revision, validation_policy_revision,
      validation_report, validated_at, created_by, updated_by, published_at) VALUES
      ('tenant-a', ${q(versionId)}, ${q(capabilityId)}, ${q(owner.appId)}, '1.0.0', '{"requiredPermissions":[]}',
       ${q(digest)}, 'published', 2, 'valid', ${q(digest)}, 1, 1,
       ${q(JSON.stringify({ status: "valid", digest, revision: 1, policyRevision: 1 }))}, now(),
       ${q(owner.subject)}, ${q(owner.subject)}, now());
    INSERT INTO trust_private.grants (tenant_id, grant_id, issuer, provider_app_id, consumer_app_id, version_id,
      capability_id, version, manifest_digest, proposal, digest, revision, state, expires_at, created_by,
      management_client, activated_at) VALUES
      ('tenant-a', ${q(grantId)}, ${q(issuer)}, ${q(owner.appId)}, ${q(caller.appId)}, ${q(versionId)},
       ${q(capabilityId)}, '1.0.0', ${q(digest)}, ${q(JSON.stringify(proposal))}, ${q(digest)}, 2, 'active',
       now() + interval '10 minutes', ${q(owner.subject)}, ${q(owner.clientId)}, now());
    INSERT INTO trust_private.approvals (tenant_id, approval_id, grant_id, decision, approver_subject, management_client,
      expires_at, state) VALUES ('tenant-a', ${q(approvalId)}, ${q(grantId)}, ${q(JSON.stringify(decision))},
      ${q(approver.subject)}, ${q(approver.clientId)}, now() + interval '10 minutes', 'consumed');
    UPDATE trust_private.grants SET activation_approval_id = ${q(approvalId)} WHERE grant_id = ${q(grantId)};
    COMMIT;`);
  return { versionId, grantId };
}

test("application queues enforce access, delivery, settlement and dead-letter replay", { timeout: 120000 }, async () => {
  const apps = [];
  let grant;
  try {
    for (const suffix of ["owner", "producer", "consumer", "second", "outsider"]) apps.push(await createBackend(suffix));
    const [owner, producer, consumer, second, outsider] = apps;
    const config = { producerAppIds: [producer.appId], consumerAppIds: [consumer.appId, second.appId], maxAttempts: 2 };
    const configure = (app, body = config) => api(path, app, { method: "PUT", body });
    const queue = await jsonResult(await configure(owner), 200);
    assert.equal(queue.ownerAppId, owner.appId);

    for (const res of [await configure(outsider), await send(outsider, null), await post("/lease", outsider, {}),
      await post("/lease", producer, {}), await send(consumer, null), await api(`${path}/dead-letters`, consumer)]) {
      assert.equal((await jsonResult(res, 403)).error, "queue_forbidden");
    }

    const body = { task: "queue-audit-payload-marker", flags: [true, null] };
    const key = randomUUID();
    const [sent, retry] = await Promise.all([
      send(producer, body, key).then(res => jsonResult(res, 201)),
      send(producer, { flags: body.flags, task: body.task }, key).then(res => jsonResult(res, 201)),
    ]);
    assert.deepEqual(retry, sent);
    assert.equal((await jsonResult(await send(producer, body, key, 10), 409)).error, "idempotency_key_reused");
    const pair = await Promise.all([lease(consumer), lease(second)]);
    assert.equal(pair.filter(Boolean).length, 1);
    const [holder, other, delivery] = pair[0] ? [consumer, second, pair[0]] : [second, consumer, pair[1]];
    assert.equal(delivery.messageId, sent.messageId);
    assert.equal(delivery.attempt, 1);
    assert.deepEqual(delivery.payload, body);
    assert.equal((await jsonResult(await settle("ack", other, delivery), 409)).error, "queue_lease_lost");
    assert.equal((await settle("ack", holder, delivery)).status, 204);
    assert.deepEqual(await jsonResult(await send(producer, body, key), 201), sent);
    assert.equal(await lease(consumer), null);

    const delayed = await jsonResult(await send(owner, [1, 2], randomUUID(), 3), 201);
    assert.equal(await lease(consumer), null);
    const first = await eventually(() => lease(consumer, 1));
    assert.equal(first.messageId, delayed.messageId);
    const secondDelivery = await eventually(() => lease(second));
    assert.equal(secondDelivery.messageId, first.messageId);
    assert.equal(secondDelivery.attempt, 2);
    assert.notEqual(secondDelivery.leaseToken, first.leaseToken);
    assert.equal((await settle("nack", consumer, first)).status, 409);
    assert.equal((await settle("ack", second, secondDelivery)).status, 204);

    const doomed = await jsonResult(await send(producer, { task: "retry" }), 201);
    const firstAttempt = await lease(consumer);
    const retryStart = Date.now();
    assert.equal((await settle("nack", consumer, firstAttempt)).status, 204);
    const finalAttempt = await eventually(() => lease(consumer));
    assert.ok(Date.now() - retryStart >= 1000);
    assert.equal(finalAttempt.messageId, doomed.messageId);
    assert.equal(finalAttempt.attempt, 2);
    assert.equal((await settle("nack", consumer, finalAttempt)).status, 204);
    assert.equal(await lease(consumer), null);

    assert.equal((await configure(owner, { ...config, maxAttempts: 1 })).status, 200);
    const timedOut = await jsonResult(await send(producer, null), 201);
    const expiring = await lease(consumer, 1);
    assert.equal(expiring.messageId, timedOut.messageId);
    const timedOutEntry = await eventually(async () => (await deadLetters(owner)).items.find(item => item.messageId === timedOut.messageId));
    assert.equal(timedOutEntry.reason, "lease_expired");
    assert.equal(timedOutEntry.payload, null);
    const page = await deadLetters(owner, "?limit=1");
    const next = await deadLetters(owner, `?limit=1&cursor=${page.nextCursor}`);
    assert.equal(next.nextCursor, null);
    assert.deepEqual(new Map([...page.items, ...next.items].map(item => [item.messageId, item.reason])),
      new Map([[doomed.messageId, "nack"], [timedOut.messageId, "lease_expired"]]));
    assert.equal((await replay(consumer, doomed.messageId)).status, 403);
    assert.equal((await replay(owner, doomed.messageId)).status, 204);
    assert.equal((await replay(owner, doomed.messageId)).status, 404);
    const replayed = await lease(second);
    assert.equal(replayed.messageId, doomed.messageId);
    assert.equal(replayed.attempt, 1);
    assert.deepEqual(replayed.payload, { task: "retry" });
    assert.equal((await settle("ack", second, replayed)).status, 204);

    grant = await seedGrant(owner, outsider, second);
    assert.equal((await send(outsider, null)).status, 403);
    assert.equal((await configure(owner, { ...config, producerCapabilityVersionIds: [grant.versionId] })).status, 200);
    const grantSend = await jsonResult(await send(outsider, null), 201);
    assert.equal((await post("/lease", outsider, {})).status, 403);
    assert.equal((await configure(owner, { ...config, consumerCapabilityVersionIds: [grant.versionId] })).status, 200);
    const grantDelivery = await lease(outsider);
    assert.equal(grantDelivery.messageId, grantSend.messageId);
    assert.equal((await send(outsider, null)).status, 403);
    assert.equal((await settle("ack", outsider, grantDelivery)).status, 204);
    await sql(`UPDATE trust_private.grants SET state='revoked', revoked_at=now() WHERE grant_id=${q(grant.grantId)};`);
    assert.equal((await post("/lease", outsider, {})).status, 403);

    const deleteQueue = (app, key) => api(path, app,
      { method: "DELETE", headers: { "Idempotency-Key": key } });
    assert.equal((await jsonResult(await deleteQueue(owner, randomUUID()), 409)).error, "queue_not_empty");
    assert.equal((await deleteQueue(outsider, randomUUID())).status, 403);
    for (const { messageId } of (await deadLetters(owner)).items) {
      assert.equal((await replay(owner, messageId)).status, 204);
      assert.equal((await settle("ack", owner, await lease(owner))).status, 204);
    }
    const removal = randomUUID();
    const deleted = await deleteQueue(owner, removal);
    assert.equal(deleted.status, 204);
    assert.equal((await deleteQueue(owner, removal)).status, 204);
    assert.equal(await sql(`SELECT count(*) FROM app_private.audit WHERE tenant_id='tenant-a'
      AND event='audit.queue_delete' AND outcome='success' AND resource_id=${q(queue.queueId)};`), "1");
    const audit = JSON.parse(await sql(`SELECT jsonb_agg(jsonb_build_object('event', event, 'outcome', outcome, 'leaked',
      to_jsonb(a)::text LIKE '%queue-audit-payload-marker%')) FROM app_private.audit a
      WHERE tenant_id='tenant-a' AND management_client IN (${apps.map(app => q(app.clientId)).join(",")})
      AND left(event, 12)='audit.queue_';`));
    assert.deepEqual(new Set(audit.filter(entry => entry.outcome === "success").map(entry => entry.event)),
      new Set(["configure", "send", "lease", "ack", "nack", "list", "replay", "delete"].map(operation => `audit.queue_${operation}`)));
    assert.ok(audit.some(entry => entry.event === "audit.queue_send" && entry.outcome === "denied"));
    assert.ok(audit.every(entry => !entry.leaked));
    await verifyContracts("message-queue");
  } finally {
    try {
      await sql(`BEGIN;
        DELETE FROM app_private.queue_messages WHERE (tenant_id, queue_id) IN
          (SELECT tenant_id, queue_id FROM app_private.message_queues WHERE tenant_id='tenant-a' AND name=${q(name)});
        DELETE FROM app_private.message_queues WHERE tenant_id='tenant-a' AND name=${q(name)};
        ${grant ? `UPDATE trust_private.grants SET activation_approval_id=NULL WHERE grant_id=${q(grant.grantId)};
        DELETE FROM trust_private.approvals WHERE grant_id=${q(grant.grantId)};
        DELETE FROM trust_private.grants WHERE grant_id=${q(grant.grantId)};
        DELETE FROM app_private.capability_versions WHERE version_id=${q(grant.versionId)};` : ""}
        COMMIT;`);
    } finally { await cleanup(apps); }
  }
});
