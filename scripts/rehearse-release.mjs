// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, readdirSync, writeFileSync } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { sha256 } from "./backup.mjs";

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  project: { type: "string" }, port: { type: "string" }, "console-port": { type: "string" },
  prepare: { type: "boolean", default: false }, report: { type: "string" },
} });
const archive = positionals.length === 1 && realpathSync(resolve(positionals[0]));
const port = value => /^\d{2,5}$/.test(value ?? "") && Number(value) >= 1024 && Number(value) <= 65535;
if (!archive || !archive.endsWith(".tar.gz") || !/^jx-release-[a-z0-9-]+$/.test(values.project ?? "") ||
    !port(values.port) || !port(values["console-port"]) || Number(values.port) === Number(values["console-port"])) {
  throw new Error("Usage: npm run release:rehearse -- <archive.tar.gz> --project jx-release-demo --port 28080 --console-port 23000 [--prepare] [--report path]");
}
const sidecar = readFileSync(archive + ".sha256", "utf8").trim().match(/^([a-f0-9]{64})\s+\*?([^/]+)$/);
if (!sidecar || sidecar[2] !== basename(archive) || sidecar[1] !== await sha256(archive)) throw new Error("Source archive checksum mismatch");

const listing = execFileSync("tar", ["-tvzf", archive], { encoding: "utf8" });
if (listing.trim().split("\n").some(line => !/^[-d]/.test(line))) throw new Error("Source archive has an unsupported file type");
const names = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
if (names.some(name => name.startsWith("/") || name.includes("\\") || name.split("/").includes(".."))) {
  throw new Error("Source archive has a path outside the extraction root");
}

if (!values.prepare) {
  const label = `com.docker.compose.project=${values.project}`;
  for (const resource of ["container", "volume", "network"]) {
    const list = ["ls", "-q"];
    if (resource === "container") list.push("--all");
    if (execFileSync("docker", [resource, ...list, "--filter", `label=${label}`], { encoding: "utf8" }).trim()) {
      throw new Error(`Rehearsal project already owns Docker ${resource} resources`);
    }
  }
}
const directory = mkdtempSync(join(tmpdir(), "jx-release-rehearsal-"));
execFileSync("tar", ["-xzf", archive, "-C", directory], { stdio: "inherit" });
const [root] = readdirSync(directory);
if (readdirSync(directory).length !== 1 || root !== basename(archive, ".tar.gz")) throw new Error("Unexpected source archive root");
const cwd = join(directory, root);
const elapsed = {};
function npm(command, options = []) {
  const started = performance.now();
  execFileSync("npm", ["run", command, ...options], { cwd, stdio: "inherit" });
  elapsed[command] = Math.round((performance.now() - started) / 1000);
}
let startedStack = false;
try {
  npm("setup", ["--", `--project=${values.project}`, `--port=${values.port}`, `--console-port=${values["console-port"]}`]);
  npm("doctor");
  if (!values.prepare) {
    startedStack = true;
    npm("local:up");
    npm("healthcheck");
    npm("test:integration");
  }
} finally {
  if (startedStack) npm("local:down");
}
const report = { archive: basename(archive), sha256: sidecar[1], project: values.project,
  host: { logicalCpus: cpus().length, memoryMiB: Math.round(totalmem() / 1024 / 1024) },
  durationSeconds: elapsed, preparedOnly: values.prepare };
if (values.report) writeFileSync(resolve(values.report), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify(report, null, 2));
console.log(`Rehearsal directory: ${directory}`);
