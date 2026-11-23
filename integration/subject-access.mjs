// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { verifyContracts } from "./contract.mjs";
import { createAuthorityFixture } from "./fixtures/authority.mjs";
import { base, recordTestSupport } from "./record-test-support.mjs";

const prefix = `sar_${randomBytes(6).toString("hex")}`;
const support = recordTestSupport(prefix);
const { api, sql, q } = support;
const issuer = `${base}/identity/realms/junctura`;
const clientIds = [];
const users = [];
const authority = createAuthorityFixture({ base, prefix, sql, q, api: (path, who, body, headers, method) =>
  import("./contract.mjs").then(({ contractFetch }) => contractFetch(`${base}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { ...(who ? { Authorization: `Bearer ${who.token ?? who}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000) })),
  clientIds, users });
let owner, stranger, consumer, provider, subjectId, strangerSubjectId;
let versionId, grantId;

// The current helper signature: explicit method, body and headers.
const post = (who, path, body, headers) => api(path, who, { method: "POST", body, headers });

const capabilityId = `urn:junctura:capability:${"3".repeat(8)}-4444-4444-8444-444444444444:lookup`;
const digest = `sha256:${"0".repeat(64)}`;
// Ticket hashes are unique per execution; every fixture execution derives its
// own 64-hex value instead of sharing one.
const ticketHash = executionId => `sha256:${executionId.replaceAll("-", "").repeat(2)}`;
// Two owner-visible executions share this instant; the page key must keep the
// full precision or the tie beyond the cursor would be skipped.
const shared = "2026-11-20 12:00:00.123456+00";

const seedExecution = async ({ executionId, dataSubject, emergency, review, recordedAt }) => {
  await sql(`INSERT INTO execution_private.executions (tenant_id, execution_id, issuer, initiating_subject,
      initiating_client, consumer_app_id, provider_app_id, version_id, grant_id, capability_id, version,
      manifest_digest, input, input_digest, request_digest, idempotency_key, deadline_at, authority_expires_at,
      state, result_expires_at, engine_business_key, ticket_hash, ticket_expires_at, ticket_consumed_at,
      finished_at, output)
    VALUES ('tenant-a', '${executionId}', ${q(issuer)}, 'fixture-subject', 'fixture-client',
      '${consumer.appId}', '${provider.appId}', '${versionId}', '${grantId}', '${capabilityId}', '1.0.0', '${digest}',
      '{}', '${digest}', '${digest}', '${randomUUID()}', now() + interval '1 hour', now() + interval '1 hour',
      'succeeded', now() + interval '48 hours', ${q(`sar-${executionId}`)}, '${ticketHash(executionId)}',
      now() + interval '1 hour', now(), now(), '{"ok":true}');`);
  await sql(`INSERT INTO execution_private.execution_contexts (tenant_id, execution_id, purpose,
      data_subject, subject_kind, emergency, justification${recordedAt ? ", recorded_at" : ""})
    VALUES ('tenant-a', '${executionId}', 'service_review', ${q(dataSubject)}, 'canonical',
      ${emergency ? "true" : "false"},
      ${emergency ? q("Subject unreachable during the fixture emergency") : "NULL"}${recordedAt ? `, '${recordedAt}'::timestamptz` : ""});`);
  if (review) {
    await sql(`INSERT INTO execution_private.emergency_reviews (tenant_id, execution_id, state)
      VALUES ('tenant-a', '${executionId}', 'pending');`);
  }
};

// Two owner-visible application events for the subject share the capability
// instant too, so the page key keeps same-instant ties across both sources.
// They are seeded directly with their occurred_at set in the same transaction
// and stay unsealed until the regular append route seals the chain.
const seedSharedAppEvents = async () => {
  const claims = JSON.stringify({ tenant_id: "tenant-a", iss: issuer,
    sub: consumer.subject, client_id: consumer.clientId, role: "junctura_audit_api" });
  const event = index => `DO $seed$ DECLARE new_id uuid; BEGIN
    INSERT INTO app_private.audit(tenant_id,event,resource_id,revision,outcome)
      VALUES ('tenant-a','audit.application_event','${consumer.appId}',1,'success')
      RETURNING event_id INTO new_id;
    UPDATE app_private.audit SET occurred_at='${shared}' WHERE event_id=new_id;
    INSERT INTO app_private.audit_app_payloads(tenant_id,event_id,entry,visible_to_subject)
      VALUES ('tenant-a',new_id,jsonb_build_object('action','record.viewed',
        'subjectId',${q(subjectId)},'resourceRef',jsonb_build_object('type','object','id',gen_random_uuid()::text),
        'outcome','success','purpose','service_review','sensitivity','standard'),true);
  END $seed$;`;
  await sql(`BEGIN;
    SET LOCAL ROLE junctura_app_owner;
    SELECT set_config('request.jwt.claims', ${q(claims)}, false);
    ${event(1)} ${event(2)}
  COMMIT;`);
};

before(async () => {
  // The PKCE client exists before any human signs in; both humans reuse it.
  await authority.operatorToken();
  const template = (await (await authority.admin("clients?clientId=tenant-a")).json())[0];
  const source = await (await authority.admin(`clients/${template.id}`)).json();
  const protocolMappers = structuredClone(source.protocolMappers);
  for (const mapper of protocolMappers) delete mapper.id;
  protocolMappers.find(mapper => mapper.name === "tenant").config["claim.value"] = "tenant-a";
  const management = await authority.admin("clients", { clientId: `${prefix}-management-tenant-a`,
    enabled: true, protocol: "openid-connect", publicClient: true, standardFlowEnabled: true,
    directAccessGrantsEnabled: false, redirectUris: ["http://127.0.0.1:9876/callback"],
    attributes: { "pkce.code.challenge.method": "S256" }, protocolMappers }, "POST");
  assert.equal(management.status, 201);
  clientIds.push(management.headers.get("location").split("/").at(-1));

  const [ownerPerson, strangerPerson] = await Promise.all([
    authority.human("owner", "tenant-a", ["audit.read"]),
    authority.human("stranger", "tenant-a", ["audit.read"]),
  ]);
  subjectId = randomUUID();
  strangerSubjectId = randomUUID();
  // Both callers carry a verified binding so each has their own history.
  owner = await authority.verifiedSubject(ownerPerson, subjectId);
  stranger = await authority.verifiedSubject(strangerPerson, strangerSubjectId);
  consumer = await support.createBackend("sar-consumer");
  provider = await support.createBackend("sar-provider");
  await sql(`INSERT INTO app_private.app_audit_actions (tenant_id, app_id, action, sensitivity, visible_to_subject)
    VALUES ('tenant-a', '${consumer.appId}', 'record.viewed', 'standard', true),
           ('tenant-a', '${consumer.appId}', 'record.purged', 'restricted', false)
    ON CONFLICT DO NOTHING;`);
  // One valid capability version and one grant serve every seeded execution;
  // consumer and provider are distinct applications.
  versionId = randomUUID();
  grantId = randomUUID();
  // A published version carries the validation evidence the registry
  // requires (capability_published_validation): it was validated at the
  // previous revision under policy revision 1 with the same digest.
  await sql(`INSERT INTO app_private.capability_versions (tenant_id, version_id, capability_id, provider_app_id,
      version, manifest, digest, state, created_by, updated_by, revision, validation_status, validation_digest,
      validation_revision, validation_policy_revision, validated_at, validation_report, published_at)
    VALUES ('tenant-a', '${versionId}', '${capabilityId}', '${provider.appId}', '1.0.0', '{"title":"Lookup"}',
      '${digest}', 'published', 'fixture', 'fixture', 2, 'valid', '${digest}', 1, 1, now(),
      jsonb_build_object('status','valid','digest','${digest}','revision','1','policyRevision','1'), now());`);
  await sql(`INSERT INTO trust_private.grants (tenant_id, grant_id, issuer, provider_app_id, consumer_app_id,
      version_id, capability_id, version, manifest_digest, proposal, digest, state, expires_at, created_by, management_client)
    VALUES ('tenant-a', '${grantId}', ${q(issuer)}, '${provider.appId}', '${consumer.appId}', '${versionId}',
      '${capabilityId}', '1.0.0', '${digest}',
      '{"delegationAllowed":false,"acceptDelegation":false}', '${digest}', 'pending', now() + interval '1 hour',
      'fixture', 'fixture-management');`);
  // Two owner-visible capability accesses share one instant; the emergency one
  // carries its justification and a pending review. One names the stranger.
  await seedExecution({ executionId: randomUUID(), dataSubject: subjectId, recordedAt: shared });
  await seedExecution({ executionId: randomUUID(), dataSubject: subjectId, emergency: true, review: true, recordedAt: shared });
  await seedExecution({ executionId: randomUUID(), dataSubject: strangerSubjectId });
  // Two application events share that same instant; the first append seals
  // them together with the capability rows.
  await seedSharedAppEvents();
  // Application events through the sealed append route: two visible, one not.
  for (const action of ["record.viewed", "record.viewed", "record.purged"]) {
    const response = await post(consumer, "/v1/audit-events", {
      action, outcome: "success", purpose: "service_review",
      resourceRef: { type: "object", id: randomUUID() }, subjectId,
    }, { "Idempotency-Key": randomUUID() });
    assert.equal(response.status, 201, await response.clone().text());
  }
});

after(async () => {
  try {
    await sql(`DELETE FROM execution_private.emergency_reviews WHERE tenant_id='tenant-a' AND execution_id IN
        (SELECT execution_id FROM execution_private.executions WHERE initiating_subject='fixture-subject');
      DELETE FROM execution_private.execution_contexts WHERE tenant_id='tenant-a' AND purpose='service_review'
        AND execution_id IN (SELECT execution_id FROM execution_private.executions WHERE initiating_subject='fixture-subject');
      DELETE FROM execution_private.executions WHERE tenant_id='tenant-a' AND initiating_subject='fixture-subject';
      DELETE FROM trust_private.grants WHERE tenant_id='tenant-a' AND created_by='fixture';
      DELETE FROM app_private.capability_versions WHERE tenant_id='tenant-a' AND created_by='fixture';
      DELETE FROM app_private.subject_access_reports WHERE tenant_id='tenant-a'
        AND reported_by IN (${q(owner.id)},${q(stranger.id)});
      DELETE FROM app_private.emergency_feedback WHERE tenant_id='tenant-a'
        AND submitted_by IN (${q(owner.id)},${q(stranger.id)});
      DELETE FROM app_private.principals WHERE tenant_id='tenant-a'
        AND subject IN (${q(owner.id)},${q(stranger.id)});`);
  } catch { /* The suites run against a disposable stack. */ }
  await support.cleanup([consumer, provider]);
  await authority.cleanupSubjectBindings();
  for (const id of clientIds) await authority.admin(`clients/${id}`, undefined, "DELETE");
  for (const id of users) await authority.admin(`users/${id}`, undefined, "DELETE");
});

const walk = async (who, limit) => {
  const entries = [];
  let cursor;
  for (;;) {
    const page = await (await api(`/v1/me/data-access?limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`, who)).json();
    entries.push(...page.entries);
    if (!page.truncated) return entries;
    cursor = page.nextCursor;
    assert.ok(cursor);
  }
};

test("the merged history interleaves both sources newest first and marks flags", async () => {
  const page = await (await api("/v1/me/data-access", owner)).json();
  assert.ok(page.entries.length >= 6);
  assert.ok(page.entries.every((entry, index) => index === 0 ||
    page.entries[index - 1].accessedAt >= entry.accessedAt), "entries arrive newest first");
  const appEntries = page.entries.filter(entry => entry.source === "application");
  assert.equal(appEntries.length, 4, "the restricted event stays invisible");
  assert.ok(appEntries.every(entry => entry.accessId.startsWith("app:")));
  assert.ok(appEntries.every(entry => entry.flaggedAt === null));
  assert.ok(appEntries.every(entry => entry.app.appId === consumer.appId && entry.action === "record.viewed"));
  assert.equal(appEntries.filter(entry => entry.accessedAt === "2026-11-20T12:00:00.123456Z").length, 2,
    "both seeded events share the capability instant");
  const capability = page.entries.filter(entry => entry.source === "capability");
  assert.equal(capability.length, 2, "the stranger-named execution stays invisible");
  assert.equal(capability.filter(entry => entry.emergency).length, 1);
  assert.equal(capability.find(entry => entry.emergency).review, "pending");
  assert.ok(capability.every(entry => entry.executionId && entry.consumer.appId === consumer.appId &&
    entry.provider.appId === provider.appId && entry.capability.capabilityId === capabilityId));
  // The stranger sees only their own execution and none of the owner's events.
  const foreign = await (await api("/v1/me/data-access", stranger)).json();
  assert.equal(foreign.entries.filter(entry => entry.source === "capability").length, 1);
  assert.equal(foreign.entries.filter(entry => entry.source === "application").length, 0);
});

test("pagination keeps every entry including same-instant ties, and the cursor is caller-bound", async () => {
  const entries = await walk(owner, 1);
  const ids = entries.map(entry => entry.accessId);
  assert.equal(new Set(ids).size, ids.length, "pages never repeat or skip an entry");
  assert.equal(entries.filter(entry => entry.source === "capability").length, 2,
    "both executions with the identical timestamp surface");
  assert.equal(entries.filter(entry => entry.source === "application" &&
    entry.accessedAt === "2026-11-20T12:00:00.123456Z").length, 2,
    "both application events with the identical timestamp surface");
  assert.equal(entries.length, 6);
  // A cursor issued to one verified subject fails closed for another.
  const first = await (await api("/v1/me/data-access?limit=2", owner)).json();
  assert.equal(first.truncated, true);
  const foreign = await api(`/v1/me/data-access?limit=2&cursor=${first.nextCursor}`, stranger);
  assert.equal(foreign.status, 400);
  assert.equal((await foreign.json()).error, "invalid_cursor");
  const second = await (await api(`/v1/me/data-access?limit=2&cursor=${first.nextCursor}`, owner)).json();
  assert.equal(new Set([...first.entries, ...second.entries].map(entry => entry.accessId)).size, 4);
});

test("flagging a visible entry replays the same reason and conflicts on a change", async () => {
  const page = await (await api("/v1/me/data-access", owner)).json();
  const target = page.entries.find(entry => entry.source === "application");
  const flagPath = `/v1/me/data-access/${target.accessId}/flag`;
  // Two concurrent reports of the same event: one creates, one replays. Every
  // response body is parsed exactly once and kept for later comparison.
  const [left, right] = await Promise.all([
    post(owner, flagPath, { reason: "unrecognized" }),
    post(owner, flagPath, { reason: "unrecognized" }),
  ]);
  assert.deepEqual([left.status, right.status].sort(), [200, 201]);
  const leftReceipt = await left.json();
  const rightReceipt = await right.json();
  assert.equal(leftReceipt.flaggedAt, rightReceipt.flaggedAt);
  const replay = await post(owner, flagPath, { reason: "unrecognized" });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).flaggedAt, leftReceipt.flaggedAt);
  const changed = await post(owner, flagPath, { reason: "other" });
  assert.equal(changed.status, 409);
  assert.equal((await changed.json()).error, "resource_conflict");
  // The flagged entry now presents flaggedAt in the history.
  const after = await (await api("/v1/me/data-access", owner)).json();
  assert.equal(after.entries.find(entry => entry.accessId === target.accessId).flaggedAt, leftReceipt.flaggedAt);
  // Only the same visible entries can be flagged: a foreign capability
  // execution and an unknown id answer 404.
  const foreignExecution = (await (await api("/v1/me/data-access", stranger)).json())
    .entries.find(entry => entry.source === "capability");
  const foreignFlag = await post(owner, `/v1/me/data-access/${foreignExecution.accessId}/flag`, { reason: "other" });
  assert.equal(foreignFlag.status, 404);
  const invisible = await post(owner, `/v1/me/data-access/app:${randomUUID()}/flag`, { reason: "other" });
  assert.equal(invisible.status, 404);
  const strangerFlag = await post(stranger, flagPath, { reason: "other" });
  assert.equal(strangerFlag.status, 404);
});

test("emergency feedback belongs to the subject's own emergency access", async () => {
  const page = await (await api("/v1/me/data-access", owner)).json();
  const emergency = page.entries.find(entry => entry.emergency);
  const feedbackPath = `/v1/me/emergency-accesses/${emergency.executionId}/feedback`;
  const [left, right] = await Promise.all([
    post(owner, feedbackPath, { decision: "recognized", message: "mine" }),
    post(owner, feedbackPath, { decision: "recognized", message: "mine" }),
  ]);
  assert.deepEqual([left.status, right.status].sort(), [200, 201]);
  assert.equal((await left.json()).submittedAt, (await right.json()).submittedAt);
  const changed = await post(owner, feedbackPath, { decision: "unrecognized" });
  assert.equal(changed.status, 409);
  assert.equal((await changed.json()).error, "resource_conflict");
  // Only capability entries carry the emergency flag; an application entry
  // would have no executionId to answer feedback for.
  const plain = page.entries.find(entry => entry.source === "capability" && !entry.emergency);
  const refused = await post(owner, `/v1/me/emergency-accesses/${plain.executionId}/feedback`, { decision: "other" });
  assert.equal(refused.status, 404);
  const strangerFeedback = await post(stranger, feedbackPath, { decision: "other" });
  assert.equal(strangerFeedback.status, 404);
});

test("writing a report never disturbs the sealed audit chain", async () => {
  const verify = async () => {
    const response = await post(owner, "/v1/audit-events/verify", {});
    assert.equal(response.status, 200);
    return response.json();
  };
  // Other suites on this shared stack delete their own fixture audit rows,
  // so the tenant chain may already report a gap; the report must leave the
  // chain exactly as it found it, intact or not.
  const before = await verify();
  assert.ok(before.entries >= 1);
  const page = await (await api("/v1/me/data-access", owner)).json();
  const target = page.entries.find(entry => entry.source === "capability" && !entry.flaggedAt);
  assert.equal((await post(owner, `/v1/me/data-access/${target.accessId}/flag`, { reason: "other" })).status, 201);
  const after = await verify();
  // A report is a separate row keyed by the visible access event: the audit
  // chain and the management review stay untouched — the entry count, the
  // seal and the head hash are exactly where they were.
  assert.equal(after.verified, before.verified);
  assert.deepEqual(after.brokenAt ?? null, before.brokenAt ?? null);
  assert.equal(after.entries, before.entries);
  assert.equal(after.newlySealed, 0);
  assert.equal(after.headHash, before.headHash);
});

test("implemented operations match the observed HTTP contract", async () => {
  await verifyContracts("subject-access");
});
