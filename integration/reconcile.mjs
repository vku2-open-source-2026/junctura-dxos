// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { operator } from "../scripts/provision-directory.mjs";

const run = mode => spawnSync(process.execPath, ["--env-file-if-exists=.env", "scripts/reconcile.mjs", mode],
  { encoding: "utf8", timeout: 90000 });
const base = process.env.ADMIN_BASE ?? `http://127.0.0.1:${process.env.PORT ?? "8080"}`;

test("managed configuration check is read-only and apply repairs a missing mapper and a changed policy once", { timeout: 180000 }, async () => {
  assert.ok(process.env.CI === "true" || /^jx-/.test(process.env.COMPOSE_PROJECT_NAME ?? ""), "use CI or an isolated dev stack");
  const admin = await operator(base, process.env.KEYCLOAK_ADMIN_PASSWORD);
  const json = async path => {
    const response = await admin(path);
    assert.equal(response.status, 200);
    return response.json();
  };
  const [consoleClient] = await json("clients?clientId=junctura-console");
  assert.ok(consoleClient?.id);
  const path = `clients/${consoleClient.id}/protocol-mappers/models`;
  const mappers = await json(path);
  const missing = mappers.find(mapper => mapper.name === "org-groups");
  assert.ok(missing?.id);
  const { id, ...original } = missing;
  const bao = command => {
    const script = `BAO_TOKEN="$(awk -F'"' '/"root_token"/{print $4; exit}' "$OPERATOR_DIR/init.json")";
      export BAO_TOKEN; test -n "$BAO_TOKEN";\n${command}`;
    const result = spawnSync("docker", ["compose", "run", "--rm", "-T", "--no-deps", "--entrypoint", "/bin/sh", "secrets-init", "-ec", script],
      { encoding: "utf8", timeout: 45000 });
    assert.equal(result.status, 0, "OpenBao test operator command");
    return result.stdout.trim();
  };
  assert.equal(run("--check").status, 0, "baseline configuration");
  const policyBefore = bao("bao policy read junctura-core");
  try {
    assert.equal((await admin(`${path}/${id}`, undefined, "DELETE")).status, 204);
    bao(`printf 'path "secret/data/reconcile-fixture" { capabilities = ["read"] }\\n' | bao policy write junctura-core - >/dev/null`);
    const check = run("--check");
    assert.equal(check.status, 1, check.stdout);
    assert.match(check.stdout, /Keycloak mapper org-groups missing/);
    assert.match(check.stdout, /OpenBao junctura-core policy differs/);
    assert.ok(!(await json(path)).some(mapper => mapper.name === "org-groups"));
    assert.notEqual(bao("bao policy read junctura-core"), policyBefore);

    const apply = run("--apply");
    assert.equal(apply.status, 0, apply.stdout + apply.stderr);
    assert.match(apply.stdout, /Reconciled Keycloak mapper org-groups missing/);
    assert.match(apply.stdout, /Reconciled OpenBao junctura-core policy differs/);
    assert.equal(bao("bao policy read junctura-core"), policyBefore);
    const after = await json(path);
    assert.deepEqual(after.filter(mapper => mapper.name !== "org-groups"), mappers.filter(mapper => mapper.name !== "org-groups"));
    const repeat = run("--apply");
    assert.equal(repeat.status, 0, repeat.stdout + repeat.stderr);
    assert.doesNotMatch(repeat.stdout, /Reconciled/);
    assert.equal(run("--check").status, 0);
  } finally {
    if (!(await json(path)).some(mapper => mapper.name === "org-groups")) {
      assert.equal((await admin(path, original, "POST")).status, 201);
    }
    bao("bao policy write junctura-core /policy/junctura-core.hcl >/dev/null");
  }
});
