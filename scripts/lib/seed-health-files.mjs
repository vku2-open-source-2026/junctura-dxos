// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Local developer seed for the folder-shaped file catalogue. Documents are
// uploaded through the real v2 object API (so ClamAV still scans them) and the
// same reviewed bytes are then placed in the application's filer prefix so the
// read-only Console can show a realistic directory tree. This module is only
// used by `npm run seed:health`; it is not part of the platform runtime.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { objectIdFor } from "./seed-health-data.mjs";

const run = promisify(execFile);

export const HEALTH_FILE_PLAN = {
  "tram-y-te": [0, 3],
  "benh-vien": [3, 5],
  "nha-thuoc": [5, 7],
  "bao-hiem": [7, 8],
  "so-suc-khoe": [0, null],
};

const PRESCRIPTION_SLICES = {
  "nha-thuoc": [0, 2],
  "bao-hiem": [2, 4],
  "so-suc-khoe": [4, 6],
};

const LAB_SLICES = {
  "tram-y-te": [0, 1],
  "benh-vien": [1, 2],
  "so-suc-khoe": [2, 3],
};

function slice(rows, [start, end]) {
  return end === null ? rows.slice(start) : rows.slice(start, end);
}

export function plannedDocuments(appName, dataset) {
  const range = HEALTH_FILE_PLAN[appName] ?? [0, null];
  return slice(dataset.documents, range).map((document) => ({
    ...document,
    id: appName === "so-suc-khoe" ? document.id : objectIdFor(`${appName}:${document.key}`),
  }));
}

function yearOf(date) {
  return typeof date === "string" && /^\d{4}/.test(date) ? date.slice(0, 4) : "2026";
}

function referralText(referral) {
  return [
    "GIẤY CHUYỂN TUYẾN",
    `Số: ${referral.ma_chuyen_tuyen}`,
    `Cơ sở gửi: ${referral.tu_co_so}`,
    `Cơ sở nhận: ${referral.den_co_so}`,
    `Mã người bệnh: ${referral.ma_benh_nhan}`,
    `Chẩn đoán: ${referral.chan_doan}`,
    `Lý do: ${referral.ly_do}`,
    `Mức độ ưu tiên: ${referral.muc_do_uu_tien}`,
    `Ngày chuyển: ${referral.ngay_chuyen}`,
    "",
    "Dữ liệu hư cấu dùng cho bối cảnh phát triển Junctura Health.",
    "",
  ].join("\n");
}

function prescriptionText(row) {
  return [
    "ĐƠN THUỐC",
    `Mã đơn: ${row.ma_don_thuoc}`,
    `Mã chuyển tuyến: ${row.ma_chuyen_tuyen}`,
    `Nhà thuốc: ${row.nha_thuoc}`,
    `Ngày kê: ${row.ngay_ke}`,
    "",
    ...row.thuoc.map((item) => `${item.ten} ${item.ham_luong} — ${item.so_luong} ${item.don_vi} (${item.lieu_dung})`),
    "",
    "Dữ liệu hư cấu dùng cho bối cảnh phát triển Junctura Health.",
    "",
  ].join("\n");
}

function labText(patient) {
  return [
    "KẾT QUẢ XÉT NGHIỆM",
    `Mã người bệnh: ${patient.ma_benh_nhan}`,
    `Ngày sinh: ${patient.ngay_sinh}`,
    `Nhóm máu: ${patient.nhom_mau}`,
    `Dị ứng: ${patient.di_ung}`,
    "",
    "Chỉ số minh hoạ: huyết sắc tố 132 g/L; bạch cầu 6,4 G/L; tiểu cầu 248 G/L.",
    "",
    "Dữ liệu hư cấu dùng cho bối cảnh phát triển Junctura Health.",
    "",
  ].join("\n");
}

export function plannedFileTree(appName, dataset) {
  const referrals = new Map(dataset["chuyen-tuyen"].map((row) => [row.ma_chuyen_tuyen, row]));
  const items = [];
  for (const document of plannedDocuments(appName, dataset)) {
    const code = document.key.split(":")[1];
    const referral = referrals.get(code);
    const row = referral ?? {
      ma_chuyen_tuyen: code, tu_co_so: "Trạm Y tế", den_co_so: "Bệnh viện",
      ma_benh_nhan: "BN-0000", chan_doan: "Chưa ghi", ly_do: "Chưa ghi",
      muc_do_uu_tien: "Thường", ngay_chuyen: "2026-01-01",
    };
    items.push({
      key: `chuyen-tuyen:${code}`,
      objectId: document.id,
      content: document.content || referralText(row),
      folder: `ho-so/chuyen-tuyen/${yearOf(row.ngay_chuyen)}`,
      name: `giấy chuyển tuyến ${code}.txt`,
    });
  }
  const prescriptionRange = PRESCRIPTION_SLICES[appName];
  if (prescriptionRange) {
    for (const row of slice(dataset["don-thuoc"], prescriptionRange)) {
      items.push({
        key: `don-thuoc:${row.ma_don_thuoc}`,
        objectId: objectIdFor(`named:${appName}:don-thuoc:${row.ma_don_thuoc}`),
        content: prescriptionText(row),
        folder: `ho-so/don-thuoc/${yearOf(row.ngay_ke)}`,
        name: `đơn thuốc ${row.ma_don_thuoc}.txt`,
      });
    }
  }
  const labRange = LAB_SLICES[appName];
  if (labRange) {
    for (const patient of slice(dataset["benh-nhan"], labRange)) {
      items.push({
        key: `xet-nghiem:${patient.ma_benh_nhan}`,
        objectId: objectIdFor(`named:${appName}:xet-nghiem:${patient.ma_benh_nhan}`),
        content: labText(patient),
        folder: `giay-to/ket-qua-xet-nghiem/${yearOf(patient.ngay_tao)}`,
        name: `kết quả xét nghiệm ${patient.ma_benh_nhan}.txt`,
      });
    }
  }
  return items;
}

export async function resolveObjectsUrl({ baseUrl, env = process.env, runner = run } = {}) {
  if (env.SEED_OBJECTS_URL) return env.SEED_OBJECTS_URL.replace(/\/+$/, "");
  if (env.OBJECTS_URL) return env.OBJECTS_URL.replace(/\/+$/, "");
  let host = "";
  try { host = new URL(baseUrl).hostname; } catch { host = ""; }
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("Đặt SEED_OBJECTS_URL tới filer SeaweedFS khi không chạy stack cục bộ");
  }
  const ids = (await runner("docker", ["compose", "ps", "-q", "objects"], { timeout: 30000 })).stdout
    .trim().split(/\s+/).filter(Boolean);
  if (!ids.length) throw new Error("Không thấy dịch vụ objects đang chạy");
  const address = (await runner("docker", ["inspect", "-f",
    "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", ids[0]], { timeout: 30000 })).stdout.trim();
  if (!address) throw new Error("Không đọc được địa chỉ dịch vụ objects");
  return `http://${address}:8888`;
}

function encodePath(path) {
  return path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

async function putTreeFile({ objectsUrl, tenant, appId, item, request }) {
  const url = `${objectsUrl}/junctura-app/${encodeURIComponent(tenant)}/${encodeURIComponent(appId)}/` +
    `${encodePath(item.folder)}/${encodeURIComponent(item.name)}`;
  const head = await request(url, { method: "HEAD", signal: AbortSignal.timeout(10000), redirect: "error" });
  if (head.status === 200) return { created: false };
  if (head.status !== 404) throw new Error(`Không kiểm tra được tệp ${item.name} (${head.status})`);
  const response = await request(url, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: Buffer.from(item.content, "utf8"),
    signal: AbortSignal.timeout(30000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Không ghi được tệp ${item.name} (${response.status})`);
  await response.arrayBuffer();
  return { created: true };
}

export async function seedNamedFiles({ clients, tenant, apps, dataset, objectsUrl, log = () => {}, request = fetch }) {
  if (!objectsUrl) throw new Error("Thiếu địa chỉ filer để tạo cây thư mục");
  const stats = { objectsCreated: 0, objectsExisting: 0, filesCreated: 0, filesExisting: 0, folders: new Set() };
  for (const [appName, client] of Object.entries(clients)) {
    const app = apps?.[appName];
    if (!app) throw new Error(`Thiếu ứng dụng ${appName} để tạo cây thư mục`);
    const items = plannedFileTree(appName, dataset);
    for (const item of items) {
      const uploaded = await client.putObject(item.objectId, Buffer.from(item.content, "utf8"));
      stats[uploaded.created ? "objectsCreated" : "objectsExisting"]++;
      const written = await putTreeFile({ objectsUrl, tenant, appId: app.appId, item, request });
      stats[written.created ? "filesCreated" : "filesExisting"]++;
      stats.folders.add(`${appName}/${item.folder}`);
    }
    log(`• ${appName} — cây tệp: ${items.length} tệp trong ${new Set(items.map((item) => item.folder)).size} thư mục`);
  }
  return stats;
}
