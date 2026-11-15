// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDefinition, workflowSummary } from "../src/modules/workflow/summary.mjs";
import { handleWorkflow } from "../src/modules/workflow/workflow.mjs";

const config = { workflowUrl: "http://engine.invalid", dataUrl: "http://data.invalid", dataSecret: "x".repeat(32) };
const tenantId = "tenant-summary";
const xml = (body, attrs = 'id="quy_trinh_a" name="Quy trình A"') => `<?xml version="1.0"?>
  <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
      xmlns:flowable="http://flowable.org/bpmn" xmlns:junctura="https://junctura.studio/schema/bpmn/1">
    <process ${attrs} isExecutable="true">${body}</process>
  </definitions>`;
const metadata = `<extensionElements>
  <junctura:owner id="nhom-a" name="Nhóm chủ trì" />
  <junctura:group id="nhom-a" name="Nhóm A" />
  <junctura:group id="nhom-b" name="Nhóm B" />
</extensionElements>`;
const steps = `<userTask id="step_1" name="Bước 1" flowable:candidateGroups="nhom-a" />
  <userTask id="step_2" name="Bước 2" flowable:candidateGroups="unknown-group, nhom-b, nhom-a" />
  <userTask id="repeat" name="Bước 1" flowable:candidateGroups="nhom-b" />
  <userTask id="unnamed" flowable:candidateGroups="nhom-a" />`;

test("parseDefinition reads owner, groups and deduplicated named user tasks", () => {
  const definition = parseDefinition(xml(metadata + steps));
  assert.equal(definition.key, "quy_trinh_a");
  assert.equal(definition.name, "Quy trình A");
  assert.deepEqual(definition.owner, { id: "nhom-a", name: "Nhóm chủ trì" });
  assert.deepEqual(definition.groups, new Map([["nhom-a", "Nhóm A"], ["nhom-b", "Nhóm B"]]));
  assert.deepEqual(definition.steps, [{ name: "Bước 1", owner: "Nhóm A" }, { name: "Bước 2", owner: "Nhóm B" }]);
});

test("parseDefinition accepts reordered attributes, either quote style and BPMN prefixes", () => {
  const source = xml(`<bpmn:userTask flowable:candidateGroups = 'nhom-b' name = 'Bước &quot;1&quot; > 0' id='step_1' />
    <bpmn:extensionElements>
      <junctura:group name = 'Nhóm B &amp; C' id = 'nhom-b'></junctura:group>
      <junctura:owner name='Nhóm &#65;' id='nhom-a'></junctura:owner>
    </bpmn:extensionElements>`, "name = 'Quy trình A' id = 'quy_trinh_a'")
    .replace(/<(\/?)(definitions|process)\b/g, "<$1bpmn:$2")
    .replace("xmlns=", 'xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns=');
  const definition = parseDefinition(source);
  assert.deepEqual(definition.owner, { id: "nhom-a", name: "Nhóm A" });
  assert.deepEqual(definition.steps, [{ name: 'Bước "1" > 0', owner: "Nhóm B & C" }]);
});

test("parseDefinition ignores metadata outside the process extensionElements", () => {
  const junk = '<junctura:owner id="junk-owner" name="Junk" /><junctura:group id="nhom-a" name="Junk" />';
  const source = xml(`${junk}
    <documentation><extensionElements>${junk}</extensionElements></documentation>
    <userTask name="Bước 1" flowable:candidateGroups="nhom-a">
      <extensionElements>${junk}</extensionElements>
    </userTask>
    <!-- <extensionElements>${junk}</extensionElements><userTask name="Junk" /> -->
    <documentation><![CDATA[<extensionElements>${junk}</extensionElements>]]></documentation>`)
    .replace('<process id=', `<extensionElements>${junk}</extensionElements><process id=`)
    .replace("</definitions>", `${junk}<extensionElements>${junk}</extensionElements></definitions>`);
  const definition = parseDefinition(source);
  assert.equal(definition.owner, null);
  assert.deepEqual(definition.groups, new Map());
  assert.deepEqual(definition.steps, [{ name: "Bước 1", owner: null }]);
});

test("missing or unnamed groups never expose a raw group id as step owner", () => {
  const definition = parseDefinition(xml(`<extensionElements>
    <junctura:group id="unnamed-group" />
    <junctura:group id="empty-group" name="" />
    <junctura:group id="named-group" name="Nhóm có tên" />
  </extensionElements>
  <userTask name="Bước 1" flowable:candidateGroups="missing-group, unnamed-group, empty-group" />
  <userTask name="Bước 2" flowable:candidateGroups="unnamed-group, named-group" />
  <userTask name="Bước 3" />`));
  assert.equal(definition.owner, null);
  assert.deepEqual(definition.groups, new Map([["named-group", "Nhóm có tên"]]));
  assert.deepEqual(definition.steps, [
    { name: "Bước 1", owner: null }, { name: "Bước 2", owner: "Nhóm có tên" }, { name: "Bước 3", owner: null },
  ]);
});

test("metadata identifiers and all displayed names are validated", () => {
  for (const id of ["", "a", "Nhom-a", "nhom_a", "1nhom", "nhom a", "a".repeat(65), "nhom-a&#10;"]) {
    const definition = parseDefinition(xml(`<extensionElements>
      <junctura:owner id="${id}" name="Nhóm A" /><junctura:group id="${id}" name="Nhóm A" />
    </extensionElements><userTask name="Bước 1" flowable:candidateGroups="${id}" />`));
    assert.equal(definition.owner, null, id);
    assert.deepEqual(definition.groups, new Map(), id);
    assert.deepEqual(definition.steps, [{ name: "Bước 1", owner: null }], id);
  }
  for (const name of ["", "Unsafe&#10;name", "Unsafe&#x7f;name", "a".repeat(201)]) {
    const definition = parseDefinition(xml(`<extensionElements>
      <junctura:owner id="nhom-a" name="${name}" /><junctura:group id="nhom-a" name="${name}" />
    </extensionElements><userTask name="${name}" /><userTask name="Safe" flowable:candidateGroups="nhom-a" />`));
    assert.equal(definition.owner, null);
    assert.deepEqual(definition.groups, new Map());
    assert.deepEqual(definition.steps, [{ name: "Safe", owner: null }]);
    assert.equal(parseDefinition(xml("", `id="quy_trinh_a" name="${name}"`)), null);
  }
});

test("unreadable or malformed definitions fail parsing", () => {
  for (const source of [undefined, null, {}, "", "not XML", "<definitions />", xml(steps).slice(0, -15),
    xml(steps).replace("</process>", "</userTask>"), xml(steps).replace('name="Quy trình A"', "name=unquoted"),
    xml(steps).replace('name="Quy trình A"', ""), xml(steps) + "<broken", xml(steps) + xml(steps),
    '<!DOCTYPE definitions [<!ENTITY private "value">]>' + xml(steps)]) {
    assert.equal(parseDefinition(source), null);
  }
});

function mockEngine(t, { definitions, resources = new Map(), history = [], listStatus = 200 }) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (address) => {
    const url = new URL(address);
    requests.push(url);
    if (url.origin === config.dataUrl && url.pathname === "/rpc/workflow_audit_access") {
      return Response.json({ status: 200, value: { allowed: true } });
    }
    assert.equal(url.origin, config.workflowUrl);
    if (url.pathname === "/repository/process-definitions") {
      assert.equal(url.searchParams.get("tenantId"), tenantId);
      assert.equal(url.searchParams.get("latest"), "true");
      return Response.json({ data: definitions }, { status: listStatus });
    }
    if (url.pathname === "/history/historic-process-instances") {
      assert.equal(url.searchParams.get("tenantId"), tenantId);
      assert.equal(url.searchParams.has("includeProcessVariables"), false);
      return Response.json({ data: history, total: history.length });
    }
    const match = /^\/repository\/process-definitions\/([^/]+)\/resourcedata$/.exec(url.pathname);
    assert.ok(match, address);
    const resource = resources.get(decodeURIComponent(match[1]));
    if (resource instanceof Error) throw resource;
    if (resource instanceof Response) return resource.clone();
    return new Response(resource ?? null, { status: resource === undefined ? 404 : 200 });
  });
  return requests;
}

test("summary reads deployed owner and steps, caches immutable ids and excludes technical definitions", async (t) => {
  const id = "quy_trinh_a:1:cache-test";
  const requests = mockEngine(t, {
    definitions: [
      { id, key: "quy_trinh_a", name: "Quy trình A" },
      { id: "checkpoint:1:cache-test", key: "junctura_checkpoint", name: "Technical" },
      { id: "c4a:1:cache-test", key: "junctura_c4a_single", name: "Technical" },
    ],
    resources: new Map([[id, xml(metadata + steps)]]),
    history: [
      { id: "run-1", tenantId, processDefinitionId: id, startTime: "2026-02-01T08:00:00Z" },
      { id: "done-1", tenantId, processDefinitionKey: "quy_trinh_cu", processDefinitionName: "Quy trình cũ", endTime: "2026-02-02T08:00:00Z" },
      { id: "technical-1", tenantId, processDefinitionKey: "junctura_checkpoint" },
      { id: "technical-2", tenantId, processDefinitionKey: "junctura_c4a_single" },
      { id: "other-tenant", tenantId: "tenant-other", processDefinitionKey: "quy_trinh_a" },
    ],
  });
  const first = await workflowSummary(config, tenantId);
  assert.deepEqual(first, await workflowSummary(config, tenantId));
  assert.deepEqual(first, {
    definitions: [
      {
        key: "quy_trinh_a", name: "Quy trình A", application: { id: "nhom-a", name: "Nhóm chủ trì" },
        steps: [{ name: "Bước 1", owner: "Nhóm A" }, { name: "Bước 2", owner: "Nhóm B" }],
        counts: { running: 1, completed: 0, cancelled: 0 }, updatedAt: "2026-02-01T08:00:00.000Z",
      },
      {
        key: "quy_trinh_cu", name: "Quy trình cũ", application: null, steps: [],
        counts: { running: 0, completed: 1, cancelled: 0 }, updatedAt: "2026-02-02T08:00:00.000Z",
      },
    ],
    totals: { definitions: 2, running: 1, completed: 1, cancelled: 0 },
  });
  assert.deepEqual(requests.filter((url) => url.pathname.endsWith("/resourcedata")).map((url) => url.pathname),
    [`/repository/process-definitions/${encodeURIComponent(id)}/resourcedata`]);
  assert.equal(requests.filter((url) => url.pathname === "/repository/process-definitions").length, 2);
});

test("metadata load and parse failures affect only their own definition and the route returns 200", async (t) => {
  const failures = [
    ["missing", new Response(null, { status: 404 })],
    ["unavailable", new Response(null, { status: 503 })],
    ["network", new Error("unavailable")],
    ["malformed", xml(metadata + steps).replace("</process>", "")],
  ];
  const healthyId = "quy_trinh_a:1:failure-test";
  mockEngine(t, {
    definitions: [{ id: healthyId, key: "quy_trinh_a", name: "Quy trình A" }, ...failures.map(([key]) => ({
      id: `${key}:1:failure-test`, key, name: key,
    }))],
    resources: new Map([[healthyId, xml(metadata + steps)], ...failures.map(([key, resource]) => [`${key}:1:failure-test`, resource])]),
  });
  const response = {
    setHeader() {},
    writeHead(status) { this.status = status; },
    end(body) { this.body = JSON.parse(body); },
  };
  await handleWorkflow({ method: "GET" }, response, { tenantId, clientId: "auditor" }, config,
    new URL("http://core.invalid/v1/workflows/summary"));
  assert.equal(response.status, 200);
  const definitions = new Map(response.body.definitions.map((definition) => [definition.key, definition]));
  assert.deepEqual(definitions.get("quy_trinh_a").application, { id: "nhom-a", name: "Nhóm chủ trì" });
  assert.deepEqual(definitions.get("quy_trinh_a").steps, [{ name: "Bước 1", owner: "Nhóm A" }, { name: "Bước 2", owner: "Nhóm B" }]);
  for (const [key] of failures) {
    assert.equal(definitions.get(key).application, null);
    assert.deepEqual(definitions.get(key).steps, []);
  }
});

test("definition list failure still propagates as workflow_unavailable", async (t) => {
  mockEngine(t, { definitions: [], listStatus: 503 });
  await assert.rejects(workflowSummary(config, tenantId), (error) => error.status === 503 && error.message === "workflow_unavailable");
});

test("metadata cache evicts the oldest definition after 200 entries", async (t) => {
  const definitions = [];
  const resources = new Map();
  const requests = mockEngine(t, { definitions, resources });
  for (let batch = 0; batch < 3; batch += 1) {
    definitions.length = 0;
    for (let index = batch * 100; index < Math.min((batch + 1) * 100, 201); index += 1) {
      const id = `cache-eviction-${index}`;
      definitions.push({ id, key: `quy_trinh_${index}`, name: "Quy trình" });
      resources.set(id, xml(metadata + steps));
    }
    await workflowSummary(config, tenantId);
  }
  const resourcesBefore = requests.filter((url) => url.pathname.endsWith("/resourcedata")).length;
  assert.equal(resourcesBefore, 201);
  definitions.splice(0, definitions.length,
    { id: "cache-eviction-0", key: "quy_trinh_0", name: "Quy trình" },
    { id: "cache-eviction-200", key: "quy_trinh_200", name: "Quy trình" });
  await workflowSummary(config, tenantId);
  const resourceRequests = requests.filter((url) => url.pathname.endsWith("/resourcedata"));
  assert.equal(resourceRequests.length, 202);
  assert.equal(resourceRequests.at(-1).pathname, "/repository/process-definitions/cache-eviction-0/resourcedata");
});
