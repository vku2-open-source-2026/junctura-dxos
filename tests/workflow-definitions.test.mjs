// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

const WORKFLOW_DEFINITION_KEYS = ["junctura_phe_duyet_yeu_cau", "junctura_xac_minh_ho_so", "junctura_doi_soat_chung_tu"];

const directory = new URL("../src/modules/workflow/definitions/", import.meta.url);

test("business workflow definitions are domain-neutral Vietnamese, named per step and assigned to a unit", () => {
  const files = readdirSync(directory).filter(name => name.endsWith(".bpmn20.xml"));
  assert.equal(files.length, 3);
  const keyed = new Map();
  for (const file of files) {
    const xml = readFileSync(new URL(file, directory), "utf8");
    const licenseTag = ["SPDX-License-Identifier", "Apache-2.0"].join(": ");
    assert.ok(xml.includes(licenseTag));
    const id = /<process\b[^>]*\bid="([^"]+)"/.exec(xml)?.[1];
    const name = /<process\b[^>]*\bname="([^"]+)"/.exec(xml)?.[1];
    assert.ok(id && name, `${file} has a process id and name`);
    keyed.set(id, { name, xml });
    const tasks = [...xml.matchAll(/<userTask\b[^>]*\bname="([^"]+)"[^>]*\bflowable:candidateGroups="([^"]+)"/g)];
    assert.ok(tasks.length >= 3, `${file} has named steps`);
    assert.ok(tasks.every(([, step, group]) => step && group), `${file} assigns every step to a unit`);
  }
  assert.deepEqual([...keyed.keys()].sort(), [...WORKFLOW_DEFINITION_KEYS].sort());
  const approval = keyed.get("junctura_phe_duyet_yeu_cau");
  assert.equal(approval.name, "Phê duyệt yêu cầu");
  assert.match(approval.xml, /Tiếp nhận yêu cầu/);
  assert.match(approval.xml, /Xét duyệt/);
  assert.equal(keyed.get("junctura_xac_minh_ho_so").name, "Xác minh hồ sơ");
  assert.equal(keyed.get("junctura_doi_soat_chung_tu").name, "Đối soát chứng từ");
});
