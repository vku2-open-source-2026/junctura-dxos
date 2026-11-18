// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { step } from "./lib/demo-stack.mjs";

export function planSteps({ envExists }) {
  return [...(envExists ? [] : ["setup"]), "local:up", "env:provision", "demo:seed", "demo:console"];
}

function runStep(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", script], { stdio: "inherit" });
    child.once("error", () => reject(new Error(`Could not start npm run ${script}`)));
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`npm run ${script} failed (${signal ?? code})`)));
  });
}

export function consoleUrlFor(address) {
  if (typeof address !== "string" || !/^(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/.test(address)) {
    throw new Error("Cannot resolve Console URL");
  }
  return new URL(`http://${address}`).origin;
}

function consoleUrl() {
  // Resolve the actual published port without opening the private .env file.
  const address = execFileSync("docker", ["compose", "--profile", "console", "port", "console", "3000"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000,
  }).trim();
  return consoleUrlFor(address);
}

export async function main({ exists = existsSync, run = runStep, locateConsole = consoleUrl, log = step } = {}) {
  for (const script of planSteps({ envExists: exists(".env") })) {
    log(`npm run ${script}`);
    await run(script);
  }
  log(`Console: ${locateConsole()}`);
  log("The read-only demo account is pre-filled on the login page. All demo content is simulated.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(/^npm run [a-z:]+ failed \([A-Z0-9]+\)$|^Could not start npm run [a-z:]+$/.test(error.message)
      ? error.message : "Local demo failed; check stack readiness and the Console port mapping");
    process.exitCode = 1;
  });
}
