// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { applyLoginTheme, loginThemeSettings } from "../scripts/apply-login-theme.mjs";

const THEME = "infra/keycloak/themes/junctura/login";
const realm = JSON.parse(readFileSync("infra/keycloak/realm.json", "utf8"));

test("the realm uses the Junctura login theme and Vietnamese by default", () => {
  assert.equal(realm.loginTheme, "junctura");
  assert.equal(realm.internationalizationEnabled, true);
  assert.deepEqual(realm.supportedLocales, ["vi", "en"]);
  assert.equal(realm.defaultLocale, "vi");
});

test("the theme extends Keycloak's own templates and ships its stylesheet and messages", () => {
  const properties = readFileSync(`${THEME}/theme.properties`, "utf8");
  assert.match(properties, /^parent=keycloak\.v2$/m);
  assert.match(properties, /^styles=.*css\/junctura\.css/m);
  for (const file of ["resources/css/junctura.css", "messages/messages_vi.properties", "messages/messages_en.properties"]) assert.ok(existsSync(`${THEME}/${file}`), file);
});

test("the stylesheet defines light and dark colours and the Junctura mark", () => {
  const css = readFileSync(`${THEME}/resources/css/junctura.css`, "utf8");
  assert.match(css, /\.pf-v5-theme-dark\s*{/);
  assert.match(css, /--jh-brand: #176B80/);
  assert.match(css, /#kc-header-wrapper::before/);
});

test("compose mounts the theme directory read-only into Keycloak", () => {
  assert.match(readFileSync("compose.yaml", "utf8"), /\.\/infra\/keycloak\/themes\/junctura:\/opt\/keycloak\/themes\/junctura:ro/);
});

test("loginThemeSettings reads the theme settings from realm.json", () => {
  assert.deepEqual(loginThemeSettings(), { displayName: "Junctura", loginTheme: "junctura", internationalizationEnabled: true, supportedLocales: ["vi", "en"], defaultLocale: "vi" });
});

test("applyLoginTheme merges the settings into the existing realm", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body });
    if (String(url).includes("/realms/master/")) return new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
    if (init.method === "PUT") return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ realm: "junctura", loginTheme: "keycloak", accessTokenLifespan: 300 }), { status: 200 });
  };
  await applyLoginTheme({ base: "http://kc.test", password: "x", fetchImpl });
  const put = calls.find(call => call.method === "PUT");
  assert.equal(put.url, "http://kc.test/identity/admin/realms/junctura");
  const sent = JSON.parse(put.body);
  assert.equal(sent.loginTheme, "junctura");
  assert.equal(sent.accessTokenLifespan, 300, "existing settings are kept");
});

test("applyLoginTheme explains a missing operator password", async () => {
  await assert.rejects(applyLoginTheme({ password: "" }), /KEYCLOAK_ADMIN_PASSWORD missing/);
});
