// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { handleSubjectAccessEvents, SUBJECT_ACCESS_EVENTS_PATH } from "../src/modules/subject-access/subject-access.mjs";

const identity = { tenantId: "tenant-a", subject: "login-sub", subjectId: "subject-1",
  issuer: "https://issuer.test", clientId: "client", roles: ["core-reader"] };
const config = { dataUrl: "http://data.test", dataSecret: "s".repeat(32) };

function requestStub(method, url, body) {
  return {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    async *iterator() { if (body !== undefined) yield Buffer.from(body); },
  };
}

function responseStub() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    writeHead(status, headers) {
      this.statusCode = status;
      for (const [name, value] of Object.entries(headers ?? {})) this.setHeader(name, value);
      return this;
    },
    end(body) { this.payload = body === undefined ? this.payload : JSON.parse(body); },
    statusCode: 0,
    payload: undefined,
  };
}

function handlerFetch(calls) {
  return async (url, init) => {
    calls.push({ url: new URL(url), init });
    return { ok: true, json: async () => calls.at(-1).result };
  };
}

async function call(fetcher, method, path, body, urlQuery = "") {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = fetcher(calls);
  try {
    const response = responseStub();
    const result = await handleSubjectAccessEvents(requestStub(method, path, body), response,
      identity, config, new URL(`${path}${urlQuery}`, "http://core"));
    return { calls, response, result };
  } finally {
    globalThis.fetch = original;
  }
}

test("list forwards limit and cursor to the database RPC", async () => {
  const calls = [];
  let payload;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    payload = JSON.parse(init.body);
    calls.push(url);
    return { ok: true, json: async () => ({ status: 200, value: {
      entries: [{ source: "application", accessId: "app:55555555-5555-4555-8555-555555555555",
        accessedAt: "2030-01-12T12:00:00.000Z", purpose: "service_review", flaggedAt: null,
        app: { appId: "22222222-2222-4222-8222-222222222222", displayName: null },
        action: "record.viewed", outcome: "success" }],
      truncated: false, generatedAt: "2030-01-12T12:00:00.000Z" } }) };
  };
  try {
    const response = responseStub();
    await handleSubjectAccessEvents(requestStub("GET", SUBJECT_ACCESS_EVENTS_PATH, undefined), response,
      identity, config, new URL("/v1/me/data-access?limit=25", "http://core"));
    assert.equal(payload.operation, "list");
    assert.deepEqual(payload.payload, { limit: 25 });
    assert.equal(response.payload.entries.length, 1);
    assert.equal(response.payload.nextCursor, null);
    assert.equal(response.payload.truncated, false);
    assert.equal(response.headers["cache-control"], "no-store");
  } finally {
    globalThis.fetch = original;
  }
});

test("a truncated page carries a cursor bound to the last entry and its caller", async () => {
  const original = globalThis.fetch;
  let requestPayload;
  const page = () => ({ ok: true, json: async () => ({ status: 200, value: {
    entries: [{ source: "application", accessId: "app:55555555-5555-4555-8555-555555555555",
      accessedAt: "2030-01-12T12:00:00.123456Z", purpose: "service_review", flaggedAt: null,
      app: { appId: "22222222-2222-4222-8222-222222222222", displayName: null },
      action: "record.viewed", outcome: "success" }],
    truncated: true, generatedAt: "2030-01-12T12:00:00.000Z" } }) });
  globalThis.fetch = async (url, init) => {
    requestPayload = JSON.parse(init.body);
    return page();
  };
  try {
    const response = responseStub();
    await handleSubjectAccessEvents(requestStub("GET", SUBJECT_ACCESS_EVENTS_PATH, undefined), response,
      identity, config, new URL("/v1/me/data-access", "http://core"));
    assert.ok(response.payload.nextCursor);
    const cursor = response.payload.nextCursor;
    // The cursor carries the caller binding; the database only receives the
    // page key.
    globalThis.fetch = async (url, init) => {
      requestPayload = JSON.parse(init.body);
      return { ok: true, json: async () => ({ status: 200, value: {
        entries: [], truncated: false, generatedAt: "2030-01-12T12:00:00.000Z" } }) };
    };
    await handleSubjectAccessEvents(requestStub("GET", SUBJECT_ACCESS_EVENTS_PATH, undefined), responseStub(), identity, config,
      new URL(`/v1/me/data-access?cursor=${cursor}`, "http://core"));
    assert.deepEqual(requestPayload.payload.after, {
      accessedAt: "2030-01-12T12:00:00.123456Z", accessId: "app:55555555-5555-4555-8555-555555555555" });
    // The same cursor under a foreign caller or subject fails closed.
    for (const other of [{ ...identity, subject: "login-other" }, { ...identity, subjectId: "subject-2" },
      { ...identity, tenantId: "tenant-b" }, { ...identity, issuer: "https://other.test" }]) {
      await assert.rejects(handleSubjectAccessEvents(
        requestStub("GET", SUBJECT_ACCESS_EVENTS_PATH, undefined), responseStub(), other, config,
        new URL(`/v1/me/data-access?cursor=${cursor}`, "http://core")), /invalid_cursor/);
    }
    await assert.rejects(handleSubjectAccessEvents(
      requestStub("GET", SUBJECT_ACCESS_EVENTS_PATH, undefined), responseStub(), identity, config,
      new URL("/v1/me/data-access?cursor=broken", "http://core")), /invalid_cursor/);
    // A modified page key is rejected by the signature before its claims.
    await assert.rejects(handleSubjectAccessEvents(
      requestStub("GET", SUBJECT_ACCESS_EVENTS_PATH, undefined), responseStub(), identity, config,
      new URL(`/v1/me/data-access?cursor=${cursor.slice(0, -4)}aaaa`, "http://core")),
      /invalid_cursor/);
  } finally {
    globalThis.fetch = original;
  }
});

test("flag accepts only a prefixed access id and a known reason", async () => {
  const original = globalThis.fetch;
  let requestPayload;
  globalThis.fetch = async (url, init) => {
    requestPayload = JSON.parse(init.body);
    return { ok: true, json: async () => ({ status: 201, value: {
      accessId: "app:55555555-5555-4555-8555-555555555555", flaggedAt: "2030-01-12T12:00:00.000Z" } }) };
  };
  try {
    const response = responseStub();
    await handleSubjectAccessEvents(
      requestStub("POST", "/v1/me/data-access/app:55555555-5555-4555-8555-555555555555/flag",
        JSON.stringify({ reason: "unrecognized" })),
      response, identity, config,
      new URL("/v1/me/data-access/app:55555555-5555-4555-8555-555555555555/flag", "http://core"));
    assert.equal(requestPayload.operation, "flag");
    assert.equal(requestPayload.payload.accessId, "app:55555555-5555-4555-8555-555555555555");
    assert.equal(response.statusCode, 201);
    for (const bad of ["55555555-5555-4555-8555-555555555555", "person:55555555-5555-4555-8555-555555555555"]) {
      await assert.rejects(handleSubjectAccessEvents(
        requestStub("POST", `/v1/me/data-access/${bad}/flag`, JSON.stringify({ reason: "other" })),
        responseStub(), identity, config, new URL(`/v1/me/data-access/${bad}/flag`, "http://core")),
        /invalid_request/);
    }
    await assert.rejects(handleSubjectAccessEvents(
      requestStub("POST", "/v1/me/data-access/app:55555555-5555-4555-8555-555555555555/flag",
        JSON.stringify({ reason: "urgent" })),
      responseStub(), identity, config,
      new URL("/v1/me/data-access/app:55555555-5555-4555-8555-555555555555/flag", "http://core")),
      /invalid_request/);
  } finally {
    globalThis.fetch = original;
  }
});

test("feedback validates the decision and optional message", async () => {
  const original = globalThis.fetch;
  let requestPayload;
  globalThis.fetch = async (url, init) => {
    requestPayload = JSON.parse(init.body);
    return { ok: true, json: async () => ({ status: 201, value: {
      executionId: "11111111-1111-4111-8111-111111111111", submittedAt: "2030-01-12T12:00:00.000Z" } }) };
  };
  try {
    const path = "/v1/me/emergency-accesses/11111111-1111-4111-8111-111111111111/feedback";
    const response = responseStub();
    await handleSubjectAccessEvents(requestStub("POST", path, JSON.stringify({ decision: "recognized" })),
      response, identity, config, new URL(path, "http://core"));
    assert.deepEqual(requestPayload.payload, { executionId: "11111111-1111-4111-8111-111111111111", decision: "recognized" });
    await handleSubjectAccessEvents(requestStub("POST", path,
      JSON.stringify({ decision: "other", message: "call again" })),
      responseStub(), identity, config, new URL(path, "http://core"));
    assert.equal(requestPayload.payload.message, "call again");
    await assert.rejects(handleSubjectAccessEvents(requestStub("POST", path,
      JSON.stringify({ decision: "maybe" })), responseStub(), identity, config, new URL(path, "http://core")),
      /invalid_request/);
    await assert.rejects(handleSubjectAccessEvents(requestStub("POST", path,
      JSON.stringify({ decision: "other", message: "" })), responseStub(), identity, config, new URL(path, "http://core")),
      /invalid_request/);
    await assert.rejects(handleSubjectAccessEvents(requestStub("POST", path,
      JSON.stringify({ decision: "other", note: "x" })), responseStub(), identity, config, new URL(path, "http://core")),
      /invalid_request/);
  } finally {
    globalThis.fetch = original;
  }
});

test("database errors surface with their contract codes", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ status: 404, error: "not_found" }) });
  try {
    await assert.rejects(handleSubjectAccessEvents(requestStub("GET", SUBJECT_ACCESS_EVENTS_PATH, undefined),
      responseStub(), identity, config, new URL(SUBJECT_ACCESS_EVENTS_PATH, "http://core")), /not_found/);
    globalThis.fetch = async () => ({ ok: false, status: 503 });
    await assert.rejects(handleSubjectAccessEvents(requestStub("GET", SUBJECT_ACCESS_EVENTS_PATH, undefined),
      responseStub(), identity, config, new URL(SUBJECT_ACCESS_EVENTS_PATH, "http://core")),
      /subject_access_unavailable/);
    globalThis.fetch = async () => { throw new Error("down"); };
    await assert.rejects(handleSubjectAccessEvents(requestStub("GET", SUBJECT_ACCESS_EVENTS_PATH, undefined),
      responseStub(), identity, config, new URL(SUBJECT_ACCESS_EVENTS_PATH, "http://core")),
      /subject_access_unavailable/);
  } finally {
    globalThis.fetch = original;
  }
});
