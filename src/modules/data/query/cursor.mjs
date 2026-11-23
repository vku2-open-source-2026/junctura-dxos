// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { HttpError, uuidPattern } from "../../../platform/http/http.mjs";

const fieldPattern = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const sortPattern = /^(?:system\.created_at|data\.[A-Za-z_][A-Za-z0-9_]{0,63})\.(asc|desc)$/;
const cursorPattern = /^[A-Za-z0-9_-]+$/;
const digestPattern = /^[A-Za-z0-9_-]{43}$/;
const signaturePattern = /^[A-Za-z0-9_-]{43}$/;
const operators = new Set(["eq", "in", "gte", "lte", "prefix"]);

const invalidCursor = () => new HttpError(400, "invalid_cursor");

function scalar(value) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string" && value.isWellFormed() && !value.includes("\0")) return value;
  if (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 2 ** 53) return value;
  throw new TypeError("cursor values must be JSON scalars");
}

function normaliseWhere(where) {
  if (!Array.isArray(where)) throw new TypeError("where must be an array");
  const seen = new Set();
  const conditions = where.map(condition => {
    if (!condition || typeof condition !== "object" || Array.isArray(condition)) throw new TypeError("invalid filter");
    const { field, op, value } = condition;
    if (!fieldPattern.test(field) || !operators.has(op) || seen.has(field)) throw new TypeError("invalid filter");
    seen.add(field);
    if (op === "in") {
      if (!Array.isArray(value) || value.length === 0) throw new TypeError("invalid filter");
      return [field, op, value.map(scalar)];
    }
    return [field, op, scalar(value)];
  });
  return conditions.sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
}

function filterDigest(where) {
  return createHash("sha256").update(JSON.stringify(normaliseWhere(where))).digest("base64url");
}

function normaliseKey(key) {
  if (!Array.isArray(key) || key.length !== 1) throw new TypeError("a cursor carries one sort value");
  return key.map(scalar);
}

function bindingPrefix({ ownerAppId, where, sort, schemaRevision }) {
  if (typeof ownerAppId !== "string" || !uuidPattern.test(ownerAppId)) throw new TypeError("ownerAppId must be a UUID");
  if (typeof sort !== "string" || !sortPattern.test(sort)) throw new TypeError("sort must be field.asc or field.desc");
  if (!Number.isSafeInteger(schemaRevision) || schemaRevision < 0) throw new TypeError("schemaRevision must be a non-negative integer");
  return { v: 1, o: ownerAppId, f: filterDigest(where), s: sort, r: schemaRevision };
}

function assertCommon(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw invalidCursor();
  if (payload.v !== 1 || typeof payload.o !== "string" || !uuidPattern.test(payload.o) ||
      typeof payload.f !== "string" || !digestPattern.test(payload.f) ||
      typeof payload.s !== "string" || !sortPattern.test(payload.s) ||
      !Number.isSafeInteger(payload.r) || payload.r < 0) throw invalidCursor();
}

function assertListPayload(payload) {
  assertCommon(payload);
  if (Object.keys(payload).length !== 7 || !["v", "o", "f", "s", "r", "k", "i"].every(key => Object.hasOwn(payload, key)) ||
      typeof payload.i !== "string" || !uuidPattern.test(payload.i)) throw invalidCursor();
  normaliseKey(payload.k);
}

function assertStatePayload(payload) {
  assertCommon(payload);
  if (Object.keys(payload).length !== 6 || !["v", "o", "f", "s", "r", "c"].every(key => Object.hasOwn(payload, key)) ||
      typeof payload.c !== "string" || !uuidPattern.test(payload.c)) throw invalidCursor();
}

export function createQueryCursor(secret) {
  const key = Buffer.isBuffer(secret) ? Buffer.from(secret) : typeof secret === "string" ? Buffer.from(secret) : null;
  if (!key || key.length < 16) throw new TypeError("cursor secret must be at least 16 bytes");
  const sign = payload => createHmac("sha256", key).update(JSON.stringify(payload)).digest("base64url");

  function seal(payload) {
    const encoded = Buffer.from(JSON.stringify({ p: payload, h: sign(payload) })).toString("base64url");
    if (encoded.length > 512) throw new RangeError("cursor exceeds the public length limit");
    return encoded;
  }

  function open(value) {
    try {
      if (typeof value !== "string" || value.length < 1 || value.length > 512 || !cursorPattern.test(value)) throw invalidCursor();
      const bytes = Buffer.from(value, "base64url");
      if (bytes.toString("base64url") !== value) throw invalidCursor();
      const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const envelope = JSON.parse(source);
      if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw invalidCursor();
      if (Object.keys(envelope).length !== 2 || !Object.hasOwn(envelope, "p") || !Object.hasOwn(envelope, "h")) throw invalidCursor();
      if (typeof envelope.h !== "string" || !signaturePattern.test(envelope.h)) throw invalidCursor();
      const actual = Buffer.from(envelope.h, "base64url");
      const wanted = Buffer.from(sign(envelope.p), "base64url");
      if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) throw invalidCursor();
      return envelope.p;
    } catch (error) {
      if (error instanceof HttpError && error.status === 400) throw error;
      throw invalidCursor();
    }
  }

  function expect(expected) {
    if (!expected || typeof expected !== "object" || Array.isArray(expected)) throw new TypeError("cursor binding is required");
    return expected;
  }

  return Object.freeze({
    encode(binding) {
      const { key: sortKey, id } = binding;
      if (typeof id !== "string" || !uuidPattern.test(id)) throw new TypeError("id must be a UUID");
      return seal({ ...bindingPrefix(binding), k: normaliseKey(sortKey), i: id });
    },
    decode(value, expected) {
      try {
        const payload = open(value);
        assertListPayload(payload);
        const wanted = expect(expected);
        if (payload.o !== wanted.ownerAppId || payload.s !== wanted.sort ||
            payload.r !== wanted.schemaRevision || payload.f !== filterDigest(wanted.where)) throw invalidCursor();
        return { key: payload.k, id: payload.i };
      } catch (error) {
        if (error instanceof HttpError && error.status === 400) throw error;
        throw invalidCursor();
      }
    },
    encodeState(binding, stateId) {
      if (typeof stateId !== "string" || !uuidPattern.test(stateId)) throw new TypeError("stateId must be a UUID");
      return seal({ ...bindingPrefix(binding), c: stateId });
    },
    decodeState(value, expected) {
      try {
        const payload = open(value);
        assertStatePayload(payload);
        const wanted = expect(expected);
        if (payload.o !== wanted.ownerAppId || payload.s !== wanted.sort ||
            payload.r !== wanted.schemaRevision || payload.f !== filterDigest(wanted.where)) throw invalidCursor();
        return { stateId: payload.c };
      } catch (error) {
        if (error instanceof HttpError && error.status === 400) throw error;
        throw invalidCursor();
      }
    },
  });
}
