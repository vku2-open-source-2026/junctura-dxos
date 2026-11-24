// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process";
import { parseEnv, promisify } from "node:util";

async function compose(...args) {
  try {
    return (await promisify(execFile)("docker", [
      "compose", "-f", "compose.yaml", "-f", "infra/openbao/compose.bootstrap.yaml", ...args,
    ], { timeout: 60_000 })).stdout.trim();
  } catch {
    throw new Error("OpenBao operator command failed. Check the local bootstrap Compose configuration and the application bundle.");
  }
}

export async function localOpenBaoUrl() {
  const endpoint = await compose("port", "secrets", "8200");
  if (!/^127\.0\.0\.1:\d+$/.test(endpoint)) throw new Error("OpenBao bootstrap requires an opt-in loopback port");
  return `http://${endpoint}`;
}

export async function localAppRole(action, tenant, appId) {
  const output = await compose("run", "--rm", "--no-deps", "-T", "--entrypoint", "/bin/sh", "secrets-init",
    "/scripts/provision-app-bootstrap.sh", action, tenant, appId);
  return parseEnv(output);
}
