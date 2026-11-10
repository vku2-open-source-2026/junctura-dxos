// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const consoleDir = path.resolve(scriptDir, "..");
const repoDir = path.resolve(consoleDir, "..");
const contractDir = path.join(repoDir, "docs", "contracts");
const outputPath = path.join(consoleDir, "src", "constants", "apiReference.json");
const methods = new Set(["get", "head", "post", "put", "patch", "delete"]);

const foundationSpec = JSON.parse(
  fs.readFileSync(path.join(contractDir, "foundation-api.openapi.json"), "utf8"),
);
const capabilitySpec = JSON.parse(
  fs.readFileSync(path.join(contractDir, "capability-api-v1.openapi.json"), "utf8"),
);
const externalSpecs = new Map([
  [
    "./capability-manifest-v1.schema.json",
    JSON.parse(
      fs.readFileSync(path.join(contractDir, "capability-manifest-v1.schema.json"), "utf8"),
    ),
  ],
  [
    "./composition-v1.schema.json",
    JSON.parse(
      fs.readFileSync(path.join(contractDir, "composition-v1.schema.json"), "utf8"),
    ),
  ],
]);

const UUID = "c3d4e5f6-7a8b-4c9d-0e1f-2a3b4c5d6e7f";
const DIGEST = `sha256:${"0".repeat(64)}`;
const TIMESTAMP = "2026-01-01T00:00:00Z";

function deref(input, spec, seen = new Set()) {
  if (!input || typeof input !== "object" || typeof input.$ref !== "string") {
    return { value: input, spec };
  }
  const reference = input.$ref;
  if (seen.has(reference)) return { value: {}, spec };
  const [file, pointer = ""] = reference.split("#");
  let document = spec;
  if (file) {
    document = externalSpecs.get(file);
    if (!document) return { value: {}, spec };
  }
  const target = pointer
    ? pointer
        .split("/")
        .filter(Boolean)
        .reduce((node, key) => node?.[key], document)
    : document;
  return deref(target, document, new Set(seen).add(reference));
}

function parameterSchema(parameter, spec) {
  const { value } = deref(parameter, spec);
  return value?.schema ? deref(value.schema, spec).value : {};
}

function sample(input, spec, depth = 0, seen = new Set(), hint = "") {
  if (depth > 6) return null;
  const { value: schema, spec: document } = deref(input, spec, seen);
  if (!schema || typeof schema !== "object") return null;
  if (schema.oneOf || schema.anyOf) {
    return sample((schema.oneOf ?? schema.anyOf)[0], document, depth + 1, seen, hint);
  }
  if (schema.allOf) {
    const properties = {};
    for (const part of schema.allOf) {
      const { value } = deref(part, document);
      Object.assign(properties, value?.properties ?? {});
    }
    return sample({ type: "object", properties }, document, depth + 1, seen, hint);
  }
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) return schema.enum[0];
  if (schema.default !== undefined) return schema.default;
  if (schema.type === "object" || schema.properties) {
    const result = {};
    const entries = Object.entries(schema.properties ?? {});
    for (const [key, property] of entries.slice(0, 30)) {
      result[key] = sample(property, document, depth + 1, seen, key);
    }
    if (entries.length === 0 && schema.additionalProperties) {
      const additional =
        typeof schema.additionalProperties === "object" ? schema.additionalProperties : {};
      result.key = sample(additional, document, depth + 1, seen, "key");
    }
    return result;
  }
  if (schema.type === "array") {
    return [sample(schema.items, document, depth + 1, seen, hint)];
  }
  if (schema.type === "integer" || schema.type === "number") {
    if (typeof schema.minimum === "number") return Math.ceil(schema.minimum);
    return 1;
  }
  if (schema.type === "boolean") return true;
  if (schema.type === "null") return null;
  if (schema.type === "string" || !schema.type) {
    if (hint === "capabilityId") {
      return `urn:junctura:capability:${UUID}:example-capability`;
    }
    if (hint === "version") return "1.0.0";
    if (schema.format === "uuid") return UUID;
    if (schema.format === "date-time" || schema.pattern?.includes("Z$")) return TIMESTAMP;
    if (schema.format === "date") return "2026-01-01";
    if (schema.format === "email") return "operator@example.test";
    if (schema.format === "uri" || schema.format === "url") return "https://example.test";
    if (schema.pattern?.includes("sha256")) return DIGEST;
    if (schema.pattern === "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$") {
      return UUID;
    }
    if (hint === "cursor") return "cursor_01";
    return "example";
  }
  return null;
}

function parametersFor(pathItem, operation, spec) {
  return [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]
    .map((parameter) => deref(parameter, spec).value)
    .filter((parameter) => parameter && parameter.in && parameter.name);
}

function summarizeParameter(parameter, spec) {
  return {
    name: parameter.name,
    required: parameter.required === true,
    description: parameter.description ?? "",
    schema: parameterSchema(parameter, spec),
  };
}

function successResponse(operation, spec) {
  const statuses = Object.keys(operation.responses ?? {})
    .filter((status) => /^2\d\d$/.test(status))
    .sort((a, b) => Number(a) - Number(b));
  for (const status of statuses) {
    const { value: response } = deref(operation.responses[status], spec);
    const content = response?.content ?? {};
    for (const mediaType of Object.keys(content)) {
      if (mediaType === "application/octet-stream") continue;
      if (content[mediaType]?.schema) {
        return { status, schema: content[mediaType].schema };
      }
    }
  }
  return { status: statuses[0] ?? null, schema: null };
}

function responseExample(operation, spec) {
  const { schema } = successResponse(operation, spec);
  if (!schema) return "";
  const value = sample(schema, spec);
  if (value === null || value === undefined) return "";
  return JSON.stringify(value, null, 2);
}

function requestExample(operation, spec) {
  const content = operation.requestBody?.content;
  if (!content) return { contentType: null, body: null };
  const contentType = Object.keys(content)[0] ?? null;
  if (contentType === "application/json" && content[contentType]?.schema) {
    return { contentType, body: sample(content[contentType].schema, spec) };
  }
  return { contentType, body: null };
}

function examplePath(endpointPath, parameters, spec) {
  return endpointPath.replace(/\{([^}]+)\}/g, (_, name) => {
    const parameter = parameters.find(
      (candidate) => candidate.in === "path" && candidate.name === name,
    );
    const value = parameter ? sample(parameterSchema(parameter, spec), spec, 0, new Set(), name) : name;
    return value === null || value === undefined ? name : String(value);
  });
}

function requiredPermissions(operation) {
  return (
    operation["x-junctura-required-permissions"] ??
    operation["x-junctura-core-roles"] ??
    []
  );
}

const foundation = {};
for (const [endpointPath, pathItem] of Object.entries(foundationSpec.paths)) {
  for (const [method, operation] of Object.entries(pathItem)) {
    if (!methods.has(method) || !operation.operationId) continue;
    foundation[operation.operationId] = {
      permissions: requiredPermissions(operation),
      responseExample: responseExample(operation, foundationSpec),
      path: endpointPath,
    };
  }
}

const capability = [];
for (const [endpointPath, pathItem] of Object.entries(capabilitySpec.paths)) {
  for (const [method, operation] of Object.entries(pathItem)) {
    if (!methods.has(method) || !operation.operationId) continue;
    const parameters = parametersFor(pathItem, operation, capabilitySpec);
    const request = requestExample(operation, capabilitySpec);
    const success = successResponse(operation, capabilitySpec);
    capability.push({
      path: endpointPath,
      method: method.toUpperCase(),
      operationId: operation.operationId,
      summary: operation.summary ?? "",
      description: operation.description ?? "",
      tags: operation.tags ?? [],
      permissions: requiredPermissions(operation),
      responses: Object.keys(operation.responses ?? {}),
      hasRequestBody: Boolean(operation.requestBody),
      requestContentTypes: Object.keys(operation.requestBody?.content ?? {}),
      pathParameters: parameters.filter((item) => item.in === "path").map((item) => summarizeParameter(item, capabilitySpec)),
      queryParameters: parameters.filter((item) => item.in === "query").map((item) => summarizeParameter(item, capabilitySpec)),
      headerParameters: parameters.filter((item) => item.in === "header").map((item) => summarizeParameter(item, capabilitySpec)),
      examplePath: examplePath(endpointPath, parameters, capabilitySpec),
      requestContentType: request.contentType,
      requestBodyExample: request.body,
      successStatus: success.status,
      responseExample: responseExample(operation, capabilitySpec),
    });
  }
}

const payload = { foundation, capability };
const generated = `${JSON.stringify(payload)}\n`;

if (process.argv.includes("--check")) {
  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
  if (current !== generated) {
    console.error("apiReference.json is stale; run npm run generate:api-reference");
    process.exitCode = 1;
  } else {
    console.log(
      `API reference is current (${Object.keys(foundation).length} foundation, ${capability.length} capability)`,
    );
  }
} else {
  fs.writeFileSync(outputPath, generated);
  console.log(
    `Wrote ${Object.keys(foundation).length} foundation and ${capability.length} capability operations to ${path.relative(repoDir, outputPath)}`,
  );
}
