// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

test("every numbered migration is mounted into the data-migrate runner", () => {
  const compose = readFileSync(new URL("../compose.yaml", import.meta.url), "utf8");
  const migrations = readdirSync(new URL("../infra/postgres/", import.meta.url)).filter((name) => /^\d{3}-.+\.sql$/.test(name)).sort();
  assert.ok(migrations.length >= 27);
  for (const name of migrations) {
    assert.ok(compose.includes(`- ./infra/postgres/${name}:/migrations/${name}:ro`), `${name} is not mounted in compose.yaml`);
  }
});
