// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/bootstrap/config.mjs";

const env = { OIDC_ISSUER: "https://identity.invalid/realms/junctura",
  CORE_CLIENT_SECRET: "fixture", IDENTITY_URL: "https://identity.invalid/realms/junctura" };

test("a missing sync secret keeps Core serving with directory synchronization disabled", () => {
  const configured = loadConfig({ ...env, DIRECTORY_SYNC_CLIENT_ID: "junctura-directory-sync",
    DIRECTORY_SYNC_CLIENT_SECRET: "" }).config;
  assert.equal(configured.directorySyncClientId, undefined);
  assert.equal(configured.directorySyncSecret, undefined);
  const minimal = loadConfig(env).config;
  assert.equal(minimal.directorySyncClientId, undefined);
});

test("a configured secret enables the dedicated sync account", () => {
  const configured = loadConfig({ ...env, DIRECTORY_SYNC_CLIENT_ID: "junctura-directory-sync",
    DIRECTORY_SYNC_CLIENT_SECRET: "s".repeat(32) }).config;
  assert.equal(configured.directorySyncClientId, "junctura-directory-sync");
  assert.equal(configured.directorySyncSecret, "s".repeat(32));
});

test("a secret without its client id is a configuration error", () => {
  assert.throws(() => loadConfig({ ...env, DIRECTORY_SYNC_CLIENT_SECRET: "s".repeat(32) }),
    /Directory synchronization configuration is incomplete/);
});
