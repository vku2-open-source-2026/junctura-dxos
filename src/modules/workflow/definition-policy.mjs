// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
export const RESERVED_KEYS = ["junctura_c4a_single", "junctura_checkpoint"];

const ELEMENTS = new Set([
  "definitions", "process", "documentation", "extensionElements", "startEvent", "endEvent", "userTask",
  "sequenceFlow", "exclusiveGateway", "parallelGateway", "conditionExpression", "laneSet", "lane", "flowNodeRef",
]);
const PREFIXES = new Set(["bpmndi", "omgdc", "omgdi", "dc", "di", "junctura"]);
const JUNCTURA_ELEMENTS = new Set(["owner", "group"]);
// Flowable resolves elements and attributes by namespace URI, not by prefix. Every
// namespace declaration must bind a known prefix to its canonical URI, otherwise a
// definition could alias an allowed prefix to the BPMN or Flowable namespace.
const NAMESPACES = new Map([
  ["", "http://www.omg.org/spec/BPMN/20100524/MODEL"],
  ["bpmn", "http://www.omg.org/spec/BPMN/20100524/MODEL"],
  ["bpmndi", "http://www.omg.org/spec/BPMN/20100524/DI"],
  ["omgdc", "http://www.omg.org/spec/DD/20100524/DC"],
  ["dc", "http://www.omg.org/spec/DD/20100524/DC"],
  ["omgdi", "http://www.omg.org/spec/DD/20100524/DI"],
  ["di", "http://www.omg.org/spec/DD/20100524/DI"],
  ["flowable", "http://flowable.org/bpmn"],
  ["xsi", "http://www.w3.org/2001/XMLSchema-instance"],
  ["junctura", "https://junctura.studio/schema/bpmn/1"],
]);
const ATTRIBUTE_PREFIXES = new Set(["flowable", "xsi"]);
const LANGUAGE_ATTRIBUTES = new Set(["expressionLanguage", "typeLanguage", "language"]);
const FORBIDDEN_ATTRIBUTES = new Set([
  "flowable:class", "flowable:expression", "flowable:delegateExpression", "flowable:resultVariable",
  "flowable:async", "flowable:formKey", "flowable:skipExpression",
]);
const CONDITION = /^\$\{\s*[a-z][a-zA-Z0-9_]{0,40}\s*(==|!=)\s*('[^'$\\{}]{0,64}'|true|false|-?\d{1,9})\s*\}$/;

// Decode XML character references before checking values, so encoded expressions
// and control characters receive the same policy as their literal equivalents.
function decodeReferences(value) {
  const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return value.replace(/&(#x[\da-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (reference, entity) => {
    if (!entity.startsWith("#")) return entities[entity];
    const code = entity.startsWith("#x") ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code <= 0x10ffff ? String.fromCodePoint(code) : reference;
  });
}

function attributes(source) {
  return [...source.matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
    .map(([, name, doubleQuoted, singleQuoted]) => [name, decodeReferences(doubleQuoted ?? singleQuoted)]);
}

function conditionText(source) {
  const value = source.trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(value);
  return cdata ? cdata[1].trim() : decodeReferences(value);
}

export function validateDefinition(xml, { reservedKeys = RESERVED_KEYS, includeTasks = false } = {}) {
  const problems = [];
  const reject = (rule, detail) => problems.push({ rule, detail });
  if (typeof xml !== "string") {
    return { ok: false, problems: [{ rule: "too_large", detail: "Definition must be a UTF-8 string of at most 262144 bytes" }] };
  }
  if (Buffer.byteLength(xml, "utf8") > 262144) reject("too_large", "Definition exceeds 262144 UTF-8 bytes");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) reject("doctype_forbidden", "DOCTYPE and ENTITY declarations are forbidden");

  const processes = [];
  const conditions = [];
  const tasks = [];
  // Scan complete tags (including quoted '>'), skipping comments, processing
  // instructions and CDATA. This is a safety policy, not an XML schema parser.
  const tags = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w.:-]*)((?:[^"'<>]|"[^"]*"|'[^']*')*)>/g;
  for (const match of xml.matchAll(tags)) {
    const [, closing, element, source] = match;
    if (!element) continue;
    const parts = element.split(":");
    const localName = parts.at(-1);
    if (closing) {
      if (localName === "conditionExpression" && conditions.length) {
        const start = conditions.pop();
        if (!CONDITION.test(conditionText(xml.slice(start, match.index)))) {
          reject("condition_forbidden", "Conditions must compare one variable with a literal using == or !=");
        }
      }
      continue;
    }
    if (!ELEMENTS.has(localName) && !(parts.length === 2 && PREFIXES.has(parts[0]))) {
      reject("element_forbidden", element);
    } else if (parts.length === 2 && parts[0] === "junctura" && !JUNCTURA_ELEMENTS.has(localName)) {
      reject("element_forbidden", element);
    } else if (parts.length > 2) {
      reject("element_forbidden", element);
    }
    const entries = attributes(source);
    const attrs = new Map(entries);
    if (localName === "process") processes.push(attrs);
    if (includeTasks && (element === "userTask" || element === "bpmn:userTask")) {
      const id = attrs.get("id");
      const groups = attrs.get("flowable:candidateGroups")?.split(",").map(group => group.trim()) ?? [];
      if (!/^[A-Za-z0-9:_-]{1,128}$/.test(id ?? "") || tasks.some(task => task.id === id)) {
        reject("invalid_task_id", "User task IDs must be unique and match the workflow task key format");
      }
      tasks.push({ id, name: attrs.get("name") || id, groups: [...new Set(groups)] });
    }
    for (const [name, value] of entries) {
      if (name === "xmlns" || name.startsWith("xmlns:")) {
        const prefix = name === "xmlns" ? "" : name.slice(6);
        if (NAMESPACES.get(prefix) !== value.trim()) reject("namespace_forbidden", name);
        continue;
      }
      const prefix = name.includes(":") ? name.split(":")[0] : null;
      if (prefix !== null && !ATTRIBUTE_PREFIXES.has(prefix)) reject("attribute_forbidden", name);
      if (LANGUAGE_ATTRIBUTES.has(name)) reject("attribute_forbidden", name);
      if (localName === "conditionExpression" && name !== "xsi:type") {
        reject("condition_forbidden", `Condition attribute ${name} is not allowed`);
      }
      if (localName === "conditionExpression" && name === "xsi:type" && value !== "tFormalExpression") {
        reject("condition_forbidden", "Conditions must be tFormalExpression");
      }
      if (FORBIDDEN_ATTRIBUTES.has(name)) reject("attribute_forbidden", name);
      if (value.includes("${") || value.includes("#{")) reject("expression_forbidden", name);
      if (name === "flowable:candidateGroups" &&
        !value.split(",").every((group) => /^[a-z][a-z0-9-]{1,63}$/.test(group.trim()))) {
        reject("invalid_group", "Candidate groups must be comma-separated lowercase group identifiers");
      }
    }
    if (localName === "conditionExpression") {
      if (/\/\s*$/.test(source)) reject("condition_forbidden", "Conditions cannot be empty");
      else conditions.push(match.index + match[0].length);
    }
  }
  if (conditions.length) reject("condition_forbidden", "Conditions must have a closing tag");
  if (processes.length !== 1) reject("process_count", "Definition must contain exactly one process");
  for (const attrs of processes) {
    if (attrs.get("isExecutable") !== "true") reject("not_executable", "Process must set isExecutable to true");
    const key = attrs.get("id");
    if (!/^[a-z][a-z0-9_]{2,63}$/.test(key ?? "")) reject("invalid_key", "Process id must be 3 to 64 lowercase letters, digits or underscores, starting with a letter");
    if (reservedKeys.includes(key)) reject("reserved_key", "Process id is reserved for Core technical workflows");
    const name = attrs.get("name");
    if (!name || name.length > 120 || /[\u0000-\u001f\u007f-\u009f]/u.test(name)) {
      reject("invalid_name", "Process name must be 1 to 120 characters without control characters");
    }
  }
  if (problems.length) return { ok: false, problems };
  return { ok: true, key: processes[0].get("id"), name: processes[0].get("name"), ...(includeTasks ? { tasks } : {}) };
}
