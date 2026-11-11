// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Applies the Junctura sign-in theme to a realm that already exists. The realm import in
// infra/keycloak/realm.json only initializes an empty realm, so a running stack needs this once
// after the theme directory is mounted (docker compose up -d identity). Development stacks only.
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const KEYS = ["displayName", "loginTheme", "internationalizationEnabled", "supportedLocales", "defaultLocale"];

/** The theme-related realm settings, taken from realm.json so the two never drift apart. */
export function loginThemeSettings(realmJson = readFileSync(fileURLToPath(new URL("../infra/keycloak/realm.json", import.meta.url)), "utf8")) {
  const realm = JSON.parse(realmJson);
  return Object.fromEntries(KEYS.map(key => [key, realm[key]]));
}

export async function applyLoginTheme({ base = process.env.PUBLIC_URL ?? "http://127.0.0.1:8080", password = process.env.KEYCLOAK_ADMIN_PASSWORD, fetchImpl = fetch } = {}) {
  if (!password) throw new Error("KEYCLOAK_ADMIN_PASSWORD missing: run from the repository root after npm run setup");
  const issued = await fetchImpl(`${base}/identity/realms/master/protocol/openid-connect/token`, { method: "POST",
    body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username: "junctura-admin", password }) });
  if (issued.status !== 200) throw new Error(`Keycloak operator login failed (${issued.status}); is the stack running?`);
  const { access_token: token } = await issued.json();
  const url = `${base}/identity/admin/realms/junctura`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const current = await fetchImpl(url, { headers });
  if (current.status !== 200) throw new Error(`Reading the realm failed (${current.status})`);
  const updated = await fetchImpl(url, { method: "PUT", headers, body: JSON.stringify({ ...(await current.json()), ...loginThemeSettings() }) });
  if (updated.status !== 204) throw new Error(`Updating the realm failed (${updated.status})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  applyLoginTheme().then(() => console.log("• Junctura sign-in theme applied to the junctura realm"), error => { console.error(error.message); process.exitCode = 1; });
}
