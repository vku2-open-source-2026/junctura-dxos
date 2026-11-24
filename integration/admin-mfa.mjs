// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { createAuthorityFixture } from "./fixtures/authority.mjs";
import { base, issuer } from "./record-test-support.mjs";

const prefix = `mfa-test-${randomBytes(6).toString("hex")}`;
const users = [];
const { operatorToken, admin, createUser } = createAuthorityFixture({ base, prefix, users });
const clientId = "junctura-console";
const oidc = `${issuer}/protocol/openid-connect`;
const consoleRedirect = "http://127.0.0.1:3000/";
let clientPath;

before(async () => {
  await operatorToken();
  const response = await admin(`clients?clientId=${clientId}`);
  assert.equal(response.status, 200);
  const client = (await response.json()).find(client => client.clientId === clientId);
  assert.ok(client);
  clientPath = `clients/${client.id}`;
});

after(async () => {
  const results = await Promise.all(users.map(id => admin(`users/${id}`, undefined, "DELETE")));
  assert.ok(results.every(response => response.status === 204), "delete MFA fixture users");
});

async function account(label, roleName, enrolled = false) {
  const secret = enrolled ? randomBytes(20).toString("base64url") : undefined;
  const credentials = secret ? [{ type: "otp", userLabel: "Fixture authenticator",
    secretData: JSON.stringify({ value: secret }),
    credentialData: JSON.stringify({ subType: "totp", digits: 6, period: 30, algorithm: "HmacSHA1", counter: 0 }),
  }] : [];
  const user = await createUser(label, { credentials });
  const role = await admin(`${clientPath}/roles/${roleName}`);
  assert.equal(role.status, 200);
  assert.equal((await admin(`users/${user.id}/role-mappings/${clientPath}`, [await role.json()], "POST")).status, 204);
  return { ...user, secret };
}

function totp(secret) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", secret).update(counter).digest();
  const offset = digest.at(-1) & 0xf;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}

function token(params) {
  return fetch(`${oidc}/token`, { method: "POST", body: new URLSearchParams(params), signal: AbortSignal.timeout(10_000) });
}

function direct({ username, password }, otp) {
  return token({ grant_type: "password", client_id: clientId, username, password, ...(otp ? { otp } : {}) });
}

async function assertToken(response) {
  assert.equal(response.status, 200);
  assert.ok((await response.json()).access_token);
}

function browser() {
  const cookies = new Map();
  async function request(url, fields) {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000),
      headers: { Cookie: [...cookies.values()].join("; ") },
      ...(fields ? { method: "POST", body: new URLSearchParams(fields) } : {}),
    });
    for (const value of response.headers.getSetCookie()) cookies.set(value.split("=", 1)[0], value.split(";", 1)[0]);
    return response;
  }
  async function submit(page, fields) {
    assert.equal(page.status, 200);
    const action = (await page.text()).match(/<form[^>]*action="([^"]+)"/);
    assert.ok(action, "Keycloak sign-in form");
    return request(new URL(action[1].replaceAll("&amp;", "&"), page.url), fields);
  }
  async function start(client = clientId, redirectUri = consoleRedirect) {
    const verifier = randomBytes(32).toString("base64url");
    const query = new URLSearchParams({ client_id: client, response_type: "code", scope: "openid",
      redirect_uri: redirectUri, code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url") });
    const page = await request(`${oidc}/auth?${query}`);
    return { page, async finish(response) {
      assert.equal(response.status, 302);
      const callback = new URL(response.headers.get("location"));
      assert.equal(callback.origin + callback.pathname, redirectUri);
      const code = callback.searchParams.get("code");
      assert.ok(code, "authorization code returned after authentication");
      await assertToken(await token({ grant_type: "authorization_code", client_id: client, redirect_uri: redirectUri,
        code, code_verifier: verifier }));
    } };
  }
  return { start, submit };
}

test("Console direct grant enforces administrator TOTP and preserves optional OTP for viewers", { timeout: 60_000 }, async () => {
  const unenrolled = await account("direct-unenrolled", "console-admin");
  const enrolled = await account("direct-enrolled", "console-admin", true);
  const viewer = await account("viewer", "console-viewer");
  const enrolledViewer = await account("direct-enrolled-viewer", "console-viewer", true);
  assert.equal((await direct(unenrolled)).status, 401, "admin without an authenticator must enroll through SSO");
  for (const otp of [undefined, "invalid"]) {
    const response = await direct(enrolled, otp);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "invalid_grant");
  }
  await assertToken(await direct(enrolled, totp(enrolled.secret)));
  await assertToken(await direct(viewer));
  assert.equal((await direct(enrolledViewer)).status, 400);
  await assertToken(await direct(enrolledViewer, totp(enrolledViewer.secret)));
});

test("Console browser sign-in requires administrator enrollment even with an existing SSO session", { timeout: 60_000 }, async () => {
  const user = await account("browser-unenrolled", "console-admin");
  const session = browser();
  const login = page => session.submit(page, { username: user.username, password: user.password });
  const local = await session.start("junctura-local", "http://127.0.0.1:9876/callback");
  await local.finish(await login(local.page));
  const requireEnrollment = response => {
    assert.equal(response.status, 302);
    assert.equal(new URL(response.headers.get("location"), response.url).searchParams.get("execution"), "CONFIGURE_TOTP");
  };
  requireEnrollment((await session.start()).page);

  const fresh = browser();
  const { page } = await fresh.start();
  requireEnrollment(await fresh.submit(page, { username: user.username, password: user.password }));
});

test("Console browser sign-in validates TOTP when required or already configured", { timeout: 60_000 }, async () => {
  for (const [role, enrolled] of [["console-admin", true], ["console-viewer", true], ["console-viewer", false]]) {
    const user = await account(`browser-${role}-${enrolled}`, role, enrolled);
    const session = browser();
    const { page, finish } = await session.start();
    const signed = await session.submit(page, { username: user.username, password: user.password });
    if (!enrolled) {
      await finish(signed);
      continue;
    }
    assert.equal(signed.status, 200);
    assert.match(await signed.clone().text(), /name="otp"/);
    await finish(await session.submit(signed, { otp: totp(user.secret) }));
  }
});
