// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { assertRequiredReleaseFiles, releaseFiles } from "../scripts/package-release.mjs";
import { commandOnPath, preferPython3 } from "../scripts/lib/python.mjs";

test("source release allowlist excludes local/private roots and rejects secrets inside public roots", () => {
  assert.deepEqual(releaseFiles(["LICENSE", ".env", ".env.rc-test", ".codex/private.md", "local-data/data", "docs/GETTING_STARTED.md", ".env.example"]), [".env.example", "LICENSE", "docs/GETTING_STARTED.md"]);
  for (const path of ["console/.env.local", "infra/fixture.key", "console/node_modules/pkg/index.js", "console/dist/app.js", "docs/../private", "docs/private.dump", "integration/server.pem"]) assert.throws(() => releaseFiles([path]));
});

// The Core image runs unit tests without the Console and SDK sources; the version
// check runs wherever the whole repository is present (host checks and CI).
const versioned = ["package.json", "console/package.json", "console/package-lock.json", "sdk/node/package.json", "console/src/constants/brand.ts"];
const wholeRepository = versioned.every(path => existsSync(new URL(`../${path}`, import.meta.url)));

test("release packaging requires each app access migration", { skip: !wholeRepository }, () => {
  const files = ["LICENSE", "NOTICE", "THIRD-PARTY.md", "CHANGELOG.md", "REUSE.toml", "LICENSES/Apache-2.0.txt",
    "compose.yaml", ".env.example", "docs/GETTING_STARTED.md", "docs/RELEASE.md", "docs/DEVELOPING.md",
    ...readdirSync(new URL("../infra/postgres/", import.meta.url)).map(file => `infra/postgres/${file}`)];
  assertRequiredReleaseFiles(releaseFiles(files));
  for (const name of ["047-app-access.sql", "048-app-data-units.sql", "049-access-denial-reasons.sql", "050-app-access-compatibility.sql", "051-delegation.sql"]) {
    const path = `infra/postgres/${name}`;
    assert.throws(() => assertRequiredReleaseFiles(files.filter(file => file !== path)), {
      message: `Missing release file ${path}`,
    });
  }
});

test("Console, SDK and Console lockfile carry the platform version", { skip: !wholeRepository && "repository sources not present" }, () => {
  const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const version = JSON.parse(read("package.json")).version;
  assert.equal(JSON.parse(read("console/package.json")).version, version);
  assert.equal(JSON.parse(read("sdk/node/package.json")).version, version);
  const lock = JSON.parse(read("console/package-lock.json"));
  assert.deepEqual([lock.version, lock.packages[""].version], [version, version]);
  assert.match(read("console/src/constants/brand.ts"), new RegExp(`version: "${version.replaceAll(".", "\\.")}"`));
});

test("the rehearsal prefers python3 only when PYTHON is unset and python is missing", () => {
  const explicit = {};
  assert.equal(preferPython3(explicit, () => false), "python3");
  assert.equal(explicit.PYTHON, "python3");
  assert.equal(preferPython3({ PYTHON: "python3.13" }, () => false), "python3.13");
  const withPython = {};
  assert.equal(preferPython3(withPython, () => true), undefined);
  assert.equal("PYTHON" in withPython, false);
});

test("commandOnPath only finds executable files on the PATH", () => {
  const directory = mkdtempSync(join(tmpdir(), "jx-release-python-"));
  writeFileSync(join(directory, "python"), "#!/bin/sh\n");
  chmodSync(join(directory, "python"), 0o755);
  writeFileSync(join(directory, "notes"), "not executable");
  mkdirSync(join(directory, "python-dir"));
  const path = [directory, join(directory, "missing")].join(delimiter);
  assert.equal(commandOnPath("python", path), true);
  assert.equal(commandOnPath("notes", path), false);
  assert.equal(commandOnPath("python-dir", path), false);
  assert.equal(commandOnPath("python", ""), false);
  assert.equal(commandOnPath("python", null), false);
  rmSync(directory, { recursive: true, force: true });
});

test("the release rehearsal applies the python3 fallback before spawning children", () => {
  assert.match(readFileSync(new URL("../scripts/rehearse-release.mjs", import.meta.url), "utf8"), /preferPython3\(\)/);
});
