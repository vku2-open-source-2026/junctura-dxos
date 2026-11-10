// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { workflowRequest } from "../src/modules/workflow/client.mjs";

const config = { workflowUrl: process.env.WORKFLOW_URL, workflowPassword: process.env.WORKFLOW_ADMIN_PASSWORD };

async function definitions(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await definitions(path));
    else if (entry.name.endsWith(".bpmn20.xml")) found.push(path);
  }
  return found.sort();
}

async function deploy(template, name) {
  const xml = await readFile(template, "utf8");
  const key = /<process\b[^>]*\bid="([^"]+)"/.exec(xml)?.[1];
  if (!key) throw new Error(`Workflow definition ${name} has no process id`);
  for (const tenant of ["tenant-a", "tenant-b"]) {
    const query = new URLSearchParams({ key, tenantId: tenant, latest: "true" });
    const existing = await workflowRequest(config, `repository/process-definitions?${query}`);
    if (existing.data.length) continue;
    const form = new FormData();
    form.append("tenantId", tenant);
    form.append("file", new Blob([xml], { type: "application/xml" }), name);
    await workflowRequest(config, "repository/deployments", { method: "POST", body: form });
  }
}

try {
  const files = await definitions("/definitions");
  for (const file of files) await deploy(file, file.split("/").at(-1));
  console.log(`Workflow definitions are available for the two local fixture tenants (${files.length} files)`);
} catch {
  console.error("Workflow initialization failed; inspect engine readiness and private configuration");
  process.exitCode = 1;
}
