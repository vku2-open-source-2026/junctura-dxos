// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Deterministic, entirely fictional "Junctura Health" context data for the real
// local stack. No real patient, clinician or insurance record is represented and
// nothing here writes to storage or the network.
import { createHash } from "node:crypto";

export const DEFAULT_SEED = 20261110;

// Layer-2 applications that appear in the health scenario. Enrollment uses the
// project's reviewed local operator helper, never direct data writes.
export const HEALTH_APPS = [
  { name: "tram-y-te", displayName: "Trạm Y tế xã" },
  { name: "benh-vien", displayName: "Bệnh viện" },
  { name: "nha-thuoc", displayName: "Nhà thuốc" },
  { name: "bao-hiem", displayName: "Bảo hiểm" },
  { name: "so-suc-khoe", displayName: "Sổ sức khỏe" },
];

export const HEALTH_CAPABILITIES = [
  { app: "tram-y-te", name: "tra-cuu-benh-nhan", title: "Tra cứu bệnh nhân", description: "Trả về thông tin cơ bản của một bệnh nhân theo mã." },
  { app: "benh-vien", name: "lich-kham", title: "Lịch khám chuyên khoa", description: "Trả về các khung giờ khám chuyên khoa còn trống." },
  { app: "nha-thuoc", name: "kiem-tra-don-thuoc", title: "Kiểm tra đơn thuốc", description: "Xác nhận đơn thuốc và tình trạng cấp phát." },
  { app: "bao-hiem", name: "xac-minh-chi-phi", title: "Xác minh chi phí", description: "Xác minh mức chi trả bảo hiểm cho một lượt khám." },
  { app: "so-suc-khoe", name: "ho-so-suc-khoe", title: "Hồ sơ sức khỏe", description: "Tổng hợp hồ sơ sức khỏe của một người dân." },
  { app: "tram-y-te", name: "referral-summary", title: "Tóm tắt chuyển tuyến", description: "Cung cấp tóm tắt chuyển tuyến cho cơ sở tiếp nhận." },
  { app: "nha-thuoc", name: "prescription-verify", title: "Kiểm tra đơn thuốc", description: "Xác nhận đơn thuốc đã được kiểm tra trước khi cấp phát." },
  { app: "bao-hiem", name: "claim-verify", title: "Xác minh chi phí", description: "Xác minh chi phí điều trị được bảo hiểm chi trả." },
  { app: "so-suc-khoe", name: "pre-visit-summary", title: "Tóm tắt trước khám", description: "Tóm tắt thông tin sức khỏe cần thiết trước một buổi khám." },
  { app: "so-suc-khoe", name: "vaccination-history", title: "Lịch sử tiêm chủng", description: "Trả về lịch sử tiêm chủng đã ghi nhận của một người dân." },
];

// Provider → consumer relationships that the Console organisation tree draws.
// Each capability above is provided by the left application and used by the right
// application through a real, independently approved direct trust grant.
export const HEALTH_RELATIONS = [
  { provider: "tram-y-te", consumer: "benh-vien", capability: "referral-summary" },
  { provider: "nha-thuoc", consumer: "benh-vien", capability: "prescription-verify" },
  { provider: "bao-hiem", consumer: "benh-vien", capability: "claim-verify" },
  { provider: "so-suc-khoe", consumer: "benh-vien", capability: "pre-visit-summary" },
  { provider: "so-suc-khoe", consumer: "tram-y-te", capability: "vaccination-history" },
];

const FAMILY_NAMES = ["Nguyễn", "Trần", "Lê", "Phạm", "Hoàng", "Huỳnh", "Phan", "Võ", "Đặng", "Bùi", "Đỗ", "Hồ"];
const MIDDLE_NAMES = ["Văn", "Thị", "Hữu", "Minh", "Thanh", "Quốc", "Ngọc", "Gia", "Đức", "Thu"];
const GIVEN_NAMES = ["An", "Bình", "Chi", "Dũng", "Hà", "Hải", "Hiếu", "Hoa", "Hùng", "Lan", "Linh", "Long", "Mai", "Nga", "Nam", "Nhung", "Phúc", "Quân", "Sơn", "Tâm", "Thảo", "Trang", "Trung", "Tú", "Vy"];
const STREETS = ["Nguyễn Văn Linh", "Trần Phú", "Hoàng Diệu", "Ngũ Hành Sơn", "Lê Duẩn", "Điện Biên Phủ", "Nguyễn Lương Bằng", "Tôn Đức Thắng", "Bạch Đằng", "Phan Châu Trinh"];
const WARDS = ["phường Hòa Thuận", "phường Thanh Khê Tây", "phường An Hải Bắc", "phường Mân Thái", "phường Khuê Mỹ", "phường Hòa Khánh Bắc", "xã Hòa Phú", "xã Hòa Tiến", "xã Hòa Nhơn", "phường Hòa Cường Bắc"];
const CLINICS = ["Trạm Y tế xã Hòa Phú", "Trạm Y tế xã Hòa Tiến", "Trạm Y tế phường Hòa Thuận", "Trạm Y tế phường Thanh Khê Tây", "Trạm Y tế xã Hòa Nhơn"];
const HOSPITALS = ["Bệnh viện Đà Nẵng", "Bệnh viện C Đà Nẵng", "Bệnh viện Phụ sản - Nhi Đà Nẵng", "Trung tâm Y tế quận Hải Châu", "Trung tâm Y tế quận Sơn Trà"];
const PHARMACIES = ["Nhà thuốc An Khang", "Nhà thuốc Tâm Đức", "Nhà thuốc Hòa Bình", "Nhà thuốc Minh Châu", "Nhà thuốc Sức Khỏe Vàng"];
const INSURERS = ["Bảo hiểm xã hội quận Hải Châu", "Bảo hiểm xã hội quận Thanh Khê", "Bảo hiểm xã hội quận Sơn Trà", "Bảo hiểm xã hội huyện Hòa Vang"];
const DIAGNOSES = ["Viêm họng cấp", "Sốt xuất huyết", "Tăng huyết áp", "Đái tháo đường type 2", "Viêm phế quản", "Rối loạn tiêu hóa", "Dị ứng da", "Viêm xoang", "Thiếu máu nhẹ", "Đau thắt lưng"];
const REASONS = ["Theo dõi sau điều trị", "Cần xét nghiệm chuyên sâu", "Chuyển tuyến đúng tuyến", "Hội chẩn chuyên khoa", "Đánh giá lại sau ba tuần"];
const PRIORITIES = ["Thường", "Khẩn", "Cấp cứu"];
const REFERRAL_STATES = ["Chờ tiếp nhận", "Đã tiếp nhận", "Đã hoàn tất"];
const PRESCRIPTION_STATES = ["Chờ kiểm tra", "Đã cấp phát", "Đã thanh toán"];
const BLOOD_TYPES = ["A+", "O+", "B+", "AB+", "A-", "O-"];
const ALLERGIES = ["Không", "Penicillin", "Hải sản", "Phấn hoa", "Aspirin"];
const MEDICINES = [
  ["Paracetamol", "500 mg", "viên"], ["Amoxicillin", "500 mg", "viên"], ["Omeprazole", "20 mg", "viên"],
  ["Ibuprofen", "400 mg", "viên"], ["Cetirizine", "10 mg", "viên"], ["Metformin", "500 mg", "viên"],
  ["Amlodipine", "5 mg", "viên"], ["Salbutamol", "2 mg", "viên"], ["Oresol", "1 gói", "gói"],
];
const DOCTORS = ["BS. Nguyễn Minh An", "BS. Trần Thu Hà", "BS. Lê Quốc Bảo", "BS. Phạm Ngọc Lan", "BS. Hoàng Đức Hải"];

export function createPrng(seed) {
  let state = Number(seed) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rng, values) => values[Math.floor(rng() * values.length)];
const between = (rng, min, max) => min + Math.floor(rng() * (max - min + 1));
const pad = (value, width) => String(value).padStart(width, "0");

function isoDate(dayOffset) {
  const date = new Date(Date.UTC(2026, 0, 1) + dayOffset * 86_400_000);
  return date.toISOString().slice(0, 10);
}

function isoDateTime(dayOffset, hour, minute) {
  return `${isoDate(dayOffset)}T${pad(hour, 2)}:${pad(minute, 2)}:00Z`;
}

function phone(rng) {
  return `09${between(rng, 10000000, 99999999)}`;
}

function citizenId(rng) {
  return `2${between(rng, 10000000000, 99999999999)}`;
}

export function objectIdFor(key) {
  const hex = createHash("sha256").update(`junctura-seed-health:${key}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// The standard harmless antivirus test string, assembled at runtime so it is
// never stored on disk. It is used only to prove the quarantine path rejects
// unscanned bytes; rejected uploads are never published.
export function eicarTestBytes() {
  return Buffer.from([
    "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR",
    "-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*",
  ].join(""), "ascii");
}

function personName(rng) {
  return `${pick(rng, FAMILY_NAMES)} ${pick(rng, MIDDLE_NAMES)} ${pick(rng, GIVEN_NAMES)}`;
}

function referralDocument(referral, patient) {
  return [
    "GIẤY CHUYỂN TUYẾN",
    `Số: ${referral.ma_chuyen_tuyen}`,
    "",
    "Cơ sở gửi: " + referral.tu_co_so,
    "Cơ sở nhận: " + referral.den_co_so,
    "",
    "Họ tên người bệnh: " + patient.ho_ten,
    "Mã người bệnh: " + patient.ma_benh_nhan,
    "Ngày sinh: " + patient.ngay_sinh,
    "Địa chỉ: " + patient.dia_chi,
    "",
    "Chẩn đoán: " + referral.chan_doan,
    "Lý do chuyển: " + referral.ly_do,
    "Mức độ ưu tiên: " + referral.muc_do_uu_tien,
    "Ngày chuyển: " + referral.ngay_chuyen,
    "",
    "Ghi chú: Dữ liệu hư cấu dùng cho bối cảnh trình diễn Junctura Health.",
    "Bác sĩ ký tên: " + referral.bac_si,
    "",
  ].join("\n");
}

// The returned object is stable for a given seed and count options; running the
// generator twice must produce byte-identical output.
export function generateHealthDataset({ seed = DEFAULT_SEED, patients = 40, referrals = 45, prescriptions = 50, documents = 8 } = {}) {
  for (const [label, value] of Object.entries({ patients, referrals, prescriptions })) {
    if (!Number.isInteger(value) || value < 30 || value > 50) throw new Error(`${label} count must be an integer between 30 and 50`);
  }
  if (!Number.isInteger(documents) || documents < 0 || documents > referrals) throw new Error("documents must be an integer between 0 and the referral count");
  const rng = createPrng(seed);
  const patientRows = [];
  for (let index = 0; index < patients; index++) {
    const dayOffset = between(rng, 0, 300);
    patientRows.push({
      ma_benh_nhan: `BN-${pad(index + 1, 4)}`,
      ho_ten: personName(rng),
      ngay_sinh: isoDate(between(rng, -29_000, -5_500)),
      gioi_tinh: rng() < 0.5 ? "Nam" : "Nữ",
      dien_thoai: phone(rng),
      so_cccd: citizenId(rng),
      dia_chi: `${between(rng, 1, 320)} đường ${pick(rng, STREETS)}, ${pick(rng, WARDS)}, Đà Nẵng`,
      nhom_mau: pick(rng, BLOOD_TYPES),
      di_ung: pick(rng, ALLERGIES),
      bao_hiem_y_te: `DN${between(rng, 1000000000, 9999999999)}`,
      ngay_tao: isoDateTime(dayOffset, between(rng, 7, 17), pick(rng, [0, 15, 30, 45])),
    });
  }
  const referralRows = [];
  for (let index = 0; index < referrals; index++) {
    const patient = patientRows[between(rng, 0, patientRows.length - 1)];
    referralRows.push({
      ma_chuyen_tuyen: `CT-${pad(index + 1, 4)}`,
      ma_benh_nhan: patient.ma_benh_nhan,
      tu_co_so: pick(rng, CLINICS),
      den_co_so: pick(rng, HOSPITALS),
      ly_do: pick(rng, REASONS),
      chan_doan: pick(rng, DIAGNOSES),
      muc_do_uu_tien: pick(rng, PRIORITIES),
      bac_si: pick(rng, DOCTORS),
      ngay_chuyen: isoDate(between(rng, 0, 300)),
      trang_thai: pick(rng, REFERRAL_STATES),
      tai_lieu: null,
    });
  }
  const documentsRows = [];
  for (let index = 0; index < documents; index++) {
    const referral = referralRows[index];
    const patient = patientRows.find(row => row.ma_benh_nhan === referral.ma_benh_nhan);
    const key = `chuyen-tuyen:${referral.ma_chuyen_tuyen}`;
    referral.tai_lieu = objectIdFor(key);
    documentsRows.push({ id: referral.tai_lieu, key, content: referralDocument(referral, patient) });
  }
  const prescriptionRows = [];
  for (let index = 0; index < prescriptions; index++) {
    const patient = patientRows[between(rng, 0, patientRows.length - 1)];
    const referral = referralRows[between(rng, 0, referralRows.length - 1)];
    const items = Array.from({ length: between(rng, 1, 3) }, () => {
      const [ten, ham_luong, don_vi] = pick(rng, MEDICINES);
      return { ten, ham_luong, so_luong: between(rng, 5, 30), don_vi, lieu_dung: pick(rng, ["Ngày 2 lần", "Ngày 1 lần", "Sáng và tối", "Khi cần"]) };
    });
    prescriptionRows.push({
      ma_don_thuoc: `DT-${pad(index + 1, 4)}`,
      ma_benh_nhan: patient.ma_benh_nhan,
      ma_chuyen_tuyen: referral.ma_chuyen_tuyen,
      nha_thuoc: pick(rng, PHARMACIES),
      co_so_bao_hiem: pick(rng, INSURERS),
      thuoc: items,
      ngay_ke: isoDate(between(rng, 0, 300)),
      bao_hiem_chi_tra: rng() < 0.8 ? `${between(rng, 50, 100)}%` : "Không",
      trang_thai: pick(rng, PRESCRIPTION_STATES),
    });
  }
  return { seed, "benh-nhan": patientRows, "chuyen-tuyen": referralRows, "don-thuoc": prescriptionRows, documents: documentsRows };
}

export const RECORD_COLLECTIONS = [
  { collection: "benh-nhan", key: "ma_benh_nhan" },
  { collection: "chuyen-tuyen", key: "ma_chuyen_tuyen" },
  { collection: "don-thuoc", key: "ma_don_thuoc" },
];
