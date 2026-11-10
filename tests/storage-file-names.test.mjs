// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  encodeStoragePath,
  extensionOf,
  graphemes,
  maskFileName,
  normalizeStoragePath,
} from "../src/modules/storage/file-names.mjs";

test("file names keep only a recognisable edge and the extension", () => {
  assert.equal(maskFileName("abcdef.txt"), "abc…ef.txt");
  assert.equal(maskFileName("giấy chuyển tuyến CT-0001.txt"), "giấ…01.txt");
  assert.equal(maskFileName("abc.txt"), "a….txt");
  assert.equal(maskFileName("a.txt"), "a….txt");
  assert.equal(maskFileName("no-extension"), "no-…on");
  assert.equal(maskFileName(""), "");
});

test("Vietnamese and combining Unicode graphemes are never split", () => {
  const decomposed = "Ba\u0301o ca\u0301o.txt";
  const masked = maskFileName(decomposed);
  assert.equal(masked, "Ba\u0301o\u2026a\u0301o.txt");
  assert.deepEqual(graphemes("Ba\u0301o"), ["B", "a\u0301", "o"]);
  assert.ok(!masked.slice(0, -4).split("").includes("\u0301") || masked.includes("a\u0301"));
});

test("very long names stay bounded and object keys are not echoed", () => {
  const long = `${"a".repeat(10_000)}.pdf`;
  assert.equal(maskFileName(long), "aaa…aa.pdf");
  assert.ok(maskFileName(long).length < 16);
  assert.equal(extensionOf(long), "pdf");
  assert.equal(extensionOf("archive.tar.gz"), "gz");
  assert.equal(extensionOf("README"), "");
});

test("storage paths are canonical, bounded and traversal-free", () => {
  assert.equal(normalizeStoragePath(""), "");
  assert.equal(normalizeStoragePath("/"), "");
  assert.equal(normalizeStoragePath("ho-so/chuyen-tuyen/2026"), "ho-so/chuyen-tuyen/2026");
  assert.equal(normalizeStoragePath("/ho-so//chuyen-tuyen/"), null);
  assert.equal(normalizeStoragePath("../secret"), null);
  assert.equal(normalizeStoragePath("ho-so/../../secret"), null);
  assert.equal(normalizeStoragePath("ho-so\\chuyen-tuyen"), null);
  assert.equal(normalizeStoragePath("a".repeat(513)), null);
  assert.equal(normalizeStoragePath("ho-so/\u0000"), null);
  assert.equal(normalizeStoragePath("B\u00e1o c\u00e1o"), "Báo cáo".normalize("NFC"));
  assert.equal(encodeStoragePath("ho-so/giấy chuyển tuyến"), "ho-so/gi%E1%BA%A5y%20chuy%E1%BB%83n%20tuy%E1%BA%BFn");
});
