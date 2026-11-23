// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { verifyContracts } from "./contract.mjs";
import { createAuthorityFixture } from "./fixtures/authority.mjs";
import { base, recordTestSupport } from "./record-test-support.mjs";

const prefix = `sar_${randomBytes(6).toString("hex")}`;
const support = recordTestSupport(prefix);
const { api, sql, q } = support;
const issuer = `${base}/identity/realms/junctura`;
const run = promisify(execFile);
const adminSql = text => run("docker", ["compose", "exec", "-T", "database", "psql",
  "-U", "junctura_admin", "-d", "junctura_data", "-XAtq", "-v", "ON_ERROR_STOP=1", "-c", text], { timeout: 30000 });
const clientIds = [];
const users = [];
const authority = createAuthorityFixture({ base, prefix, sql: adminSql, q, api: (path, who, body, headers, method) =>
  import("./contract.mjs").then(({ contractFetch }) => contractFetch(`${base}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { ...(who ? { Authorization: `Bearer ${who.token ?? who}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000) })),
  clientIds, users });
let owner, stranger, app, subjectId;

const post = (who, path, body) => api(path, who, body);

const capabilityId = `urn:junctura:capability:${"3".repeat(8)}-4444-4444-8444-444444444444:lookup`;
const digest = `sha256:${"0".repeat(64)}`;

const executionSeed = async ({ executionId, dataSubject, emergency, review }) => {
  const versionId = randomUUID();
  const grantId = randomUUID();
  await adminSql(`INSERT INTO app_private.capability_versions (tenant_id, version_id, capability_id, provider_app_id,
      version, manifest, digest, state, created_by, updated_by)
    VALUES ('tenant-a', '${versionId}', '${capabilityId}', '${app.appId}', '1.0.0', '{"title":"Lookup"}',
      '${digest}', 'published', 'fixture', 'fixture');`);
  await adminSql(`INSERT INTO trust_private.grants (tenant_id, grant_id, issuer, provider_app_id, consumer_app_id,
      version_id, capability_id, version, manifest_digest, proposal, digest, state, expires_at, created_by, management_client)
    VALUES ('tenant-a', '${grantId}', ${q(issuer)}, '${app.appId}', '${app.appId}', '${versionId}',
      '${capabilityId}', '1.0.0', '${digest}',
      '{"delegationAllowed":false,"acceptDelegation":false}', '${digest}', 'pending', now() + interval '1 hour',
      'fixture', 'fixture-management');`);
  await adminSql(`INSERT INTO execution_private.executions (tenant_id, execution_id, issuer, initiating_subject,
      initiating_client, consumer_app_id, provider_app_id, version_id, grant_id, capability_id, version,
      manifest_digest, input, input_digest, request_digest, idempotency_key, deadline_at, authority_expires_at,
      state, result_expires_at, engine_business_key, ticket_hash, ticket_expires_at, ticket_consumed_at,
      finished_at, output)
    VALUES ('tenant-a', '${executionId}', ${q(issuer)}, 'fixture-subject', 'fixture-client',
      '${app.appId}', '${app.appId}', '${versionId}', '${grantId}', '${capabilityId}', '1.0.0', '${digest}',
      '{}', '${digest}', '${digest}', '${randomUUID()}', now() + interval '1 hour', now() + interval '1 hour',
      'succeeded', now() + interval '48 hours', ${q(`sar-${executionId}`)}, '${digest}',
      now() + interval '1 hour', now(), now(), '{"ok":true}');`);
  await adminSql(`INSERT INTO execution_private.execution_contexts (tenant_id, execution_id, purpose,
      data_subject, subject_kind, emergency) VALUES ('tenant-a', '${executionId}', 'service_review',
      ${q(dataSubject)}, 'canonical', ${emergency ? "true" : "false"});`);
  if (review) {
    await adminSql(`INSERT INTO execution_private.emergency_reviews (tenant_id, execution_id, state)
      VALUES ('tenant-a', '${executionId}', 'pending');`);
  }
};

before(async () => {
  const [person, other] = await Promise.all([
    authority.human("owner", "tenant-a", ["audit.read"]),
    authority.human("stranger", "tenant-a", ["audit.read"]),
  ]);
  stranger = other;
  subjectId = randomUUID();
  owner = await authority.verifiedSubject(person, subjectId);
  app = await support.createBackend("access-app");
  await adminSql(`INSERT INTO app_private.app_audit_actions (tenant_id, app_id, action, sensitivity, visible_to_subject)
    VALUES ('tenant-a', '${app.appId}', 'record.viewed', 'standard', true),
           ('tenant-a', '${app.appId}', 'record.purged', 'restricted', false)
    ON CONFLICT DO NOTHING;`);
  // Three capability accesses: two visible to the owner (one emergency with a
  // pending review), one visible only to the stranger.
  await executionSeed({ executionId: randomUUID(), dataSubject: subjectId, emergency: false });
  await executionSeed({ executionId: randomUUID(), dataSubject: subjectId, emergency: true, review: true });
  await executionSeed({ executionId: randomUUID(), dataSubject: `stranger-${subjectId}`, emergency: false });
  // Application events through the sealed append route: two visible, one not.
  for (const action of ["record.viewed", "record.viewed", "record.purged"]) {
    const response = await post(app, "/v1/audit-events", {
      action, outcome: "success", purpose: "service_review",
      resourceRef: { kind: "record", id: recordId() }, subjectId,
    }, { "Idempotency-Key": randomUUID() });
    assert.equal(response.status, 201, await response.clone().text());
  }
});

const recordId = () => randomUUID();

after(async () => {
  try {
    await adminSql(`DELETE FROM execution_private.emergency_reviews WHERE tenant_id='tenant-a' AND execution_id IN
        (SELECT execution_id FROM execution_private.executions WHERE initiating_subject='fixture-subject');
      DELETE FROM execution_private.execution_contexts WHERE tenant_id='tenant-a' AND purpose='service_review'
        AND execution_id IN (SELECT execution_id FROM execution_private.executions WHERE initiating_subject='fixture-subject');
      DELETE FROM execution_private.executions WHERE tenant_id='tenant-a' AND initiating_subject='fixture-subject';
      DELETE FROM trust_private.grants WHERE tenant_id='tenant-a' AND created_by='fixture';
      DELETE FROM app_private.capability_versions WHERE tenant_id='tenant-a' AND created_by='fixture';
      DELETE FROM app_private.subject_access_reports WHERE tenant_id='tenant-a' AND reported_by IN (${q(owner.id)},${q(stranger.id)});
      DELETE FROM app_private.emergency_feedback WHERE tenant_id='tenant-a' AND submitted_by IN (${q(owner.id)},${q(stranger.id)});`);
  } catch { /* The suites run against a disposable stack. */ }
  await support.cleanup([app]);
  await authority.cleanupSubjectBindings();
});

test("the merged history interleaves both sources newest first and marks flags", async () => {
  const page = await (await api("/v1/me/data-access", owner)).json();
  assert.ok(page.entries.length >= 4);
  assert.ok(page.entries.every((entry, index) => index === 0 ||
    new Date(`${page.entries[index - 1].accessedAt}Z`.replace("Z", "")) >= new Date(`${entry.accessedAt}Z`.replace("Z", "")) ||
    page.entries[index - 1].accessedAt >= entry.accessedAt), "entries arrive newest first");
  const appEntries = page.entries.filter(entry => entry.source === "application");
  assert.equal(appEntries.length, 2, "the restricted event stays invisible");
  assert.ok(appEntries.every(entry => entry.accessId.startsWith("app:")));
  assert.ok(appEntries.every(entry => entry.flaggedAt === null));
  assert.ok(appEntries.every(entry => entry.app.appId === app.appId && entry.action === "record.viewed"));
  const capability = page.entries.filter(entry => entry.source === "capability");
  assert.equal(capability.length, 2, "the stranger-named execution stays invisible");
  assert.equal(capability.filter(entry => entry.emergency).length, 1);
  assert.equal(capability.find(entry => entry.emergency).review, "pending");
  assert.ok(capability.every(entry => entry.consumer.appId === app.appId && entry.provider.appId === app.appId));
  // The stranger sees only their own execution and none of the owner's events.
  const foreign = await (await api("/v1/me/data-access", stranger)).json();
  assert.equal(foreign.entries.filter(entry => entry.source === "capability").length, 1);
  assert.equal(foreign.entries.filter(entry => entry.source === "application").length, 0);
});

test("pagination walks the merged page with a caller-bound cursor", async () => {
  const first = await (await api("/v1/me/data-access?limit=2", owner)).json();
  assert.equal(first.entries.length, 2);
  assert.equal(first.truncated, true);
  assert.ok(first.nextCursor);
  const second = await (await api(`/v1/me/data-access?limit=2&cursor=${first.nextCursor}`, owner)).json();
  const seen = new Set([...first.entries, ...second.entries].map(entry => entry.accessId));
  assert.equal(seen.size, first.entries.length + second.entries.length, "pages never repeat an entry");
  assert.equal((await api(`/v1/me/data-access?limit=2&cursor=${first.nextCursor}`, stranger)).status, 200);
});

test("flagging a visible entry replays the same reason and conflicts on a change", async () => {
  const page = await (await api("/v1/me/data-access", owner)).json();
  const target = page.entries.find(entry => entry.source === "application");
  const flagPath = `/v1/me/data-access/${target.accessId}/flag`;
  const created = await post(owner, flagPath, { reason: "unrecognized" });
  assert.equal(created.status, 201, await created.clone().text());
  const receipt = await created.json();
  assert.equal(receipt.accessId, target.accessId);
  const replay = await post(owner, flagPath, { reason: "unrecognized" });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).flaggedAt, receipt.flaggedAt);
  const changed = await post(owner, flagPath, { reason: "other" });
  assert.equal(changed.status, 409);
  assert.equal((await changed.json()).error, "resource_conflict");
  // The flagged entry now presents flaggedAt in the history.
  const after = await (await api("/v1/me/data-access", owner)).json();
  assert.equal(after.entries.find(entry => entry.accessId === target.accessId).flaggedAt, receipt.flaggedAt);
  // Only the same visible entries can be flagged: the restricted action, a
  // foreign capability execution and an unknown id all answer 404.
  const restricted = after.entries.find(entry => entry.source === "application" && entry.action === "record.purged");
  assert.equal(restricted, undefined);
  const invisible = await post(owner, `/v1/me/data-access/app:${randomUUID()}/flag`, { reason: "other" });
  assert.equal(invisible.status, 404);
  const foreignExecution = (await (await api("/v1/me/data-access", stranger)).json())
    .entries.find(entry => entry.source === "capability");
  const foreignFlag = await post(owner, `/v1/me/data-access/${foreignExecution.accessId}/flag`, { reason: "other" });
  assert.equal(foreignFlag.status, 404);
  const strangerFlag = await post(stranger, flagPath, { reason: "other" });
  assert.equal(strangerFlag.status, 404);
});

test("emergency feedback belongs to the subject's own emergency access", async () => {
  const page = await (await api("/v1/me/data-access", owner)).json();
  const emergency = page.entries.find(entry => entry.emergency);
  const feedbackPath = `/v1/me/emergency-accesses/${emergency.executionId}/feedback`;
  const created = await post(owner, feedbackPath, { decision: "recognized", message: "mine" });
  assert.equal(created.status, 201, await created.clone().text());
  const receipt = await created.json();
  assert.equal(receipt.executionId, emergency.executionId);
  const replay = await post(owner, feedbackPath, { decision: "recognized", message: "mine" });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).submittedAt, receipt.submittedAt);
  const changed = await post(owner, feedbackPath, { decision: "unrecognized" });
  assert.equal(changed.status, 409);
  assert.equal((await changed.json()).error, "resource_conflict");
  const plain = page.entries.find(entry => !entry.emergency);
  const refused = await post(owner, `/v1/me/emergency-accesses/${plain.executionId}/feedback`, { decision: "other" });
  assert.equal(refused.status, 404);
  const strangerFeedback = await post(stranger, feedbackPath, { decision: "other" });
  assert.equal(strangerFeedback.status, 404);
});

test("writing a report never disturbs the sealed audit chain", async () => {
  const head = async () => {
    const verify = await post(owner, "/v1/audit-events/verify", {});
    assert.equal(verify.status, 200);
    return (await verify.json()).verified;
  };
  assert.equal(await head(), true);
  const page = await (await api("/v1/me/data-access", owner)).json();
  const target = page.entries.find(entry => entry.source === "capability");
  assert.equal((await post(owner, `/v1/me/data-access/${target.accessId}/flag`, { reason: "other" })).status, 201);
  assert.equal(await head(), true);
});

test("implemented operations match the observed HTTP contract", async () => {
  await verifyContracts("subject-access");
});
