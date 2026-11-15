// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { workflowRequest, workflowText } from "../src/modules/workflow/client.mjs";
import { validateDefinition } from "../src/modules/workflow/definition-policy.mjs";

async function definitions(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await definitions(path));
    else if (entry.isFile() && entry.name.endsWith(".bpmn20.xml")) found.push(path);
  }
  return found.sort();
}

export async function initWorkflows({
  root = "/definitions",
  tenants = process.env.WORKFLOW_TENANTS ?? "tenant-a,tenant-b",
  request,
  text,
  log = console.log,
} = {}) {
  if (typeof tenants !== "string") throw new Error("Invalid WORKFLOW_TENANTS");
  const tenantIds = tenants.split(",").map((tenant) => tenant.trim());
  if (!tenantIds.every((tenant) => /^[a-z0-9][a-z0-9-]{0,62}$/.test(tenant))) {
    throw new Error("Invalid WORKFLOW_TENANTS");
  }
  const config = { workflowUrl: process.env.WORKFLOW_URL, workflowPassword: process.env.WORKFLOW_ADMIN_PASSWORD };
  request ??= (path, options) => workflowRequest(config, path, options);
  text ??= (path) => workflowText(config, path);

  const entries = await readdir(root, { withFileTypes: true });
  const business = entries.some((entry) => entry.isDirectory() && entry.name === "business")
    ? await definitions(join(root, "business")) : [];
  const technical = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".bpmn20.xml"))
    .map((entry) => join(root, entry.name)).sort();
  const prepared = [];
  let rejected = false;
  for (const file of business) {
    const xml = await readFile(file, "utf8");
    const result = validateDefinition(xml);
    if (!result.ok) {
      rejected = true;
      for (const { rule, detail } of result.problems) {
        log(`Workflow definition ${basename(file)} rejected: ${rule} ${detail}`);
      }
    } else prepared.push({ xml, key: result.key, name: basename(file) });
  }
  if (rejected) return { ok: false, deployed: 0 };
  for (const file of technical) {
    const xml = await readFile(file, "utf8");
    const key = /<process\b[^>]*\bid="([^"]+)"/.exec(xml)?.[1];
    if (!key) throw new Error("Technical workflow definition has no process id");
    prepared.push({ xml, key, name: basename(file) });
  }

  let deployed = 0;
  for (const { xml, key, name } of prepared) {
    for (const tenant of tenantIds) {
      const query = new URLSearchParams({ key, tenantId: tenant, latest: "true" });
      const existing = await request(`repository/process-definitions?${query}`);
      const latest = existing.data[0];
      if (latest && await text(`repository/process-definitions/${encodeURIComponent(latest.id)}/resourcedata`) === xml) continue;
      const form = new FormData();
      form.append("tenantId", tenant);
      form.append("file", new Blob([xml], { type: "application/xml" }), name);
      await request("repository/deployments", { method: "POST", body: form });
      deployed += 1;
    }
  }
  log(`Workflow definitions ready: ${business.length} business, ${technical.length} technical, tenants: ${tenantIds.join(",")} (${deployed} deployed)`);
  return { ok: true, business: business.length, technical: technical.length, tenants: tenantIds, deployed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await initWorkflows();
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error?.message === "Invalid WORKFLOW_TENANTS"
      ? "Invalid WORKFLOW_TENANTS: use comma-separated lowercase tenant identifiers"
      : "Workflow initialization failed; inspect engine readiness and private configuration");
    process.exitCode = 1;
  }
}
