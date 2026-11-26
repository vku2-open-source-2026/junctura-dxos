// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { promisify } from "node:util";

const docker = promisify(execFile);
const base = process.env.PUBLIC_URL ?? "http://127.0.0.1:8080";

async function ready() {
  try { return (await fetch(`${base}/ready`, { signal: AbortSignal.timeout(3000) })).ok; }
  catch { return false; }
}

test("Core restarts after its process exits and the gateway becomes ready", { timeout: 65000 }, async () => {
  assert.ok(process.env.CI === "true" || /^jx-/.test(process.env.COMPOSE_PROJECT_NAME ?? ""), "use CI or an isolated dev stack");
  const command = async (...args) => (await docker("docker", args, { timeout: 10000 })).stdout.trim();
  const id = await command("compose", "ps", "-q", "core");
  assert.match(id, /^[0-9a-f]{64}$/);
  const state = () => command("inspect", "--format", "{{.RestartCount}} {{.State.StartedAt}}", id);
  const initial = await state();
  const [restarts, started] = initial.split(" ");
  // Docker needs a process that has been up at least ten seconds before its
  // restart policy can provide evidence for this test.
  await delay(Math.max(0, Date.parse(started) + 11000 - Date.now()));
  assert.equal(await state(), initial);
  assert.equal(await ready(), true);
  await command("compose", "exec", "-T", "core", "node", "-e", "process.kill(1, 'SIGTERM')");
  const deadline = Date.now() + 45000;
  do {
    const [count, after] = (await state()).split(" ");
    if (Number(count) > Number(restarts) && after !== started && await ready()) return;
    await delay(500);
  } while (Date.now() < deadline);
  assert.fail("Core did not restart and recover readiness within 45 seconds");
});
