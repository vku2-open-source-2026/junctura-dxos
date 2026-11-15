// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { RESERVED_KEYS, validateDefinition } from "../src/modules/workflow/definition-policy.mjs";

const fixture = readFileSync(new URL("./fixtures/workflows/sample-two-step.bpmn20.xml", import.meta.url), "utf8");
const expression = "${decision == 'approved'}";
const withTask = (attributes) => fixture.replace('name="Bước 1"', `name="Bước 1" ${attributes}`);

function rejects(xml, rule) {
  const result = validateDefinition(xml);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.rule === rule), JSON.stringify(result.problems));
  assert.ok(result.problems.every((problem) => typeof problem.detail === "string"));
  return result;
}

test("neutral two-step fixture is valid", () => {
  assert.deepEqual(validateDefinition(fixture), { ok: true, key: "sample_two_step", name: "Quy trình mẫu" });
});

const samples = new URL("../examples/workflows/", import.meta.url);
const sampleFiles = readdirSync(samples).filter((file) => file.endsWith(".bpmn20.xml"));
assert.equal(sampleFiles.length, 3);
for (const file of sampleFiles) {
  test(`unchanged temporary sample passes the policy: ${file}`, () => {
    assert.equal(validateDefinition(readFileSync(new URL(file, samples), "utf8")).ok, true);
  });
}

test("too_large rejects non-string inputs", () => {
  for (const value of [undefined, null, 123, Buffer.from(fixture), {}]) rejects(value, "too_large");
});

test("too_large measures UTF-8 bytes and accepts the exact limit", () => {
  assert.ok(fixture.length < Buffer.byteLength(fixture));
  const padded = fixture + " ".repeat(262144 - Buffer.byteLength(fixture));
  assert.equal(validateDefinition(padded).ok, true);
  rejects(padded + "á", "too_large");
});

test("doctype_forbidden rejects DOCTYPE and ENTITY anywhere, including comments", () => {
  for (const declaration of ['<!DOCTYPE definitions SYSTEM "file:///private">', '<!ENTITY x "private">', "<!-- <!DOCTYPE -->"]) {
    rejects(fixture + declaration, "doctype_forbidden");
  }
});

test("process_count requires exactly one real process tag", () => {
  rejects("<definitions />", "process_count");
  rejects(fixture.replace("</definitions>", '<process id="other_process" name="Other" isExecutable="true" /></definitions>'), "process_count");
  assert.equal(validateDefinition(fixture + '<!-- <process id="ignored" /> -->').ok, true);
});

test("not_executable rejects missing or false isExecutable", () => {
  rejects(fixture.replace(' isExecutable="true"', ""), "not_executable");
  rejects(fixture.replace('isExecutable="true"', 'isExecutable="false"'), "not_executable");
});

test("invalid_key enforces key syntax and length", () => {
  for (const key of ["", "ab", "Sample_two_step", "1sample", "sample-key", "a".repeat(65)]) {
    rejects(fixture.replace('id="sample_two_step"', `id="${key}"`), "invalid_key");
  }
});

test("reserved_key protects technical keys and supports a supplied reserved list", () => {
  assert.deepEqual(RESERVED_KEYS, ["junctura_c4a_single", "junctura_checkpoint"]);
  for (const key of RESERVED_KEYS) rejects(fixture.replace("sample_two_step", key), "reserved_key");
  const result = validateDefinition(fixture, { reservedKeys: ["sample_two_step"] });
  assert.ok(result.problems.some((problem) => problem.rule === "reserved_key"));
  assert.equal(validateDefinition(fixture.replace("sample_two_step", "junctura_checkpoint"), { reservedKeys: [] }).ok, true);
});

test("invalid_name rejects missing, empty, long or control-containing names", () => {
  rejects(fixture.replace(' name="Quy trình mẫu"', ""), "invalid_name");
  for (const name of ["", "a".repeat(121), "Bad\u0001name", "Bad&#10;name", "Bad&#x7f;name"]) {
    rejects(fixture.replace('name="Quy trình mẫu"', `name="${name}"`), "invalid_name");
  }
});

for (const element of ["scriptTask", "serviceTask", "sendTask", "receiveTask", "businessRuleTask", "callActivity", "subProcess", "flowable:executionListener", "flowable:taskListener", "script"]) {
  test(`element_forbidden rejects ${element}`, () => {
    const result = rejects(fixture.replace("</process>", `<${element} /></process>`), "element_forbidden");
    assert.ok(result.problems.some((problem) => problem.rule === "element_forbidden" && problem.detail === element));
  });
}

test("standard BPMN prefixes, diagram interchange and junctura metadata are allowed", () => {
  const xml = fixture.replace(/<(\/?)(definitions|process|userTask|conditionExpression)\b/g, "<$1bpmn:$2")
    .replace("targetNamespace=", 'xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" targetNamespace=')
    .replace("</bpmn:process>", '<extensionElements><junctura:owner xmlns:junctura="https://junctura.studio/schema/bpmn/1" id="nhom-a" name="Nhóm A" /></extensionElements></bpmn:process>')
    .replace("</bpmn:definitions>", '<bpmndi:BPMNDiagram xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"><dc:Bounds xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" /></bpmndi:BPMNDiagram></bpmn:definitions>');
  assert.equal(validateDefinition(xml).ok, true);
});

for (const attribute of ["class", "expression", "delegateExpression", "resultVariable", "async", "formKey", "skipExpression"]) {
  test(`attribute_forbidden rejects flowable:${attribute}`, () => {
    rejects(withTask(`flowable:${attribute}="literal"`), "attribute_forbidden");
  });
}

test("condition_forbidden rejects method calls and other executable conditions", () => {
  for (const condition of ["${runtime.exec('x')}", "${decision}", "${decision > 0}", "#{decision == true}", "${decision == other}", "${decision == 1234567890}", "${decision == '${x}'}"]) {
    rejects(fixture.replace(expression, condition), "condition_forbidden");
  }
  rejects(fixture.replace(/<conditionExpression[^>]*>[^<]*<\/conditionExpression>/, "<conditionExpression />"), "condition_forbidden");
});

test("simple literal conditions and a CDATA-wrapped condition are accepted", () => {
  for (const condition of ["${decision != false}", "${decision == true}", "${decision == -123456789}", "${ decision == '' }", `<![CDATA[ ${expression} ]]>`]) {
    assert.equal(validateDefinition(fixture.replace(expression, condition)).ok, true, condition);
  }
});

test("invalid_group rejects invalid items, including empty list members", () => {
  for (const groups of ["", "x", "Nhom-a", "nhom_a", "nhom-a,", "nhom-a,,nhom-b", "a".repeat(65)]) {
    rejects(fixture.replace('candidateGroups="nhom-a"', `candidateGroups="${groups}"`), "invalid_group");
  }
  assert.equal(validateDefinition(fixture.replace('candidateGroups="nhom-a"', 'candidateGroups=" nhom-a, nhom-b "')).ok, true);
});

test("expression_forbidden rejects expressions in any attribute, including encoded markers", () => {
  for (const attribute of ['flowable:assignee="${x}"', 'flowable:candidateUsers="#{users}"', 'custom="&#36;{secret}"', 'custom="&#x23;{secret}"']) {
    rejects(withTask(attribute), "expression_forbidden");
  }
});

test("all problems are collected without including private values in details", () => {
  const result = validateDefinition(withTask('flowable:class="private-value" flowable:assignee="${privateValue}"')
    .replace("</process>", "<scriptTask /></process>").replace('isExecutable="true"', 'isExecutable="false"'));
  assert.equal(result.ok, false);
  assert.deepEqual(new Set(result.problems.map((problem) => problem.rule)), new Set([
    "attribute_forbidden", "expression_forbidden", "element_forbidden", "not_executable",
  ]));
  assert.ok(!JSON.stringify(result).includes("private-value"));
  assert.ok(!JSON.stringify(result).includes("privateValue"));
});

test("namespace_forbidden rejects aliasing an allowed prefix to the BPMN or Flowable namespace", () => {
  const aliasBpmn = fixture.replace("targetNamespace=", 'xmlns:junctura="http://www.omg.org/spec/BPMN/20100524/MODEL" targetNamespace=')
    .replace("</process>", "<junctura:scriptTask id=\"s\" /></process>");
  rejects(aliasBpmn, "namespace_forbidden");
  const aliasFlowable = withTask('xmlns:x="http://flowable.org/bpmn" x:class="com.example.Task"');
  rejects(aliasFlowable, "namespace_forbidden");
  rejects(aliasFlowable, "attribute_forbidden");
  rejects(fixture.replace("targetNamespace=", 'xmlns:dc="http://flowable.org/bpmn" targetNamespace='), "namespace_forbidden");
});

test("only junctura owner and group metadata elements are allowed", () => {
  const xml = fixture.replace("</process>",
    '<extensionElements><junctura:script xmlns:junctura="https://junctura.studio/schema/bpmn/1" /></extensionElements></process>');
  rejects(xml, "element_forbidden");
});

test("script languages on conditions or definitions are rejected", () => {
  rejects(fixture.replace(/<conditionExpression xsi:type="tFormalExpression"/, '<conditionExpression xsi:type="tFormalExpression" language="groovy"'), "condition_forbidden");
  rejects(fixture.replace(/<conditionExpression xsi:type="tFormalExpression"/, '<conditionExpression xsi:type="tFormalExpression" language="groovy"'), "attribute_forbidden");
  rejects(fixture.replace("targetNamespace=", 'expressionLanguage="groovy" targetNamespace='), "attribute_forbidden");
});
