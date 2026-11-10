// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Operational seed steps for the fictional Junctura Health scenario. Every
// business row is written through the real HTTP API; only principal presentation
// profiles use the reviewed local operator SQL helper. Nothing here logs secrets.
import { readFileSync } from "node:fs";
import { q } from "./demo-stack.mjs";
import { objectIdFor } from "./seed-health-data.mjs";

export const WORKFLOW_DEFINITION_KEYS = [
  "junctura_chuyen_tuyen",
  "junctura_xac_minh_don_thuoc",
  "junctura_xac_minh_chi_phi",
];
export const ADMIN_PROFILES = [
  { username: "admin1", displayName: "Quản trị viên 1", jobTitle: "Quản trị nền tảng" },
  { username: "admin2", displayName: "Quản trị viên 2", jobTitle: "Người duyệt ứng dụng" },
  { username: "admin3", displayName: "Quản trị viên 3", jobTitle: "Người duyệt năng lực" },
];
export const APPLICATION_PROFILES = [
  { name: "benh-vien", clientId: "app-benh-vien", displayName: "Bệnh viện" },
  { name: "so-suc-khoe", clientId: "app-so-suc-khoe", displayName: "Sổ sức khỏe" },
];

const approvalQueueTargets = [
  { key: "pending-schedule", provider: "benh-vien", consumer: "nha-thuoc", capability: "lich-kham", outcome: "pending" },
  { key: "pending-claim", provider: "bao-hiem", consumer: "tram-y-te", capability: "xac-minh-chi-phi", outcome: "pending" },
  { key: "rejected-record", provider: "so-suc-khoe", consumer: "bao-hiem", capability: "ho-so-suc-khoe", outcome: "rejected" },
];

const consentTargets = [
  { consumer: "benh-vien", capability: "so-suc-khoe/pre-visit-summary", purposes: ["treatment", "referral"], days: 120, outcome: "active" },
  { consumer: "bao-hiem", capability: "so-suc-khoe/ho-so-suc-khoe", purposes: ["insurance_claim"], days: 60, outcome: "active" },
  { consumer: "nha-thuoc", capability: "tram-y-te/tra-cuu-benh-nhan", purposes: ["treatment"], days: 30, outcome: "revoked" },
];

function referralInput(referral, patient) {
  return {
    loai: "chuyen-tuyen",
    ma_ho_so: referral.ma_chuyen_tuyen,
    ma_benh_nhan: referral.ma_benh_nhan,
    ho_ten_benh_nhan: patient.ho_ten,
    co_so_gui: referral.tu_co_so,
    co_so_nhan: referral.den_co_so,
    chan_doan: referral.chan_doan,
    ly_do: referral.ly_do,
    muc_do_uu_tien: referral.muc_do_uu_tien,
    ngay_tao: referral.ngay_chuyen,
  };
}

function prescriptionInput(prescription, patient) {
  return {
    loai: "xac-minh-don-thuoc",
    ma_ho_so: prescription.ma_don_thuoc,
    ma_benh_nhan: prescription.ma_benh_nhan,
    ho_ten_benh_nhan: patient.ho_ten,
    nha_thuoc: prescription.nha_thuoc,
    co_so_bao_hiem: prescription.co_so_bao_hiem,
    so_thuoc: prescription.thuoc.length,
    ngay_ke: prescription.ngay_ke,
  };
}

function claimInput(referral) {
  return {
    loai: "xac-minh-chi-phi",
    ma_ho_so: `BH-${referral.ma_chuyen_tuyen.replace(/^CT-/, "")}`,
    co_so_gui: referral.tu_co_so,
    co_so_nhan: referral.den_co_so,
    ngay_tao: referral.ngay_chuyen,
  };
}

// Deterministic, idempotent business workflow requests: some still wait for a
// decision, some were approved (completed) and some were rejected (cancelled).
// Keys are namespaced so a rerun never rewrites an older technical checkpoint.
export function workflowSeedItems(dataset) {
  const patients = new Map(dataset["benh-nhan"].map(patient => [patient.ma_benh_nhan, patient]));
  const referrals = dataset["chuyen-tuyen"];
  const prescriptions = dataset["don-thuoc"];
  const plan = [
    { key: "chuyen-tuyen-01", definitionKey: "junctura_chuyen_tuyen", outcome: "pending", type: "referral", index: 0 },
    { key: "chuyen-tuyen-02", definitionKey: "junctura_chuyen_tuyen", outcome: "approved", type: "referral", index: 1 },
    { key: "chuyen-tuyen-03", definitionKey: "junctura_chuyen_tuyen", outcome: "rejected", type: "referral", index: 2 },
    { key: "chuyen-tuyen-04", definitionKey: "junctura_chuyen_tuyen", outcome: "pending", type: "referral", index: 3 },
    { key: "don-thuoc-01", definitionKey: "junctura_xac_minh_don_thuoc", outcome: "pending", type: "prescription", index: 0 },
    { key: "don-thuoc-02", definitionKey: "junctura_xac_minh_don_thuoc", outcome: "approved", type: "prescription", index: 1 },
    { key: "don-thuoc-03", definitionKey: "junctura_xac_minh_don_thuoc", outcome: "approved", type: "prescription", index: 2 },
    { key: "chi-phi-01", definitionKey: "junctura_xac_minh_chi_phi", outcome: "pending", type: "claim", index: 4 },
    { key: "chi-phi-02", definitionKey: "junctura_xac_minh_chi_phi", outcome: "approved", type: "claim", index: 5 },
  ];
  return plan.map((item) => {
    const source = item.type === "prescription" ? prescriptions[item.index] : referrals[item.index];
    const patient = source ? patients.get(source.ma_benh_nhan) : undefined;
    if (!source || (item.type !== "claim" && !patient)) throw new Error(`Thiếu dữ liệu nguồn cho ${item.key}`);
    const input = item.type === "claim"
      ? claimInput(source)
      : item.type === "referral"
        ? referralInput(source, patient)
        : prescriptionInput(source, patient);
    return {
      key: item.key,
      definitionKey: item.definitionKey,
      outcome: item.outcome,
      idempotencyKey: objectIdFor(`workflow-business:${item.key}`),
      input,
    };
  });
}

function definitionFrom(definitions, key) {
  return definitions instanceof Map ? definitions.get(key) : definitions?.[key];
}

export async function seedWorkflowRequests({ api, token, definitions, items, log = () => {} }) {
  const stats = { created: 0, existing: 0, completed: 0, cancelled: 0, pending: 0 };
  for (const item of items) {
    const definition = definitionFrom(definitions, item.definitionKey);
    if (!definition) throw new Error(`Chưa có định nghĩa quy trình ${item.definitionKey}`);
    const response = await api("/v1/workflows/executions", token, { definitionId: definition.id, input: item.input },
      { "Idempotency-Key": item.idempotencyKey });
    if (![200, 201].includes(response.status)) {
      throw new Error(`Không tạo được hồ sơ ${item.key} (${response.status})`);
    }
    if (response.status === 201) stats.created++;
    else stats.existing++;
    let value = await response.json();
    let guard = 0;
    while (item.outcome === "approved" && value.status === "running" && guard++ < 6) {
      const completed = await api(`/v1/workflows/executions/${encodeURIComponent(value.id)}/complete`, token, {});
      if (!completed.ok) throw new Error(`Không duyệt được hồ sơ ${item.key} (${completed.status})`);
      value = await completed.json();
    }
    if (item.outcome === "approved" && value.status === "running") {
      throw new Error(`Hồ sơ ${item.key} chưa hoàn tất sau khi duyệt đủ các bước`);
    }
    if (item.outcome === "rejected" && value.status === "running") {
      const cancelled = await api(`/v1/workflows/executions/${encodeURIComponent(value.id)}`, token, undefined, {}, "DELETE");
      if (!cancelled.ok) throw new Error(`Không từ chối được hồ sơ ${item.key} (${cancelled.status})`);
      value.status = "cancelled";
    }
    if (value.status === "completed") stats.completed++;
    else if (value.status === "cancelled") stats.cancelled++;
    else stats.pending++;
  }
  log(`Hồ sơ quy trình: ${stats.created} mới, ${stats.existing} đã có; ${stats.pending} đang chờ, ${stats.completed} đã duyệt, ${stats.cancelled} bị từ chối`);
  return stats;
}

function grantBody(target, apps, published) {
  const capability = published[`${target.provider}/${target.capability}`];
  const provider = apps[target.provider];
  const consumer = apps[target.consumer];
  if (!capability || !provider || !consumer) return null;
  return {
    providerAppId: provider.appId,
    consumerAppId: consumer.appId,
    capabilities: [{ capabilityId: capability.capabilityId, version: capability.version, manifestDigest: capability.digest }],
    operations: ["discover", "invoke"],
    permissions: capability.manifest.requiredPermissions,
    subjectIds: [consumer.subject],
    expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
    delegationAllowed: false,
    acceptDelegation: false,
  };
}

export function existingGrant(edges, target, apps, published) {
  const capability = published[`${target.provider}/${target.capability}`];
  const provider = apps[target.provider];
  const consumer = apps[target.consumer];
  if (!capability || !provider || !consumer) return null;
  return edges.find(edge => edge.providerAppId === provider.appId &&
    edge.consumerAppId === consumer.appId &&
    edge.capabilityId === capability.capabilityId && edge.version === capability.version);
}

// Fills the approval queue with real proposals: two wait for an administrator,
// one was proposed and then rejected. Reruns reuse any grant for the same triple.
export async function seedApprovalQueue({ api, edges, owner, apps, published, log = () => {} }) {
  const stats = { pending: 0, rejected: 0, existing: 0 };
  for (const target of approvalQueueTargets) {
    if (existingGrant(edges, target, apps, published)) {
      stats.existing++;
      log(`Đề xuất ${target.provider} → ${target.consumer} đã có`);
      continue;
    }
    const body = grantBody(target, apps, published);
    if (!body) throw new Error(`Thiếu năng lực hoặc ứng dụng cho đề xuất ${target.key}`);
    const response = await api("/v1/trust/grants", owner.token, body);
    if (response.status !== 201) {
      throw new Error(`Không tạo được đề xuất ${target.key} (${response.status})`);
    }
    const proposal = await response.json();
    if (target.outcome === "rejected") {
      const revoked = await api(`/v1/trust/grants/${encodeURIComponent(proposal.grantId)}/revoke`, owner.token,
        { reason: "Không đủ căn cứ chia sẻ dữ liệu cho mục đích này" },
        { "If-Match": `"grant-${proposal.grantId}-${proposal.revision}"` });
      if (revoked.status !== 200) throw new Error(`Không từ chối được đề xuất ${target.key} (${revoked.status})`);
      stats.rejected++;
    } else {
      stats.pending++;
    }
  }
  log(`Việc cần duyệt: ${stats.pending} đề xuất chờ, ${stats.rejected} đã từ chối, ${stats.existing} đã có`);
  return stats;
}

export function consentBody(target, apps, published, now = Date.now()) {
  const consumer = apps[target.consumer];
  const capability = published[target.capability];
  if (!consumer || !capability) return null;
  return {
    consumerAppId: consumer.appId,
    capabilityId: capability.capabilityId,
    purposes: target.purposes,
    expiresAt: new Date(now + target.days * 86_400_000).toISOString(),
  };
}

export async function seedConsents({ api, token, apps, published, now = Date.now(), log = () => {} }) {
  const list = await api("/v1/me/consents", token);
  if (!list.ok) throw new Error(`Không đọc được đồng ý hiện có (${list.status})`);
  const existing = (await list.json()).consents;
  const rows = Array.isArray(existing) ? existing : [];
  const stats = { active: 0, revoked: 0, existing: 0 };
  for (const target of consentTargets) {
    const consumer = apps[target.consumer];
    const capability = published[target.capability];
    if (rows.some(row => row.consumer?.appId === consumer?.appId && row.capabilityId === capability?.capabilityId)) {
      stats.existing++;
      continue;
    }
    const body = consentBody(target, apps, published, now);
    if (!body) throw new Error(`Thiếu năng lực hoặc ứng dụng cho đồng ý ${target.capability}`);
    const created = await api("/v1/me/consents", token, body);
    if (created.status !== 201) throw new Error(`Không tạo được đồng ý ${target.capability} (${created.status})`);
    const value = await created.json();
    if (target.outcome === "revoked") {
      const revoked = await api(`/v1/me/consents/${encodeURIComponent(value.consentId)}/revoke`, token, {});
      if (revoked.status !== 200) throw new Error(`Không thu hồi được đồng ý ${target.capability} (${revoked.status})`);
      stats.revoked++;
    } else {
      stats.active++;
    }
  }
  log(`Đồng ý của người dân: ${stats.active} đang hiệu lực, ${stats.revoked} đã thu hồi, ${stats.existing} đã có`);
  return stats;
}

export async function seedWorkflows({ api, token, dataset, log = () => {} }) {
  const response = await api("/v1/workflows/definitions", token);
  if (!response.ok) {
    log("• Bỏ qua hồ sơ quy trình: chưa đọc được định nghĩa quy trình");
    return null;
  }
  const items = (await response.json()).items ?? [];
  const definitions = new Map(items.map(item => [item.key, item]));
  const planned = workflowSeedItems(dataset);
  const available = planned.filter(item => definitions.has(item.definitionKey));
  const missing = [...new Set(planned.filter(item => !definitions.has(item.definitionKey)).map(item => item.definitionKey))];
  if (missing.length) log(`Bỏ qua hồ sơ quy trình: thiếu định nghĩa ${missing.join(", ")}`);
  if (!available.length) {
    log("Bỏ qua hồ sơ quy trình: chưa có định nghĩa nghiệp vụ đã cài");
    return null;
  }
  log(`Định nghĩa quy trình nghiệp vụ: ${[...new Set(available.map(item => item.definitionKey))].length} quy trình`);
  return seedWorkflowRequests({ api, token, definitions, items: available, log });
}

export async function seedAdminConsents({ api, baseUrl, env, apps, published, log = () => {},
  hintsFile = new URL("../../console/public/login-hints.json", import.meta.url) }) {
  const username = env.SEED_HEALTH_ADMIN_USERNAME ?? "admin1";
  let token = env.SEED_HEALTH_ADMIN_TOKEN;
  if (!token) {
    const hint = loginHints(hintsFile).find(account => account.username === username);
    const password = env.SEED_HEALTH_ADMIN_PASSWORD ?? hint?.password;
    if (!password) {
      log("• Bỏ qua đồng ý: chưa có thông tin đăng nhập quản trị cục bộ (đặt SEED_HEALTH_ADMIN_TOKEN)");
      return null;
    }
    try {
      token = await fetchPasswordToken({ baseUrl, username, password });
    } catch (error) {
      log(`Bỏ qua đồng ý: ${error.message}`);
      return null;
    }
  }
  return seedConsents({ api, token, apps, published, log });
}

export function loginHints(file) {
  try { return JSON.parse(readFileSync(file, "utf8")).accounts ?? []; }
  catch { return []; }
}

export async function fetchPasswordToken({ baseUrl, clientId = "junctura-console", username, password, fetchImpl = fetch }) {
  const response = await fetchImpl(`${baseUrl}/identity/realms/junctura/protocol/openid-connect/token`, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "password", client_id: clientId, username, password }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Đăng nhập quản trị cục bộ thất bại (${response.status})`);
  const value = await response.json();
  if (typeof value.access_token !== "string" || !value.access_token) throw new Error("Thiếu access_token");
  return value.access_token;
}

// Direct, reviewed operator SQL for presentation-only principal profiles. It
// never writes permissions and is safe to run repeatedly.
export async function seedPrincipalProfiles({ stack, apps, log = () => {} }) {
  const { sql, admin, tenant, issuer } = stack;
  const stats = { admins: 0, applications: 0, missing: [] };
  for (const profile of ADMIN_PROFILES) {
    const users = await (await admin(`users?username=${encodeURIComponent(profile.username)}&exact=true`)).json();
    const subject = Array.isArray(users) ? users[0]?.id : undefined;
    if (!subject) { stats.missing.push(profile.username); continue; }
    const updated = await sql(`UPDATE app_private.principals
      SET display_name=${q(profile.displayName)}, organization=${q("Junctura")}, job_title=${q(profile.jobTitle)}, kind='admin'
      WHERE tenant_id=${q(tenant)} AND issuer=${q(issuer)} AND subject=${q(subject)}
      RETURNING subject;`);
    if (updated) stats.admins++; else stats.missing.push(profile.username);
  }
  for (const profile of APPLICATION_PROFILES) {
    const app = apps[profile.name];
    if (!app) { stats.missing.push(profile.name); continue; }
    const updated = await sql(`INSERT INTO app_private.principals
      (tenant_id,issuer,subject,management_client,permissions,display_name,organization,job_title,kind)
      VALUES(${q(tenant)},${q(issuer)},${q(app.subject)},${q(profile.clientId)},ARRAY[]::text[],
        ${q(profile.displayName)},${q(profile.displayName)},NULL,'application')
      ON CONFLICT (tenant_id,issuer,subject,management_client) DO UPDATE
        SET display_name=EXCLUDED.display_name, organization=EXCLUDED.organization,
            job_title=EXCLUDED.job_title, kind=EXCLUDED.kind
      RETURNING subject;`);
    if (updated) stats.applications++; else stats.missing.push(profile.name);
  }
  log(`Hồ sơ người dùng: ${stats.admins} quản trị, ${stats.applications} ứng dụng${stats.missing.length ? `; thiếu ${stats.missing.join(", ")}` : ""}`);
  return stats;
}
