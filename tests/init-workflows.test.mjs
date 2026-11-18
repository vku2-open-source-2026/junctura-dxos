// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initWorkflows } from "../scripts/init-workflows.mjs";
import { workflowText } from "../src/modules/workflow/client.mjs";

const sample = await readFile(new URL("./fixtures/workflows/sample-two-step.bpmn20.xml", import.meta.url), "utf8");
const checkpoint = await readFile(new URL("../infra/flowable/checkpoint.bpmn20.xml", import.meta.url), "utf8");
const tenants = " tenant-a, tenant-b ";

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "junctura-workflows-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "business", "nested"), { recursive: true });
  await writeFile(join(root, "business", "nested", "sample.bpmn20.xml"), sample);
  await writeFile(join(root, "checkpoint.bpmn20.xml"), checkpoint);
  await writeFile(join(root, "business", "README.md"), "Not a BPMN file");
  await mkdir(join(root, "unrelated"));
  await writeFile(join(root, "unrelated", "ignored.bpmn20.xml"), "Not a technical definition");
  return root;
}

function engine(previous, allowedTenants = ["tenant-a", "tenant-b"]) {
  const calls = [], uploads = [], reads = [], messages = [];
  const request = async (path, options) => {
    calls.push(path);
    if (path === "repository/deployments") {
      assert.equal(options.method, "POST");
      const file = options.body.get("file");
      uploads.push({ tenant: options.body.get("tenantId"), name: file.name, xml: await file.text() });
      return { id: "deployment-id" };
    }
    const url = new URL(path, "https://engine.invalid/");
    assert.equal(url.pathname, "/repository/process-definitions");
    assert.equal(url.searchParams.get("latest"), "true");
    const key = url.searchParams.get("key"), tenant = url.searchParams.get("tenantId");
    assert.ok(allowedTenants.includes(tenant));
    return { data: previous ? [{ id: `${key}:1:${tenant}/resource` }] : [] };
  };
  const text = async (path) => {
    reads.push(path);
    assert.match(path, /^repository\/process-definitions\/[^/]+%2Fresource\/resourcedata$/);
    const key = decodeURIComponent(path.split("/")[2]).split(":")[0];
    return previous(key);
  };
  return { request, text, log: (message) => messages.push(message), calls, uploads, reads, messages };
}

test("rejects all invalid business files before any engine request or deployment", async (t) => {
  const root = await workspace(t);
  await writeFile(join(root, "business", "z-invalid.bpmn20.xml"), sample.replace("</process>", '<scriptTask id="private-content" flowable:class="private-class" /></process>'));
  await writeFile(join(root, "business", "nested", "invalid-name.bpmn20.xml"), sample.replace('name="Quy trình mẫu"', 'name=""'));
  const fake = engine();
  const result = await initWorkflows({ root, tenants, ...fake });
  assert.deepEqual(result, { ok: false, deployed: 0 });
  assert.deepEqual(fake.calls, []);
  assert.deepEqual(fake.uploads, []);
  assert.deepEqual(fake.reads, []);
  assert.equal(fake.messages.length, 3);
  assert.ok(fake.messages.every((line) => /^Workflow definition [^\n]+\.bpmn20\.xml rejected: \w+ [^\n]+$/.test(line)));
  assert.ok(fake.messages.some((line) => line.includes("z-invalid.bpmn20.xml rejected: element_forbidden scriptTask")));
  assert.ok(fake.messages.some((line) => line.includes("z-invalid.bpmn20.xml rejected: attribute_forbidden flowable:class")));
  assert.ok(fake.messages.some((line) => line.includes("invalid-name.bpmn20.xml rejected: invalid_name")));
  assert.ok(!fake.messages.join("\n").includes("private-"));
});

test("deploys a new business key and the technical checkpoint for every configured tenant", async (t) => {
  const root = await workspace(t);
  const fake = engine();
  const result = await initWorkflows({ root, tenants, ...fake });
  assert.deepEqual(result, { ok: true, business: 1, technical: 1, tenants: ["tenant-a", "tenant-b"], deployed: 4 });
  assert.deepEqual(fake.uploads, [
    { tenant: "tenant-a", name: "sample.bpmn20.xml", xml: sample },
    { tenant: "tenant-b", name: "sample.bpmn20.xml", xml: sample },
    { tenant: "tenant-a", name: "checkpoint.bpmn20.xml", xml: checkpoint },
    { tenant: "tenant-b", name: "checkpoint.bpmn20.xml", xml: checkpoint },
  ]);
  assert.deepEqual(fake.reads, []);
  assert.equal(fake.messages.at(-1), "Workflow definitions ready: 1 business, 1 technical, tenants: tenant-a,tenant-b (4 deployed)");
});

test("the default deploys business and technical definitions to both environments and legacy tenants", async (t) => {
  const previous = process.env.WORKFLOW_TENANTS;
  t.after(() => {
    if (previous === undefined) delete process.env.WORKFLOW_TENANTS;
    else process.env.WORKFLOW_TENANTS = previous;
  });
  delete process.env.WORKFLOW_TENANTS;
  const root = await workspace(t);
  const expected = ["demo", "production", "tenant-a", "tenant-b"];
  const fake = engine(undefined, expected);
  const result = await initWorkflows({ root, ...fake });
  assert.deepEqual(result, { ok: true, business: 1, technical: 1, tenants: expected, deployed: 8 });
  assert.deepEqual(fake.uploads.map(({ tenant, name }) => [tenant, name]), [
    ...expected.map(tenant => [tenant, "sample.bpmn20.xml"]),
    ...expected.map(tenant => [tenant, "checkpoint.bpmn20.xml"]),
  ]);
});

test("skips identical resource XML for business and technical definitions", async (t) => {
  const root = await workspace(t);
  const fake = engine((key) => key === "sample_two_step" ? sample : checkpoint);
  const result = await initWorkflows({ root, tenants, ...fake });
  assert.equal(result.deployed, 0);
  assert.equal(fake.reads.length, 4);
  assert.deepEqual(fake.uploads, []);
  assert.equal(fake.messages.at(-1), "Workflow definitions ready: 1 business, 1 technical, tenants: tenant-a,tenant-b (0 deployed)");
});

test("redeploys changed XML while skipping an unchanged checkpoint", async (t) => {
  const root = await workspace(t);
  const fake = engine((key) => key === "sample_two_step" ? sample.replace('name="Bước 1"', 'name="Earlier step"') : checkpoint);
  const result = await initWorkflows({ root, tenants, ...fake });
  assert.equal(result.deployed, 2);
  assert.equal(fake.reads.length, 4);
  assert.deepEqual(fake.uploads.map((file) => [file.tenant, file.name, file.xml]), [
    ["tenant-a", "sample.bpmn20.xml", sample], ["tenant-b", "sample.bpmn20.xml", sample],
  ]);
});

test("empty business directory deploys only the technical checkpoint", async (t) => {
  const root = await workspace(t);
  await rm(join(root, "business", "nested"), { recursive: true });
  const fake = engine();
  const result = await initWorkflows({ root, tenants: "tenant-a", ...fake });
  assert.deepEqual(result, { ok: true, business: 0, technical: 1, tenants: ["tenant-a"], deployed: 1 });
  assert.equal(fake.uploads[0].name, "checkpoint.bpmn20.xml");
});

test("invalid WORKFLOW_TENANTS is rejected before filesystem or engine access", async () => {
  const fake = engine();
  for (const value of ["", "tenant-a,", ",tenant-a", "Tenant-a", "tenant_a", "-tenant", "a".repeat(64), "tenant-a, bad tenant", ["tenant-a"]]) {
    await assert.rejects(initWorkflows({ root: "/does-not-exist", tenants: value, ...fake }), /Invalid WORKFLOW_TENANTS/);
  }
  assert.deepEqual(fake.calls, []);
});

test("reads and rejects invalid WORKFLOW_TENANTS from the environment", async (t) => {
  const previous = process.env.WORKFLOW_TENANTS;
  t.after(() => {
    if (previous === undefined) delete process.env.WORKFLOW_TENANTS;
    else process.env.WORKFLOW_TENANTS = previous;
  });
  process.env.WORKFLOW_TENANTS = "invalid_tenant";
  const fake = engine();
  await assert.rejects(initWorkflows({ root: "/does-not-exist", ...fake }), /Invalid WORKFLOW_TENANTS/);
  assert.deepEqual(fake.calls, []);
});

test("a resource read error prevents redeployment", async (t) => {
  const root = await workspace(t);
  const fake = engine(() => sample);
  await assert.rejects(initWorkflows({ root, tenants, ...fake,
    text: async () => { throw new Error("engine unavailable"); } }), /engine unavailable/);
  assert.deepEqual(fake.uploads, []);
});

const config = { workflowUrl: "https://engine.invalid", workflowPassword: "private-test-password" };

test("workflowText returns original XML with the client's authentication and timeout", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://engine.invalid/repository/process-definitions/id/resourcedata");
    assert.equal(options.headers.Authorization, `Basic ${Buffer.from("junctura-engine:private-test-password").toString("base64")}`);
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(sample);
  });
  assert.equal(await workflowText(config, "repository/process-definitions/id/resourcedata"), sample);
});

test("workflowText accepts exactly 262144 bytes and rejects larger streamed bodies", async (t) => {
  const padded = sample + " ".repeat(262144 - Buffer.byteLength(sample));
  let body = padded;
  t.mock.method(globalThis, "fetch", async () => new Response(body));
  assert.equal(await workflowText(config, "resource"), padded);
  body += "á";
  await assert.rejects(workflowText(config, "resource"), { status: 503, message: "workflow_unavailable" });
});

test("workflowText caps streamed bytes even without a Content-Length header", async (t) => {
  let cancelled = false;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(65536)); },
    cancel() { cancelled = true; },
  })));
  await assert.rejects(workflowText(config, "resource"), { status: 503, message: "workflow_unavailable" });
  assert.equal(cancelled, true);
});

for (const [status, expectedStatus, message] of [[404, 404, "not_found"], [409, 409, "workflow_conflict"], [500, 503, "workflow_unavailable"]]) {
  test(`workflowText preserves the client error mapping for HTTP ${status}`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => new Response("private error body", { status }));
    await assert.rejects(workflowText(config, "resource"), { status: expectedStatus, message });
  });
}

test("workflowText maps transport and response stream failures to workflow_unavailable", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async () => { throw new Error("private network detail"); });
  await assert.rejects(workflowText(config, "resource"), { status: 503, message: "workflow_unavailable" });
  mock.mock.mockImplementation(async () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error("private stream detail")); },
  })));
  await assert.rejects(workflowText(config, "resource"), { status: 503, message: "workflow_unavailable" });
});
