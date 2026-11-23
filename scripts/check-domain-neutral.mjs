// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const allowlistPath = "scripts/domain-neutral-allowlist.json";
const prefixes = ["src/", "infra/", "scripts/", "sdk/", "console/src/", "examples/", "docs/", "integration/"];
const scopedFiles = new Set(["README.md", "CHANGELOG.md", "compose.yaml", "compose.providers.yaml", "Dockerfile", "console/Dockerfile", ".env.example"]);
const excludedPrefixes = ["console/src/tests/", "tests/", "examples/workflows/"];
const excludedFiles = new Set(["scripts/check-domain-neutral.mjs", allowlistPath]);
const allowedBpmnFiles = new Set(["infra/flowable/checkpoint.bpmn20.xml", "infra/flowable/capability-single.bpmn20.xml"]);
const phraseAllowlist = {
  "khám": { following: "\\s+phá", reason: "The phrase means to explore or discover and is domain-neutral." },
};
const terms = [
  "bệnh viện", "nhà thuốc", "trạm y tế", "phòng khám", "bệnh nhân", "người bệnh", "đơn thuốc", "dị ứng", "tiêm chủng", "xét nghiệm",
  "cấp cứu", "khám", "điều trị", "chẩn đoán", "phẫu thuật", "nội trú", "ngoại trú", "y tế", "giáo dục",
  "bác sĩ", "dược sĩ", "giảng viên", "học sinh", "lâm sàng", "hồ sơ bệnh án",
  "bảo hiểm y tế", "sinh viên", "học phí", "học bổng", "ký túc xá", "bảng điểm", "lịch thi", "đào tạo", "chứng từ", "người nộp",
  "patient", "prescription", "pharmacy", "hospital", "clinic", "insurance", "student", "tuition", "scholarship", "transcript", "allergy",
  "daotao", "thuvien", "taichinh", "tramyte", "benhvien", "ma_ho_so", "nguoi-nop", "chung-tu", "don-vi-",
];
const patterns = terms.map((term) => {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const end = /^[\x00-\x7f]+$/u.test(term) ? "" : "(?![\\p{L}\\p{N}])";
  const allowed = phraseAllowlist[term];
  const exception = allowed ? `(?!${allowed.following}${end})` : "";
  return { term, pattern: new RegExp(`(?<![\\p{L}\\p{N}])${escaped}${end}${exception}`, "iu") };
});

// read(path) supplies a string or Buffer. The result contains structured
// violations and a count of scoped text files; importing this module runs no IO.
export function findViolations({ files, read, allowlist = [] }) {
  if (!Array.isArray(allowlist) || allowlist.some((entry) =>
    !entry || ["path", "term", "reason"].some((key) => typeof entry[key] !== "string" || !entry[key].trim()))) {
    throw new TypeError("allowlist must be an array of entries with non-empty path, term and reason strings");
  }
  const violations = [];
  const used = new Set();
  let scanned = 0;

  for (const path of [...new Set(files)].sort()) {
    // This path rule applies to every tracked BPMN, including outside text scope.
    if (path.endsWith(".bpmn20.xml") && !allowedBpmnFiles.has(path)
      && !path.startsWith("tests/fixtures/") && !path.startsWith("examples/workflows/")) {
      violations.push({ path, message: "business BPMN outside allowed locations" });
    }
    if (excludedFiles.has(path) || excludedPrefixes.some((prefix) => path.startsWith(prefix))) continue;
    if (!scopedFiles.has(path) && !prefixes.some((prefix) => path.startsWith(prefix))) continue;
    const bytes = Buffer.from(read(path));
    if (bytes.subarray(0, 8192).includes(0)) continue;
    scanned += 1;
    const lines = bytes.toString("utf8").split(/\r\n|\n|\r/u);
    for (const [index, line] of lines.entries()) {
      for (const { term, pattern } of patterns) {
        if (!pattern.test(line)) continue;
        let suppressed = false;
        for (const [entryIndex, entry] of allowlist.entries()) {
          if (entry.path === path && entry.term.toLocaleLowerCase("vi") === term.toLocaleLowerCase("vi")) {
            used.add(entryIndex);
            suppressed = true;
          }
        }
        if (!suppressed) violations.push({ path, line: index + 1, term });
      }
    }
  }
  for (const [index, entry] of allowlist.entries()) {
    if (!used.has(index)) {
      violations.push({ path: allowlistPath, message: `unused allowlist entry: ${entry.path}: ${entry.term}` });
    }
  }
  return { violations, scanned };
}

export function runCheck() {
  try {
    const tracked = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" });
    if (tracked.status !== 0) throw tracked.error ?? new Error(tracked.stderr.trim() || "git ls-files failed");
    const { violations, scanned } = findViolations({
      files: tracked.stdout.split("\0").filter(path => path && existsSync(join(root, path))),
      read: (path) => readFileSync(join(root, path)),
      allowlist: JSON.parse(readFileSync(join(root, allowlistPath), "utf8")),
    });
    for (const violation of violations) {
      console.log(violation.line === undefined
        ? `${violation.path}: ${violation.message}`
        : `${violation.path}:${violation.line}: ${violation.term}`);
    }
    if (violations.length) {
      console.log(`Domain-neutral check failed: ${violations.length} violations in ${scanned} files scanned`);
      return 1;
    }
    console.log(`Domain-neutral check passed: ${scanned} files scanned`);
    return 0;
  } catch (error) {
    console.error(`Domain-neutral check failed: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runCheck();
}
