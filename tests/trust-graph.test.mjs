// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { handleTrustGraph } from "../src/modules/capability/trust/trust.mjs";
import { HttpError, json } from "../src/platform/http/http.mjs";
import { readFileSync } from "node:fs";

const identity = { tenantId: "tenant-a", subject: "approver", issuer: "https://identity.example.invalid", clientId: "management", roles: ["core-reader"] };
const provider = "11111111-1111-4111-8111-111111111111";
const consumer = "22222222-2222-4222-8222-222222222222";
const graph = {
  scope: "tenant", readOnly: true,
  nodes: [{ appId: provider, displayName: "Danh bạ", state: "active", owned: false }, { appId: consumer, displayName: "Văn bản", state: "active", owned: false }],
  edges: [{ grantId: "33333333-3333-4333-8333-333333333333", providerAppId: provider, consumerAppId: consumer,
    capabilityId: `urn:junctura:capability:${provider}:contact-lookup`, version: "1.0.0", title: "Tra cứu liên hệ",
    operations: ["discover", "invoke"], revision: 2, state: "active", createdAt: "2026-11-04T00:00:00+00:00",
    activatedAt: "2026-11-04T00:01:00+00:00", revokedAt: null, expiresAt: "2026-12-04T00:00:00+00:00" }],
  truncated: false, generatedAt: "2026-11-04T00:02:00.000Z",
};
const writerGraph = { ...graph, readOnly: false };
let reply = { status: 200, value: graph };
let seen = [];
let data, core, base;
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));

before(async () => {
  data = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    seen.push({ url: request.url, authorization: request.headers.authorization, body: Buffer.concat(chunks).toString() });
    if (reply === "down") { response.writeHead(503); return response.end(); }
    response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(reply));
  });
  const dataUrl = await listen(data);
  core = createServer(async (request, response) => {
    try { await handleTrustGraph(request, response, identity, { dataUrl, dataSecret: "x".repeat(32) }, new URL(request.url, "http://core")); }
    catch (error) { json(response, error instanceof HttpError ? error.status : 500, { error: error.message }); }
  });
  base = await listen(core);
});
after(() => { data.close(); core.close(); });

const get = (options = {}) => fetch(`${base}${options.path ?? "/v1/trust/graph"}`, { method: options.method ?? "GET" });

test("the graph asserts only the private trust role and is never cached", async () => {
  seen = [];
  const response = await get();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), graph);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "/rpc/trust_graph");
  assert.deepEqual(JSON.parse(seen[0].body), { payload: {} });
  const claims = JSON.parse(Buffer.from(seen[0].authorization.split(".")[1], "base64url"));
  assert.equal(claims.role, "junctura_trust_api");
  assert.deepEqual([claims.tenant_id, claims.sub, claims.client_id], ["tenant-a", "approver", "management"]);
});

test("permission errors, bad requests and outages fail closed", async () => {
  reply = { status: 403, error: "trust_permission_required" };
  assert.equal((await get()).status, 403);
  reply = { status: 200, value: graph };
  assert.equal((await get({ path: "/v1/trust/graph?tenant=tenant-b" })).status, 400, "no caller-chosen scope");
  assert.equal((await get({ method: "POST" })).status, 405);
  reply = "down";
  assert.equal((await get()).status, 503);
  reply = { status: 200, value: { nodes: "x" } };
  assert.equal((await get()).status, 503, "malformed database answer is rejected");
  reply = { status: 200, value: { ...graph, readOnly: "yes" } };
  assert.equal((await get()).status, 503, "a non-boolean readOnly is rejected");
  reply = { status: 200, value: graph };
});

test("the readOnly flag passes through unchanged", async () => {
  reply = { status: 200, value: writerGraph };
  const response = await get();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).readOnly, false, "writers and approvers are not read-only");
  reply = graph;
});

test("migration 028 grants audit.read tenant access and marks pure viewers read-only", () => {
  const sql = readFileSync(new URL("../infra/postgres/028-trust-graph-read.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE OR REPLACE FUNCTION core\.trust_graph\(payload jsonb\) RETURNS jsonb/);
  assert.match(sql, /SET LOCAL ROLE junctura_app_owner/);
  assert.match(sql, /LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog/);
  assert.match(sql, /ARRAY\['trust\.write','trust\.approve','audit\.read'\]::text\[\]/, "audit.read is accepted");
  assert.match(sql, /perms IS NULL OR NOT \(perms && ARRAY\['trust\.write','trust\.approve','audit\.read'\]::text\[\]\)/, "empty or unrelated permissions still fail closed");
  assert.match(sql, /administrator:='trust\.approve'=ANY\(perms\)/);
  assert.match(sql, /auditor:='audit\.read'=ANY\(perms\)/);
  assert.match(sql, /readOnly:=NOT administrator AND NOT 'trust\.write'=ANY\(perms\)/);
  assert.match(sql, /g\.issuer=iss AND \(administrator OR auditor OR p\.owner_subject=who\)/, "auditors see the whole tenant");
  assert.match(sql, /'scope',CASE WHEN administrator OR auditor THEN 'tenant' ELSE 'owned' END/);
  assert.match(sql, /'readOnly',readOnly/);
  assert.match(sql, /ALTER FUNCTION core\.trust_graph\(jsonb\) OWNER TO junctura_app_owner/);
  assert.match(sql, /REVOKE ALL ON FUNCTION core\.trust_graph\(jsonb\) FROM PUBLIC/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION core\.trust_graph\(jsonb\) TO junctura_trust_api/);
  assert.match(sql, /INSERT INTO core\.schema_migrations\(version\) VALUES\(28\)/);
  assert.match(sql, /NOTIFY pgrst,'reload schema'/);
});

test("migration 019 stays unchanged with its original permission gate", () => {
  const sql = readFileSync(new URL("../infra/postgres/019-trust-graph.sql", import.meta.url), "utf8");
  assert.match(sql, /perms && ARRAY\['trust\.write','trust\.approve'\]::text\[\]/, "original writer/approver gate preserved");
  assert.match(sql, /INSERT INTO core\.schema_migrations\(version\) VALUES\(19\)/);
  assert.doesNotMatch(sql, /audit\.read/, "migration 019 is not modified to accept audit.read");
  assert.doesNotMatch(sql, /readOnly/);
});
