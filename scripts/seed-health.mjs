// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Seed the running local stack with the fictional "Junctura Health" scenario.
// Records and objects are written only through the real v2 HTTP API of an active,
// resource-enabled Layer-2 application. Application enrollment uses the project's
// reviewed local operator helper (scripts/lib/demo-stack.mjs), exactly like
// `npm run app:enroll` / `npm run trust:demo`. Only presentation-only principal
// profiles use the reviewed local SQL helper; business data never does.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  APPROVER_PERMISSIONS,
  OWNER_PERMISSIONS,
  connectDemoStack,
  enrollApplication,
  q,
  step,
} from "./lib/demo-stack.mjs";
import {
  DEFAULT_SEED,
  HEALTH_APPS,
  HEALTH_CAPABILITIES,
  HEALTH_RELATIONS,
  RECORD_COLLECTIONS,
  eicarTestBytes,
  generateHealthDataset,
  objectIdFor,
} from "./lib/seed-health-data.mjs";
import {
  HEALTH_FILE_PLAN,
  plannedDocuments,
  resolveObjectsUrl,
  seedNamedFiles,
} from "./lib/seed-health-files.mjs";
import {
  fetchPasswordToken,
  loginHints,
  seedAdminConsents,
  seedApprovalQueue,
  seedPrincipalProfiles,
  seedWorkflows,
} from "./lib/seed-health-operations.mjs";

const DEFAULT_BASE = "http://127.0.0.1:8080";
const run = promisify(execFile);

async function refreshWorkflowDefinitions() {
  try {
    await run("docker", ["compose", "run", "--rm", "--no-deps", "workflow-init"], {
      timeout: 120000, maxBuffer: 1024 * 1024,
    });
  } catch {
    step("Bỏ qua nạp định nghĩa quy trình: engine chưa sẵn sàng hoặc thiếu Docker");
  }
}

export function parseArgs(argv) {
  const options = { tenant: "tenant-a", seed: DEFAULT_SEED, enroll: true, capabilities: true, help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--tenant") options.tenant = argv[++index];
    else if (arg === "--seed") options.seed = Number(argv[++index]);
    else if (arg === "--skip-apps") options.enroll = false;
    else if (arg === "--skip-capabilities") options.capabilities = false;
    else throw new Error(`Unknown argument ${arg}`);
  }
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(options.tenant ?? "")) throw new Error("Invalid --tenant");
  if (!Number.isSafeInteger(options.seed)) throw new Error("Invalid --seed");
  return options;
}

export async function fetchClientToken({ baseUrl, clientId, clientSecret, fetchImpl = fetch }) {
  const response = await fetchImpl(`${baseUrl}/identity/realms/junctura/protocol/openid-connect/token`, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Client credential token request failed (${response.status})`);
  const value = await response.json();
  if (typeof value.access_token !== "string" || !value.access_token) throw new Error("Token response is missing access_token");
  return value.access_token;
}

// Records and files are split across the scenario applications so the
// aggregate console view shows genuinely different sizes. "so-suc-khoe" keeps
// the complete health record; the others hold the subset they would own in the
// fictional flow. Every row still goes through that application's own v2 token.
export const HEALTH_RECORD_PLAN = {
  "tram-y-te": { "benh-nhan": [0, 12], "chuyen-tuyen": [0, 15] },
  "benh-vien": { "chuyen-tuyen": [15, 30] },
  "nha-thuoc": { "don-thuoc": [0, 25] },
  "bao-hiem": { "don-thuoc": [25, 40] },
  "so-suc-khoe": { "benh-nhan": [0, null], "chuyen-tuyen": [0, null], "don-thuoc": [0, null] },
};

function slice(rows, [start, end]) {
  return end === null ? rows.slice(start) : rows.slice(start, end);
}

export function plannedRecords(appName, dataset) {
  const plan = HEALTH_RECORD_PLAN[appName];
  if (!plan) return RECORD_COLLECTIONS.map(({ collection }) => [collection, dataset[collection]]);
  return Object.entries(plan).map(([collection, range]) => [collection, slice(dataset[collection], range)]);
}

export { HEALTH_FILE_PLAN, plannedDocuments };

export function createHealthClient({ baseUrl, token, fetchImpl = fetch }) {
  const request = async (path, options = {}) => {
    const response = await fetchImpl(baseUrl + path, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...options.headers },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 200);
      throw new Error(`${options.method ?? "GET"} ${path} failed (${response.status}): ${detail}`);
    }
    return response;
  };
  return {
    async listRecords(collection) {
      const response = await request(`/v2/data/${collection}?limit=100`);
      const body = await response.json();
      return Array.isArray(body.items) ? body.items : [];
    },
    async createRecord(collection, data) {
      const response = await request(`/v2/data/${collection}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data }),
      });
      return response.json();
    },
    async putObject(id, bytes) {
      const response = await request(`/v2/objects/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: bytes,
      });
      await response.arrayBuffer();
      return { created: response.status === 201 };
    },
    async probeObject(id, bytes) {
      const response = await fetchImpl(`${baseUrl}/v2/objects/${id}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
        body: bytes,
        signal: AbortSignal.timeout(30000),
      });
      await response.arrayBuffer();
      return response.status;
    },
  };
}

export async function seedHealth({ client, clients, dataset, log = () => {} }) {
  const targets = clients && Object.keys(clients).length ? clients : { "so-suc-khoe": client };
  if (!targets || Object.values(targets).some((value) => !value)) throw new Error("Thiếu client ứng dụng để nạp dữ liệu");
  const stats = { objectsCreated: 0, objectsExisting: 0, recordsCreated: 0, recordsExisting: 0,
    byCollection: {}, byApplication: {}, malwareBlocked: false };
  for (const [appName, target] of Object.entries(targets)) {
    const appStats = { objectsCreated: 0, objectsExisting: 0, recordsCreated: 0, recordsExisting: 0 };
    const documents = plannedDocuments(appName, dataset);
    for (const document of documents) {
      const result = await target.putObject(document.id, Buffer.from(document.content, "utf8"));
      if (result.created) appStats.objectsCreated++;
      else appStats.objectsExisting++;
    }
    stats.objectsCreated += appStats.objectsCreated;
    stats.objectsExisting += appStats.objectsExisting;
    log(`• ${appName} — tệp: ${appStats.objectsCreated} mới, ${appStats.objectsExisting} đã có`);
    for (const [collection, rows] of plannedRecords(appName, dataset)) {
      const key = RECORD_COLLECTIONS.find(item => item.collection === collection).key;
      const existing = await target.listRecords(collection);
      const seen = new Set(existing.map(row => row.data?.[key]).filter(value => typeof value === "string"));
      let created = 0;
      for (const record of rows) {
        if (seen.has(record[key])) continue;
        await target.createRecord(collection, record);
        seen.add(record[key]);
        created++;
      }
      appStats.recordsCreated += created;
      appStats.recordsExisting += rows.length - created;
      const byCollection = stats.byCollection[collection] ?? { created: 0, existing: 0 };
      byCollection.created += created;
      byCollection.existing += rows.length - created;
      stats.byCollection[collection] = byCollection;
      log(`• ${appName} — ${collection}: ${created} mới, ${rows.length - created} đã có`);
    }
    stats.recordsCreated += appStats.recordsCreated;
    stats.recordsExisting += appStats.recordsExisting;
    stats.byApplication[appName] = appStats;
  }
  const probe = targets["so-suc-khoe"] ?? Object.values(targets)[0];
  if (typeof probe?.probeObject === "function") {
    const verdict = await probe.probeObject(objectIdFor("malware:eicar"), eicarTestBytes());
    stats.malwareBlocked = verdict === 422;
    log(stats.malwareBlocked
      ? "• Kiểm thử cách ly: ClamAV đã chặn tệp thử EICAR; tệp không được công bố"
      : `• Kiểm thử cách ly: ClamAV chưa chặn tệp thử EICAR (HTTP ${verdict})`);
  }
  return stats;
}

async function serviceSecret(stack, clientId) {
  const clients = await (await stack.admin(`clients?clientId=${encodeURIComponent(clientId)}`)).json();
  const client = clients.find(value => value.clientId === clientId);
  if (!client) throw new Error(`Keycloak client ${clientId} is missing but the application exists`);
  const response = await stack.admin(`clients/${client.id}/client-secret`);
  if (!response.ok) throw new Error(`Không đọc được bí mật client ${clientId} (${response.status})`);
  return (await response.json()).value;
}

async function ensureHealthApps(stack, owner, approver) {
  const apps = {};
  for (const app of HEALTH_APPS) {
    const clientId = `app-${app.name}`;
    const row = await stack.sql(`SELECT a.app_id||'|'||a.state||'|'||coalesce(e.resource_subject,'') FROM app_private.applications a
      JOIN app_private.enrollments e ON (e.tenant_id,e.issuer,e.oauth_client_id)=(a.tenant_id,a.issuer,a.oauth_client_id)
      WHERE a.tenant_id=${q(stack.tenant)} AND a.issuer=${q(stack.issuer)} AND a.oauth_client_id=${q(clientId)};`);
    let appId, subject, clientSecret;
    if (row) {
      const [existingId, state, existingSubject] = row.split("|");
      if (state !== "active") throw new Error(`${clientId} is ${state}; reactivate it or use another tenant`);
      if (!existingSubject) throw new Error(`${clientId} has no resource subject; set it with the reviewed operator enrollment`);
      appId = existingId;
      subject = existingSubject;
      clientSecret = await serviceSecret(stack, clientId);
      step(`${app.displayName} đã sẵn sàng`);
    } else {
      step(`Đăng ký ${app.displayName}`);
      const enrolled = await enrollApplication(stack, {
        clientId,
        origin: `https://${clientId}.junctura.local`,
        displayName: app.displayName,
      }, owner, approver);
      appId = enrolled.app.appId;
      subject = enrolled.subject;
      clientSecret = enrolled.clientSecret;
    }
    apps[app.name] = {
      appId,
      subject,
      token: await fetchClientToken({ baseUrl: stack.base, clientId, clientSecret }),
    };
  }
  return apps;
}

function healthManifest(template, appId, capability) {
  return {
    ...structuredClone(template),
    capabilityId: `urn:junctura:capability:${appId}:${capability.name}`,
    providerAppId: appId,
    version: "1.0.0",
    title: capability.title,
    description: capability.description,
    invocation: { ...template.invocation, path: `/capabilities/${capability.name}` },
    requiredPermissions: [`urn:junctura:permission:${appId}:invoke`],
  };
}

async function publishCapability(stack, template, apps, capability, owner, approver) {
  const { api, must } = stack;
  const appId = apps[capability.app].appId;
  const manifest = healthManifest(template, appId, capability);
  const path = `/v1/capabilities/${encodeURIComponent(manifest.capabilityId)}/versions`;
  let response = await api(`${path}/1.0.0`, owner.token);
  if (response.status === 404) response = await must(await api(path, owner.token, manifest), [201], `Register ${capability.title}`);
  else await must(response, [200], `Read ${capability.title}`);
  let etag = response.headers.get("etag");
  let value = await response.json();
  if (value.state === "draft") {
    const validated = await must(await api(`${path}/1.0.0/validate`, owner.token, {}, { "If-Match": etag }), [200], `Validate ${capability.title}`);
    etag = validated.headers.get("etag") ?? etag;
    value = { ...value, ...(await validated.json()) };
    const decision = await must(await api("/v1/approvals", approver.token, {
      resourceType: "capability-version",
      resourceId: `${manifest.capabilityId}@1.0.0`,
      resourceDigest: value.digest,
      resourceRevision: value.revision,
      requesterSubject: owner.id,
      requesterAppId: appId,
      decision: "approve",
      expiresAt: new Date(Date.now() + 120000).toISOString(),
    }), [201], "Approve capability publication");
    const published = await must(await api(`${path}/1.0.0/publish`, owner.token,
      { approvalId: (await decision.json()).approvalId }, { "If-Match": etag }), [200], `Publish ${capability.title}`);
    value = await published.json();
    return { result: "published", value };
  }
  if (value.state === "published") return { result: "existing", value };
  throw new Error(`${capability.title} is ${value.state}; use another tenant for a fresh scenario`);
}

async function publishCapabilities(stack, template, apps, owner, approver, log) {
  const count = { published: 0, existing: 0 };
  const published = {};
  for (const capability of HEALTH_CAPABILITIES) {
    const outcome = await publishCapability(stack, template, apps, capability, owner, approver);
    count[outcome.result]++;
    published[`${capability.app}/${capability.name}`] = outcome.value;
  }
  log(`Năng lực Tầng 2: ${count.published} mới, ${count.existing} đã công bố`);
  return { count, published };
}

export function findActiveRelation(edges, relation, apps, capability) {
  const providerAppId = apps[relation.provider]?.appId;
  const consumerAppId = apps[relation.consumer]?.appId;
  return edges.find((edge) =>
    edge.providerAppId === providerAppId &&
    edge.consumerAppId === consumerAppId &&
    edge.capabilityId === capability.capabilityId &&
    edge.version === capability.version &&
    (edge.state === "active" || edge.state === "pending")
  );
}

export async function ensureHealthRelations({ api, owner, approver, apps, published, log = () => {} }) {
  const graph = await api("/v1/trust/graph", approver.token);
  if (!graph.ok) throw new Error(`GET /v1/trust/graph failed (${graph.status})`);
  const edges = (await graph.json()).edges;
  if (!Array.isArray(edges)) throw new Error("Trust graph response is missing edges");
  const stats = { created: 0, existing: 0 };
  for (const relation of HEALTH_RELATIONS) {
    const capability = published[`${relation.provider}/${relation.capability}`];
    if (!capability) throw new Error(`Năng lực ${relation.provider}/${relation.capability} chưa được công bố`);
    const provider = apps[relation.provider];
    const consumer = apps[relation.consumer];
    if (!provider || !consumer) throw new Error(`Thiếu ứng dụng cho quan hệ ${relation.provider} → ${relation.consumer}`);
    if (findActiveRelation(edges, relation, apps, capability)) {
      stats.existing++;
      log(`Quan hệ ${relation.provider} → ${relation.consumer} (${capability.manifest.title}) đã có`);
      continue;
    }
    const created = await api("/v1/trust/grants", owner.token, {
      providerAppId: provider.appId,
      consumerAppId: consumer.appId,
      capabilities: [{ capabilityId: capability.capabilityId, version: capability.version, manifestDigest: capability.digest }],
      operations: ["discover", "invoke"],
      permissions: capability.manifest.requiredPermissions,
      subjectIds: [consumer.subject],
      expiresAt: new Date(Date.now() + 180 * 86_400_000).toISOString(),
      delegationAllowed: false,
      acceptDelegation: false,
    });
    if (created.status !== 201) {
      throw new Error(`POST /v1/trust/grants failed (${created.status}): ${(await created.text()).slice(0, 200)}`);
    }
    const proposal = await created.json();
    const decision = await api("/v1/approvals", approver.token, {
      resourceType: "grant",
      resourceId: proposal.grantId,
      resourceDigest: proposal.digest,
      resourceRevision: proposal.revision,
      requesterSubject: owner.id,
      requesterAppId: provider.appId,
      decision: "approve",
      expiresAt: new Date(Date.now() + 120000).toISOString(),
    });
    if (decision.status !== 201) {
      throw new Error(`POST /v1/approvals failed (${decision.status}): ${(await decision.text()).slice(0, 200)}`);
    }
    const activated = await api(`/v1/trust/grants/${proposal.grantId}/activate`, approver.token,
      { approvalId: (await decision.json()).approvalId },
      { "If-Match": created.headers.get("etag") ?? "" });
    if (activated.status !== 200) {
      throw new Error(`Activating grant ${proposal.grantId} failed (${activated.status}): ${(await activated.text()).slice(0, 200)}`);
    }
    const activatedGrant = await activated.json();
    edges.push({ ...activatedGrant, providerAppId: provider.appId, consumerAppId: consumer.appId,
      capabilityId: capability.capabilityId, version: capability.version, state: activatedGrant.state ?? "active" });
    stats.created++;
    log(`Quan hệ ${relation.provider} → ${relation.consumer} (${capability.manifest.title}) đã tạo`);
  }
  return stats;
}

const usage = `Cách dùng: npm run seed:health -- [--tenant tenant-a] [--seed 20261110] [--skip-apps] [--skip-capabilities]
Tạo dữ liệu bối cảnh y tế hư cấu qua API thật: hồ sơ quy trình, việc cần duyệt,
đồng ý, bản ghi và tệp. Với --skip-apps, đặt SEED_HEALTH_CLIENT_ID và
SEED_HEALTH_CLIENT_SECRET cho một ứng dụng đã đăng ký và có resource_subject.`;

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage);
    return;
  }
  const baseUrl = env.JUNCTURA_URL ?? env.PUBLIC_URL ?? DEFAULT_BASE;
  const dataset = generateHealthDataset({ seed: options.seed });
  let clients;
  let apps;
  if (options.enroll) {
    const stack = await connectDemoStack({ tenant: options.tenant, base: baseUrl });
    await stack.ensureManagementClient();
    step("Người vận hành demo và người duyệt độc lập");
    const owner = await stack.human("owner", OWNER_PERMISSIONS);
    const approver = await stack.human("approver", APPROVER_PERMISSIONS);
    apps = await ensureHealthApps(stack, owner, approver);
    await seedPrincipalProfiles({ stack, apps, log: step });
    if (options.capabilities) {
      const template = JSON.parse(readFileSync(new URL("../docs/contracts/examples/capability-manifest.json", import.meta.url), "utf8"));
      const { published } = await publishCapabilities(stack, template, apps, owner, approver, step);
      const relations = await ensureHealthRelations({ api: stack.api, owner, approver, apps, published, log: step });
      console.log(`Quan hệ tin cậy Tầng 2: ${relations.created} mới, ${relations.existing} đã có.`);
      const graphResponse = await stack.api("/v1/trust/graph", approver.token);
      if (graphResponse.ok) {
        const graph = await graphResponse.json();
        await seedApprovalQueue({ api: stack.api, edges: graph.edges ?? [], owner, apps, published, log: step });
      } else {
        step("Bỏ qua đề xuất chờ duyệt: không đọc được sơ đồ tin cậy");
      }
      await seedAdminConsents({ api: stack.api, baseUrl, env, apps, published, log: step });
    }
    await refreshWorkflowDefinitions();
    await seedWorkflows({ api: stack.api, token: owner.token, dataset, log: step });
    clients = Object.fromEntries(Object.entries(apps).map(([name, app]) => [
      name, createHealthClient({ baseUrl, token: app.token }),
    ]));
  } else {
    if (!env.SEED_HEALTH_CLIENT_ID || !env.SEED_HEALTH_CLIENT_SECRET) {
      throw new Error("Thiếu SEED_HEALTH_CLIENT_ID/SEED_HEALTH_CLIENT_SECRET cho ứng dụng đã đăng ký (hoặc bỏ --skip-apps)");
    }
    const token = await fetchClientToken({ baseUrl, clientId: env.SEED_HEALTH_CLIENT_ID, clientSecret: env.SEED_HEALTH_CLIENT_SECRET });
    clients = { "so-suc-khoe": createHealthClient({ baseUrl, token }) };
  }
  const stats = await seedHealth({ clients, dataset, log: message => console.log(message) });
  try {
    const objectsUrl = await resolveObjectsUrl({ baseUrl });
    const fileStats = await seedNamedFiles({ clients, tenant: options.tenant, apps,
      dataset, objectsUrl, log: step });
    console.log(`  Cây thư mục: ${fileStats.filesCreated} tệp mới, ${fileStats.filesExisting} đã có;` +
      ` ${fileStats.objectsCreated} đối tượng mới, ${fileStats.objectsExisting} đã có.`);
  } catch (error) {
    step(`Bỏ qua cây thư mục: ${error.message}`);
  }
  console.log(`\n✔ Dữ liệu bối cảnh y tế sẵn sàng cho ${options.tenant}.`);
  console.log(`  Bản ghi mới: ${stats.recordsCreated}, đã có: ${stats.recordsExisting}; tệp mới: ${stats.objectsCreated}, đã có: ${stats.objectsExisting}.`);
  console.log(`  Xem bằng tài khoản quản trị Console hoặc qua API v2 của ứng dụng Sổ sức khỏe.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`✖ ${error.message}`); process.exitCode = 1; });
}
