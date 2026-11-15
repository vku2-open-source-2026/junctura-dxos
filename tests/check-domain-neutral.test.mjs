// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { findViolations } from "../scripts/check-domain-neutral.mjs";

function scan(contents, allowlist = []) {
  return findViolations({ files: Object.keys(contents), read: (path) => contents[path], allowlist });
}

test("reports Vietnamese diacritics and line numbers without case sensitivity", () => {
  assert.deepEqual(scan({ "src/example.mjs": "// neutral\r\nconst label = 'BỆNH NHÂN';\r\n" }), {
    violations: [{ path: "src/example.mjs", line: 2, term: "bệnh nhân" }],
    scanned: 1,
  });
});

test("reports English terms with different case and word prefixes", () => {
  assert.deepEqual(scan({ "console/src/example.ts": "PaTiEnT\nstudents\nclinical\nimpatient" }).violations, [
    { path: "console/src/example.ts", line: 1, term: "patient" },
    { path: "console/src/example.ts", line: 2, term: "student" },
    { path: "console/src/example.ts", line: 3, term: "clinic" },
  ]);
});

test("does not read excluded tests, temporary samples or the check's own files", () => {
  assert.deepEqual(findViolations({
    files: ["tests/example.test.mjs", "console/src/tests/example.test.ts", "examples/workflows/sample.bpmn20.xml",
      "scripts/check-domain-neutral.mjs", "scripts/domain-neutral-allowlist.json"],
    read: () => { throw new Error("excluded files must not be read"); },
  }), { violations: [], scanned: 0 });
  assert.deepEqual(scan({ "tests/example.test.mjs": "patient", "console/src/tests/example.test.ts": "patient" }).violations, []);
});

test("keeps platform health vocabulary and generic records allowed", () => {
  assert.deepEqual(scan({ "src/health.mjs": "health Health HEALTH hồ sơ Hồ sơ" }), { violations: [], scanned: 1 });
});

test("covers each scoped prefix and explicit root file", () => {
  const paths = ["src/example.mjs", "infra/example.sql", "scripts/example.mjs", "sdk/node/example.mjs",
    "console/src/example.ts", "examples/example.mjs", "docs/contracts/example.json",
    "compose.yaml", "compose.providers.yaml", "Dockerfile", "console/Dockerfile", ".env.example"];
  const result = scan(Object.fromEntries(paths.map((path) => [path, "hospital"])));
  assert.equal(result.scanned, paths.length);
  assert.deepEqual(result.violations.map((entry) => entry.path), [...paths].sort());
});

test("leaves unrelated paths outside vocabulary scope", () => {
  assert.deepEqual(findViolations({
    files: ["docs/DEVELOPING.md", "integration/example.mjs", "console/scripts/example.mjs", "src-other/example.mjs", "compose.extra.yaml"],
    read: () => { throw new Error("out-of-scope files must not be read"); },
  }), { violations: [], scanned: 0 });
});

test("continues scanning the generated Console API reference", () => {
  assert.deepEqual(scan({ "console/src/constants/apiReference.json": '{"example":"student"}' }).violations, [
    { path: "console/src/constants/apiReference.json", line: 1, term: "student" },
  ]);
});

test("skips binary files with a NUL byte in the first 8 KB", () => {
  const binary = Buffer.concat([Buffer.from("patient"), Buffer.alloc(8192 - 8, 32), Buffer.from([0])]);
  assert.equal(binary.length, 8192);
  assert.deepEqual(scan({ "src/image.bin": binary }), { violations: [], scanned: 0 });
  const text = Buffer.concat([Buffer.alloc(8192, 32), Buffer.from("\0patient")]);
  assert.deepEqual(scan({ "src/example.txt": text }).violations, [{ path: "src/example.txt", line: 1, term: "patient" }]);
});

test("rejects business BPMN in Core and anywhere outside the approved locations", () => {
  assert.deepEqual(scan({ "src/process.bpmn20.xml": "<definitions/>", "other/process.bpmn20.xml": "<definitions/>" }), {
    violations: [
      { path: "other/process.bpmn20.xml", message: "business BPMN outside allowed locations" },
      { path: "src/process.bpmn20.xml", message: "business BPMN outside allowed locations" },
    ],
    scanned: 1,
  });
});

test("allows only the approved BPMN files and fixture/sample directories", () => {
  assert.deepEqual(scan({
    "infra/flowable/checkpoint.bpmn20.xml": "<definitions/>",
    "infra/flowable/capability-single.bpmn20.xml": "<definitions/>",
    "tests/fixtures/process.bpmn20.xml": "patient",
    "examples/workflows/process.bpmn20.xml": "patient",
  }), { violations: [], scanned: 2 });
  assert.deepEqual(scan({ "infra/flowable/extra.bpmn20.xml": "<definitions/>" }).violations, [
    { path: "infra/flowable/extra.bpmn20.xml", message: "business BPMN outside allowed locations" },
  ]);
});

test("an allowlist entry suppresses only its exact path and term", () => {
  assert.deepEqual(scan({ "src/a.mjs": "patient\npatient hospital", "src/b.mjs": "patient" }, [
    { path: "src/a.mjs", term: "patient", reason: "Documented exception for this fixture" },
  ]).violations, [
    { path: "src/a.mjs", line: 2, term: "hospital" },
    { path: "src/b.mjs", line: 1, term: "patient" },
  ]);
});

test("reports unused allowlist entries, including excluded files", () => {
  for (const path of ["src/missing.mjs", "src/neutral.mjs", "tests/example.test.mjs"]) {
    assert.deepEqual(scan({ "src/neutral.mjs": "health", "tests/example.test.mjs": "patient" }, [
      { path, term: "patient", reason: "Obsolete exception" },
    ]).violations, [{ path: "scripts/domain-neutral-allowlist.json", message: `unused allowlist entry: ${path}: patient` }]);
  }
});

test("allowlisting text cannot suppress a forbidden BPMN location", () => {
  assert.deepEqual(scan({ "src/process.bpmn20.xml": "patient" }, [
    { path: "src/process.bpmn20.xml", term: "patient", reason: "Text exception only" },
  ]).violations, [{ path: "src/process.bpmn20.xml", message: "business BPMN outside allowed locations" }]);
});

test("requires a valid allowlist array with reasons", () => {
  for (const allowlist of [{}, [null], [{ path: "src/a.mjs", term: "patient", reason: " " }]]) {
    assert.throws(() => scan({}, allowlist), /allowlist must be an array of entries with non-empty path, term and reason strings/u);
  }
});
