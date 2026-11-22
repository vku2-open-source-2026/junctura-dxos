// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { HttpError, uuidPattern } from "../../../platform/http/http.mjs";

export const MAX_AGGREGATE_GROUPS = 1000;
export const MAX_GROUP_BY_FIELDS = 2;

const fieldPattern = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const kinds = new Set(["string", "number", "integer", "boolean", "date", "date-time"]);
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const dateTimePattern = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const whereKeyPattern = /^where\[([^\]]+)\]$/;
const sortPattern = /^([A-Za-z_][A-Za-z0-9_]{0,63})\.(asc|desc)$/;
const cursorPattern = /^[A-Za-z0-9_-]+$/;

const invalidQuery = () => new HttpError(400, "invalid_query");
const invalidCursor = () => new HttpError(400, "invalid_cursor");

function fieldSet(value, name) {
  if (value === undefined || value === null) return null;
  if (value instanceof Set) {
    if (![...value].every(field => typeof field === "string" && fieldPattern.test(field))) throw new TypeError(`${name} must contain record fields`);
    return value;
  }
  if (Array.isArray(value) && value.every(field => typeof field === "string" && fieldPattern.test(field))) return new Set(value);
  throw new TypeError(`${name} must be a set of record fields`);
}

function typeMap(value) {
  if (value === undefined || value === null) return null;
  const entries = value instanceof Map ? [...value] : !Array.isArray(value) && typeof value === "object" ? Object.entries(value) : null;
  if (!entries || !entries.every(([field, kind]) => fieldPattern.test(field) && kinds.has(kind))) {
    throw new TypeError("types must map record fields to scalar kinds");
  }
  return new Map(entries);
}

function parseOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new TypeError("query options must be an object");
  return {
    indexed: fieldSet(options.indexed, "indexed"),
    sensitive: fieldSet(options.sensitive, "sensitive"),
    types: typeMap(options.types),
    management: options.management === true,
  };
}

function assertField(field, options) {
  if (!fieldPattern.test(field)) throw invalidQuery();
  if (options.indexed && !options.indexed.has(field)) throw invalidQuery();
  if (options.types && !options.types.has(field)) throw invalidQuery();
  if (options.management && options.sensitive?.has(field)) throw invalidQuery();
}

function assertOperandType(operation, value, kind) {
  if (!kind) return;
  if (operation === "prefix" && kind !== "string") throw invalidQuery();
  if ((operation === "gte" || operation === "lte") && !["number", "integer", "string", "date", "date-time"].includes(kind)) throw invalidQuery();
  for (const item of operation === "in" ? value : [value]) {
    if (item === null) continue;
    if (kind === "boolean" && typeof item !== "boolean") throw invalidQuery();
    else if (kind === "number" && typeof item !== "number") throw invalidQuery();
    else if (kind === "integer" && !Number.isInteger(item)) throw invalidQuery();
    else if (kind === "string" && typeof item !== "string") throw invalidQuery();
    else if (kind === "date") {
      if (typeof item !== "string" || !datePattern.test(item)) throw invalidQuery();
      try { utcDay(item); }
      catch { throw invalidQuery(); }
    } else if (kind === "date-time") {
      const match = typeof item === "string" ? dateTimePattern.exec(item) : null;
      if (!match) throw invalidQuery();
      try { utcDay(match[1]); }
      catch { throw invalidQuery(); }
    }
  }
}

// Mirrors the write parser rule: a JSON number must survive HTTP parsing
// without losing decimal precision.
function decimalValue(source) {
  const [mantissa, exponent = "0"] = source.toLowerCase().split("e");
  const sign = mantissa.startsWith("-") ? "-" : "";
  const [whole, fraction = ""] = mantissa.replace("-", "").split(".");
  const digits = (whole + fraction).replace(/^0+/, "");
  if (!digits) return "0";
  const significant = digits.replace(/0+$/, "");
  return sign + significant + "e" + (Number(exponent) - fraction.length + digits.length - significant.length);
}

function parseJson(source) {
  try {
    return JSON.parse(source, (key, item, context) => {
      if (typeof item === "number" && (!Number.isFinite(item) ||
          (context.source !== undefined && decimalValue(context.source) !== decimalValue(String(item))))) {
        throw new SyntaxError("invalid_number");
      }
      return item;
    });
  } catch { throw invalidQuery(); }
}

function assertScalar(value) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (!value.isWellFormed() || value.includes("\0")) throw invalidQuery();
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 2 ** 53) return value;
  throw invalidQuery();
}

function parseOperand(op, source) {
  const value = parseJson(source);
  if (op === "eq") return assertScalar(value);
  if (op === "in") {
    if (!Array.isArray(value) || value.length === 0) throw invalidQuery();
    return value.map(assertScalar);
  }
  if (op === "gte" || op === "lte") {
    if (typeof value !== "string" && typeof value !== "number") throw invalidQuery();
    return assertScalar(value);
  }
  if (typeof value !== "string") throw invalidQuery();
  return assertScalar(value);
}

function parseCondition(field, source, options) {
  assertField(field, options);
  const match = /^(eq|in|gte|lte|prefix):(.+)$/.exec(source);
  if (!match) throw invalidQuery();
  const value = parseOperand(match[1], match[2]);
  assertOperandType(match[1], value, options.types?.get(field));
  return { field, op: match[1], value };
}

function collectWhere(searchParams, options, seenFields) {
  const conditions = [];
  for (const [key, value] of searchParams) {
    const match = whereKeyPattern.exec(key);
    if (!match) continue;
    const field = match[1];
    if (seenFields.has(field)) throw invalidQuery();
    seenFields.add(field);
    conditions.push(parseCondition(field, value, options));
  }
  return conditions;
}

function parseSort(source, options) {
  const match = sortPattern.exec(source);
  if (!match) throw invalidQuery();
  assertField(match[1], options);
  return { field: match[1], direction: match[2] };
}

function parseOwnerAppId(source) {
  if (source === null) return null;
  if (!uuidPattern.test(source)) throw invalidQuery();
  return source;
}

function parseCursor(source) {
  if (source === null) return null;
  if (source.length < 1 || source.length > 512 || !cursorPattern.test(source)) throw invalidCursor();
  return source;
}

function assertKnownKeys(searchParams, allowed, repeated) {
  const keys = [...searchParams.keys()];
  if (keys.some(key => !allowed.has(key) && !whereKeyPattern.test(key))) throw invalidQuery();
  const counts = new Map();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const [key, count] of counts) {
    if (count > 1 && !repeated.has(key)) throw invalidQuery();
  }
}

export function parseListQuery(searchParams, options = {}) {
  if (!(searchParams instanceof URLSearchParams)) throw new TypeError("searchParams must be URLSearchParams");
  const settings = parseOptions(options);
  assertKnownKeys(searchParams, new Set(["limit", "order", "cursor", "sort", "ownerAppId"]), new Set());

  const rawLimit = searchParams.get("limit") ?? "100";
  if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 100) throw invalidQuery();
  const limit = Number(rawLimit);

  const rawOrder = searchParams.get("order");
  if (rawOrder !== null && !["asc", "desc"].includes(rawOrder)) throw invalidQuery();
  const rawSort = searchParams.get("sort");
  if (rawSort !== null && rawOrder !== null) throw invalidQuery();

  return {
    limit,
    order: rawOrder ?? "asc",
    sort: rawSort === null ? null : parseSort(rawSort, settings),
    where: collectWhere(searchParams, settings, new Set()),
    ownerAppId: parseOwnerAppId(searchParams.get("ownerAppId")),
    cursor: parseCursor(searchParams.get("cursor")),
  };
}

export function parseAggregateQuery(searchParams, options = {}) {
  if (!(searchParams instanceof URLSearchParams)) throw new TypeError("searchParams must be URLSearchParams");
  const settings = parseOptions(options);
  assertKnownKeys(searchParams, new Set(["count", "groupBy", "ownerAppId"]), new Set(["groupBy"]));

  const counts = searchParams.getAll("count");
  if (counts.length !== 1 || !["", "true"].includes(counts[0])) throw invalidQuery();
  if (searchParams.getAll("ownerAppId").length > 1) throw invalidQuery();

  const groupBy = [];
  const seen = new Set();
  for (const source of searchParams.getAll("groupBy")) {
    const dayMatch = /^day\(([A-Za-z_][A-Za-z0-9_]{0,63})\)$/.exec(source);
    const field = dayMatch ? dayMatch[1] : source;
    if (!fieldPattern.test(field)) throw invalidQuery();
    if (seen.has(source)) throw invalidQuery();
    seen.add(source);
    assertField(field, settings);
    if (dayMatch && settings.types && !["date", "date-time"].includes(settings.types.get(field))) throw invalidQuery();
    groupBy.push({ field, day: Boolean(dayMatch) });
    if (groupBy.length > MAX_GROUP_BY_FIELDS) throw invalidQuery();
  }

  return {
    count: true,
    groupBy,
    where: collectWhere(searchParams, settings, new Set()),
    ownerAppId: parseOwnerAppId(searchParams.get("ownerAppId")),
  };
}

export function canonicalWhere(where) {
  if (!Array.isArray(where)) throw new TypeError("where must be an array");
  return where.map(condition => ({
    field: condition.field,
    op: condition.op,
    value: Array.isArray(condition.value) ? [...condition.value] : condition.value,
  })).sort((left, right) => left.field < right.field ? -1 : left.field > right.field ? 1 : 0);
}

export function ensureAggregateGroupLimit(count) {
  if (!Number.isInteger(count) || count < 0) throw new TypeError("group count must be a non-negative integer");
  if (count > MAX_AGGREGATE_GROUPS) throw new HttpError(400, "invalid_query");
  return count;
}

export function utcDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) {
    throw new TypeError("invalid date value");
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new TypeError("invalid date value");
  if (/^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new TypeError("invalid date value");
  }
  return new Date(timestamp).toISOString().slice(0, 10);
}
