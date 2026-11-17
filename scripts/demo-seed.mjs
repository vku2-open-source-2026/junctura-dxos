// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Simulated demo content, written through the public Gateway as its backend apps.
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createJuncturaClient, JuncturaError } from "../sdk/node/index.mjs";
import { connectDemoStack, step } from "./lib/demo-stack.mjs";
import { clientIdFor, seedTrust } from "./trust-demo.mjs";

export const DEMO_CONTACTS = Array.from({ length: 8 }, (_, index) => {
  const number = String(index + 1).padStart(2, "0");
  return {
    seedKey: `demo-contact-${number}`, name: `Nhân vật mô phỏng ${number}`,
    unit: index < 4 ? "Nhóm Sao (mô phỏng)" : "Nhóm Mây (mô phỏng)",
    title: index % 2 ? "Điều phối nội bộ" : "Hỗ trợ công việc",
    email: `contact${number}@example.invalid`, phone: `+84 000 000 ${String(index + 1).padStart(3, "0")}`,
  };
});

export const DEMO_DOCUMENTS = [
  { seedKey: "demo-document-01", number: "DEMO-001", title: "Lịch sử dụng phòng họp", issuedOn: "2026-11-02", summary: "Lịch phòng Sao và phòng Mây trong tuần. Nội dung mô phỏng." },
  { seedKey: "demo-document-02", number: "DEMO-002", title: "Hướng dẫn đặt tên tệp", issuedOn: "2026-11-03", summary: "Quy ước tên tệp cho nhóm công việc mô phỏng." },
  { seedKey: "demo-document-03", number: "DEMO-003", title: "Danh mục thiết bị dùng chung", issuedOn: "2026-11-04", summary: "Danh sách màn hình và máy chiếu dùng chung. Nội dung mô phỏng." },
  { seedKey: "demo-document-04", number: "DEMO-004", title: "Kế hoạch sắp xếp kho tệp", issuedOn: "2026-11-05", summary: "Sắp xếp thư mục theo nhóm và tháng. Nội dung mô phỏng." },
  { seedKey: "demo-document-05", number: "DEMO-005", title: "Thông báo lịch trao đổi", issuedOn: "2026-11-06", summary: "Buổi trao đổi công việc tại phòng Sao. Nội dung mô phỏng." },
  { seedKey: "demo-document-06", number: "DEMO-006", title: "Ghi chú bàn giao nội bộ", issuedOn: "2026-11-07", summary: "Các bước bàn giao tệp và thiết bị cho nhóm kế tiếp. Nội dung mô phỏng." },
];

export const DEMO_ROOMS = [
  { seedKey: "demo-room-01", name: "Phòng Sao (mô phỏng)", capacity: 6, floor: 1 },
  { seedKey: "demo-room-02", name: "Phòng Mây (mô phỏng)", capacity: 10, floor: 1 },
  { seedKey: "demo-room-03", name: "Phòng Gió (mô phỏng)", capacity: 12, floor: 2 },
  { seedKey: "demo-room-04", name: "Phòng Trăng (mô phỏng)", capacity: 20, floor: 2 },
];

export const DEMO_NOTES = [
  { seedKey: "demo-note-01", filename: "welcome-demo.txt", text: "Dữ liệu mô phỏng cho không gian demo.\nNhóm Sao và Nhóm Mây là các nhóm hư cấu.\n" },
  { seedKey: "demo-note-02", filename: "meeting-demo.txt", text: "Ghi chú mô phỏng: kiểm tra màn hình và máy chiếu trước buổi trao đổi.\n" },
  { seedKey: "demo-note-03", filename: "files-demo.txt", text: "Quy ước mô phỏng: đặt tên tệp theo nhóm và ngày, sau đó lưu vào thư mục chung.\n" },
];

export const DEMO_COLLECTIONS = [
  { app: "danhba", collection: "contacts", records: DEMO_CONTACTS },
  { app: "vanban", collection: "documents", records: DEMO_DOCUMENTS },
  { app: "lichhop", collection: "rooms", records: DEMO_ROOMS },
];

class SeedOptionsError extends Error {}

export function validateTenant(tenant) {
  if (typeof tenant !== "string" || !/^[a-z][a-z0-9-]{0,62}$/.test(tenant)) {
    throw new SeedOptionsError("Invalid --tenant: use a lowercase tenant identifier (1–63 characters)");
  }
  if (["production", "tenant-a", "tenant-b"].includes(tenant)) {
    throw new SeedOptionsError(`Refusing to seed reserved tenant ${tenant}; demo:seed is only for demo-style tenants`);
  }
  return tenant;
}

export function parseOptions(args = []) {
  let values;
  try {
    ({ values } = parseArgs({ args, options: {
      tenant: { type: "string", default: "demo" }, help: { type: "boolean", default: false },
    } }));
  } catch {
    throw new SeedOptionsError("Usage: npm run demo:seed -- [--tenant demo] [--help]");
  }
  return { ...values, tenant: validateTenant(values.tenant) };
}

// UUID derived from a private-to-this-seeder namespace and the stable seed key.
// Include tenant and app so different environments cannot reuse an object's ID.
export function objectIdFor(tenant, seedKey) {
  const bytes = createHash("sha256").update(JSON.stringify(["junctura-demo-notes-v1", tenant, "vanban", seedKey])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function missingRecords(existing, planned) {
  const keys = new Set(existing.map(record => record.data?.seedKey));
  return planned.filter(record => !keys.has(record.seedKey));
}

async function adminJson(stack, path, label) {
  const response = await stack.admin(path);
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`${label} failed (${response.status})`);
  }
  return response.json();
}

export async function backendClient(stack, { tenant, name, fetcher = fetch }) {
  const clientId = clientIdFor(tenant, name);
  const clients = await adminJson(stack, `clients?${new URLSearchParams({ clientId })}`, "Find backend client");
  const client = clients.find(client => client.clientId === clientId);
  if (!client?.id) throw new Error("Backend client is missing; seed trust first");
  const secret = await adminJson(stack, `clients/${encodeURIComponent(client.id)}/client-secret`, "Read backend credentials");
  if (typeof secret.value !== "string" || !secret.value) throw new Error("Backend credentials are unavailable");
  // The SDK obtains and caches client_credentials tokens in memory; neither the
  // secret nor token is read from an env file, logged or returned by this script.
  return createJuncturaClient({ baseUrl: stack.base, clientId, clientSecret: secret.value, fetcher, timeoutMs: 60000 });
}

export async function seedCollection(client, collection, records) {
  const existing = [], cursors = new Set();
  let cursor;
  do {
    const page = await client.listRecords(collection, { limit: 100, order: "asc", ...(cursor ? { cursor } : {}) });
    existing.push(...page.items);
    cursor = page.nextCursor;
    if (cursor && (typeof cursor !== "string" || cursors.has(cursor))) throw new Error("Invalid collection pagination");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  const missing = missingRecords(existing, records);
  for (const record of missing) await client.createRecord(collection, record);
  return missing.length;
}

export async function seedNotes(client, { tenant }) {
  let uploaded = 0;
  for (const note of DEMO_NOTES) {
    const id = objectIdFor(tenant, note.seedKey);
    try {
      // There is no object-list API. Only a missing committed object is uploaded;
      // a failed/quarantined upload is unreadable and can be retried at this ID.
      await client.getObject(id);
    } catch (error) {
      if (error.status !== 404) throw error;
      // PUT follows the Gateway's quarantine → scan → commit flow. Fail closed:
      // scanner errors stop seeding, and metadata is only added after success.
      await client.putObject(id, Buffer.from(note.text, "utf8"));
      uploaded += 1;
    }
  }
  const records = await seedCollection(client, "notes", DEMO_NOTES.map(({ seedKey, filename }) => ({
    seedKey, filename, objectId: objectIdFor(tenant, seedKey),
  })));
  return { uploaded, records };
}

export async function seedDemoData(stack, { tenant = stack.tenant, fetcher = fetch, log = step } = {}) {
  validateTenant(tenant);
  if (tenant !== stack.tenant) throw new Error("Invalid seed tenant for this stack");
  const clients = new Map();
  let records = 0;
  for (const dataset of DEMO_COLLECTIONS) {
    const client = await backendClient(stack, { tenant, name: dataset.app, fetcher });
    clients.set(dataset.app, client);
    const added = await seedCollection(client, dataset.collection, dataset.records);
    records += added;
    log(`${dataset.app}/${dataset.collection}: ${added} added`);
  }
  const notes = await seedNotes(clients.get("vanban"), { tenant });
  log(`vanban/notes: ${notes.uploaded} uploaded, ${notes.records} metadata records added`);
  return { records: records + notes.records, objects: notes.uploaded };
}

export async function main(args = process.argv.slice(2), {
  connect = connectDemoStack, seed = seedTrust, fetcher = fetch, log = step,
} = {}) {
  const options = parseOptions(args);
  if (options.help) {
    log("Usage: npm run demo:seed -- [--tenant demo] — simulated demo-style tenants only");
    return;
  }
  const { tenant } = options;
  log(`${tenant}: connect and prepare management client`);
  const stack = await connect({ tenant, createGroup: true });
  await stack.ensureManagementClient();
  log(`${tenant}: seed applications, capabilities and grants`);
  await seed(stack, { tenant });
  const result = await seedDemoData(stack, { tenant, fetcher, log });
  log(`${tenant}: ready (${result.records} records, ${result.objects} files added; all content simulated)`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    // Shared operator helpers may receive sensitive identity-server errors.
    console.error(error instanceof SeedOptionsError || error instanceof JuncturaError
      ? error.message : "Demo seed failed; check stack readiness and local configuration");
    process.exitCode = 1;
  });
}
