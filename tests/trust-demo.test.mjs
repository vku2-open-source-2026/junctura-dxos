// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DEMO_APPS, DEMO_CAPABILITIES, DEMO_GRANTS, clientIdFor, envFileFor, existingGrant, manifestFor, parseArgs, seedTrust } from "../scripts/trust-demo.mjs";
import { validateManifest } from "../src/modules/capability/registry/manifest.mjs";

const template = JSON.parse(readFileSync(new URL("../docs/contracts/examples/capability-manifest.json", import.meta.url), "utf8"));
const appId = "22222222-2222-4222-8222-222222222222";

test("trust:demo parses only seed, token and a valid tenant", () => {
  assert.deepEqual(parseArgs([]), { command: "seed", tenant: "tenant-a" });
  assert.deepEqual(parseArgs(["token", "--tenant", "tenant-b"]), { command: "token", tenant: "tenant-b" });
  for (const argv of [["bogus"], ["--tenant", "Bad_Tenant"], ["--tenant"]]) assert.throws(() => parseArgs(argv), undefined, JSON.stringify(argv));
});

test("tenant-a keeps its client IDs and env filenames; all other tenants are qualified", () => {
  for (const { name } of DEMO_APPS) {
    assert.equal(clientIdFor("tenant-a", name), `app-${name}`);
    assert.equal(envFileFor("tenant-a", name), `.env.app.${name}.local`);
    for (const tenant of ["demo", "production", "tenant-b", "demo-extra"]) {
      assert.equal(clientIdFor(tenant, name), `app-${tenant}-${name}`);
      assert.equal(envFileFor(tenant, name), `.env.app.${tenant}.${name}.local`);
    }
  }
});

test("seedTrust reuses a complete seed and returns the context for further seeding", async (t) => {
  t.mock.method(console, "log", () => {});
  const tenant = "demo", queries = [], humans = [];
  const ids = Object.fromEntries(DEMO_APPS.map(({ name }, index) => [name, `22222222-2222-4222-8222-22222222222${index}`]));
  const subjects = Object.fromEntries(DEMO_APPS.map(({ name }) => [name, `subject-${name}`]));
  const published = Object.fromEntries(DEMO_CAPABILITIES.map(capability => {
    const manifest = manifestFor(template, ids[capability.provider], capability);
    return [`${capability.provider}/${capability.name}`, { capabilityId: manifest.capabilityId, version: "1.0.0", state: "published", manifest }];
  }));
  const stack = {
    tenant, issuer: "https://gateway.example.invalid/identity/realms/junctura",
    human: async label => { humans.push(label); return { id: label, token: `${label}-fixture` }; },
    sql: async query => {
      queries.push(query);
      const app = DEMO_APPS.find(({ name }) => query.includes(`'${clientIdFor(tenant, name)}'`));
      assert.ok(app, "queries use tenant-qualified client IDs");
      assert.ok(query.includes("a.tenant_id='demo'"));
      return `${ids[app.name]}|active|${subjects[app.name]}`;
    },
    must: async (response, statuses) => { assert.ok(statuses.includes(response.status)); return response; },
    api: async (path, token, body) => {
      assert.equal(body, undefined, "a complete seed makes no Gateway writes");
      if (path === "/v1/trust/graph") return Response.json({ edges: DEMO_GRANTS.map(grant => ({
        providerAppId: ids[grant.provider], consumerAppId: ids[grant.consumer],
        capabilityId: published[`${grant.provider}/${grant.capability}`].capabilityId, version: "1.0.0", state: grant.target,
      })) });
      const capability = Object.values(published).find(value => path === `/v1/capabilities/${encodeURIComponent(value.capabilityId)}/versions/1.0.0`);
      assert.ok(capability);
      return Response.json(capability);
    },
  };
  const result = await seedTrust(stack, { tenant });
  assert.deepEqual(result.ids, ids);
  assert.deepEqual(result.subjects, subjects);
  assert.deepEqual(Object.keys(result.published), Object.keys(published));
  assert.equal(result.owner.id, "owner");
  assert.equal(result.approver.id, "approver");
  assert.deepEqual(humans, ["owner", "approver"]);
  assert.equal(queries.length, 4);
});

test("seedTrust rejects a mismatched or invalid tenant before accessing the stack", async () => {
  for (const tenant of ["tenant-a", "bad_tenant", undefined]) {
    await assert.rejects(seedTrust({ tenant: "demo" }, { tenant: tenant ?? "" }), /Invalid seed tenant/);
  }
});

test("every demo manifest passes the real registry validator", () => {
  for (const capability of DEMO_CAPABILITIES) {
    const manifest = manifestFor(template, appId, capability);
    assert.equal(manifest.capabilityId, `urn:junctura:capability:${appId}:${capability.name}`);
    assert.deepEqual(manifest.requiredPermissions, [`urn:junctura:permission:${appId}:invoke`]);
    assert.deepEqual(validateManifest(manifest, { capabilityId: manifest.capabilityId, version: "1.0.0" }), [], capability.name);
  }
  assert.equal(template.title, "Technical echo", "the shared template is not mutated");
});

test("demo grants reference demo apps and capabilities and cover every graph state", () => {
  const apps = new Set(DEMO_APPS.map(app => app.name));
  const capabilities = new Set(DEMO_CAPABILITIES.map(c => `${c.provider}/${c.name}`));
  for (const grant of DEMO_GRANTS) {
    assert.ok(apps.has(grant.provider) && apps.has(grant.consumer) && grant.provider !== grant.consumer);
    assert.ok(capabilities.has(`${grant.provider}/${grant.capability}`));
    assert.ok(grant.days > 0 && grant.operations.length > 0);
  }
  assert.deepEqual([...new Set(DEMO_GRANTS.map(g => g.target))].sort(), ["active", "pending", "revoked"]);
  assert.ok(DEMO_GRANTS.some(g => g.target === "active" && g.days < 7), "one grant shows as expiring soon");
});

test("demo data keeps its shape and uses the neutral organisation-wide apps", () => {
  assert.equal(DEMO_APPS.length, 4);
  assert.equal(DEMO_CAPABILITIES.length, 3);
  assert.deepEqual(DEMO_GRANTS.map(g => g.target), ["active", "active", "active", "pending", "revoked"]);
  for (const app of DEMO_APPS) assert.match(app.name, /^[a-z][a-z0-9-]{1,39}$/);
  for (const capability of DEMO_CAPABILITIES) assert.match(capability.name, /^[a-z][a-z0-9-]{0,62}$/);
  assert.deepEqual(DEMO_APPS.map(app => app.name), ["danhba", "vanban", "lichhop", "thongbao"]);
  assert.deepEqual(DEMO_CAPABILITIES.map(c => `${c.provider}/${c.name}`), ["danhba/contact-lookup", "vanban/document-summary", "lichhop/availability"]);
});

test("re-running reuses live grants but recreates expired or revoked ones", () => {
  const ids = { danhba: "a", vanban: "b" };
  const grant = { provider: "danhba", consumer: "vanban", target: "active" };
  const edge = state => ({ providerAppId: "a", consumerAppId: "b", capabilityId: "cap", version: "1.0.0", state });
  assert.ok(existingGrant([edge("active")], grant, ids, "cap"));
  assert.ok(existingGrant([edge("pending")], grant, ids, "cap"));
  assert.equal(existingGrant([edge("expired"), edge("revoked")], grant, ids, "cap"), undefined);
  assert.equal(existingGrant([edge("active")], grant, ids, "other"), undefined);
  assert.ok(existingGrant([edge("revoked")], { ...grant, target: "revoked" }, ids, "cap"));
});
