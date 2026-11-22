// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { canonicalJson, HttpError, jsonObject } from "../../../platform/http/http.mjs";

export const collectionPattern = /^[a-z][a-z0-9_-]{0,62}$/;
export const fieldPattern = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const uniqueKeyPattern = /^[A-Za-z0-9_-]{1,128}$/;

const types = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const indexTypes = new Set(["string", "number", "integer", "boolean"]);
const schemaKeys = new Set(["type", "required", "properties", "enum", "minLength", "maxLength", "pattern",
  "minimum", "maximum", "items", "format"]);
const policyKeys = new Set(["schema", "indexed", "uniqueKey", "searchable", "sensitive", "auditActions"]);

// Only concatenated atoms with optional quantifiers. PostgreSQL checks class ranges and repetition bounds.
const safePattern = /^(?:\^)?(?:(?:[ A-Za-z0-9_\-/,:@#%&=!'";<>]|\.|\[[A-Za-z0-9 _\-./^]+\]|\\[.\\^$`*+?()[\]{}|])(?:[?*+]|\{\d{1,3}(?:,\d{0,3})?\})?)+(?:\$)?$/u;

function invalidSchema() { throw new HttpError(400, "invalid_schema"); }

function uniqueStrings(values, validate) {
  return Array.isArray(values) && values.every(value => typeof value === "string" && validate(value)) &&
    new Set(values).size === values.length;
}

function validateNode(node, depth) {
  if (depth > 8 || !jsonObject(node) || Object.keys(node).some(key => !schemaKeys.has(key))) invalidSchema();
  const has = key => Object.hasOwn(node, key);
  if (has("type") && !types.has(node.type)) invalidSchema();
  if (has("required") && !uniqueStrings(node.required, name => name.length > 0)) invalidSchema();
  if (has("enum") && (!Array.isArray(node.enum) || !node.enum.length ||
      new Set(node.enum.map(canonicalJson)).size !== node.enum.length)) invalidSchema();
  for (const key of ["minLength", "maxLength"]) {
    if (has(key) && (!Number.isInteger(node[key]) || node[key] < 0)) invalidSchema();
  }
  for (const key of ["minimum", "maximum"]) {
    if (has(key) && !Number.isFinite(node[key])) invalidSchema();
  }
  if (node.minLength > node.maxLength || node.minimum > node.maximum) invalidSchema();
  if (has("pattern") && (typeof node.pattern !== "string" || node.pattern.length > 256 ||
      !safePattern.test(node.pattern) || /[\r\n]/.test(node.pattern))) invalidSchema();
  if (has("format") && !["date", "date-time"].includes(node.format)) invalidSchema();
  if (has("properties")) {
    if (!jsonObject(node.properties)) invalidSchema();
    for (const child of Object.values(node.properties)) validateNode(child, depth + 1);
  }
  if (has("items")) validateNode(node.items, depth + 1);
}

export function parseCollectionSchema(body) {
  if (!jsonObject(body) || Object.keys(body).some(key => !policyKeys.has(key)) ||
      !["schema", "indexed", "uniqueKey", "searchable", "sensitive"].every(key => Object.hasOwn(body, key)) ||
      body.schema?.type !== "object") invalidSchema();
  validateNode(body.schema, 1);
  const fields = body.schema.properties ?? {};
  for (const name of ["indexed", "searchable", "sensitive"]) {
    if (!uniqueStrings(body[name], field => fieldPattern.test(field) && Object.hasOwn(fields, field))) invalidSchema();
  }
  if (body.indexed.some(field => !indexTypes.has(fields[field].type)) ||
      body.searchable.some(field => fields[field].type !== "string")) invalidSchema();
  if (body.uniqueKey !== null && (typeof body.uniqueKey !== "string" || !body.indexed.includes(body.uniqueKey) ||
      fields[body.uniqueKey].type !== "string" || !body.schema.required?.includes(body.uniqueKey))) invalidSchema();
  if (Object.hasOwn(body, "auditActions")) {
    if (!Array.isArray(body.auditActions) || body.auditActions.some(action =>
      !jsonObject(action) || Object.keys(action).length !== 3 ||
      typeof action.action !== "string" || !/^[a-z][a-z0-9_.-]{1,63}$/.test(action.action) ||
      !["standard", "restricted"].includes(action.sensitivity) || typeof action.visibleToSubject !== "boolean") ||
      new Set(body.auditActions.map(action => action.action)).size !== body.auditActions.length) invalidSchema();
  }
  return body;
}
