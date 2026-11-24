// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEnv } from "node:util";
import { parseArgs, renderEnv } from "../scripts/enroll-app.mjs";

test("app:enroll derives a client id and default https origin", () => {
  const options = parseArgs(["lichhop"]);
  assert.equal(options.clientId, "app-lichhop");
  assert.equal(options.tenant, "tenant-a");
  assert.equal(options.origin, "https://app-lichhop.junctura.local");
  assert.equal(options.displayName, "lichhop");
});

test("app:enroll accepts explicit tenant, origin and display name", () => {
  const options = parseArgs(["tai-chinh", "--tenant", "tenant-b", "--origin", "https://finance.example.org", "--display-name", "Tài chính"]);
  assert.deepEqual([options.tenant, options.origin, options.displayName], ["tenant-b", "https://finance.example.org", "Tài chính"]);
});

test("app:enroll rejects unsafe names, origins and options", () => {
  for (const argv of [[], ["Bad"], ["x"], ["a b"], ["ok", "--origin", "http://plain.example.org"], ["ok", "--origin", "https://10.0.0.1"],
    ["ok", "--origin", "https://x.example.org/path"], ["ok", "--bogus"], ["ok", "extra"], ["ok", "--tenant", "Bad_Tenant"]]) {
    assert.throws(() => parseArgs(argv), undefined, JSON.stringify(argv));
  }
  assert.equal(parseArgs(["--help"]).help, true);
});

test("app:enroll writes only the app's OpenBao bootstrap settings", () => {
  const url = "http://127.0.0.1:18200";
  const credentials = { JUNCTURA_OPENBAO_ROLE_ID: "synthetic-role", JUNCTURA_OPENBAO_SECRET_ID: "synthetic-secret" };
  assert.deepEqual(parseEnv(renderEnv(url, { ...credentials, JUNCTURA_APP_CLIENT_SECRET: "other-secret" })),
    { JUNCTURA_OPENBAO_URL: url, ...credentials });
  assert.throws(() => renderEnv(url, {}), /did not issue bootstrap credentials/);
});
