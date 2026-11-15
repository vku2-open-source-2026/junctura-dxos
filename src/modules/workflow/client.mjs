// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { HttpError } from "../../platform/http/http.mjs";

async function workflowResponse(config, path, options = {}) {
  let response;
  try {
    response = await fetch(`${config.workflowUrl}/${path}`, {
      ...options,
      headers: { Authorization: `Basic ${Buffer.from(`junctura-engine:${config.workflowPassword}`).toString("base64")}`,
        ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }) },
      signal: AbortSignal.timeout(10000), redirect: "error",
    });
  } catch { throw new HttpError(503, "workflow_unavailable"); }
  if (!response.ok) {
    if (response.status === 404) throw new HttpError(404, "not_found");
    if (response.status === 409) throw new HttpError(409, "workflow_conflict");
    throw new HttpError(503, "workflow_unavailable");
  }
  return response;
}

export async function workflowRequest(config, path, options = {}) {
  const response = await workflowResponse(config, path, options);
  const body = await response.text();
  return body ? JSON.parse(body) : null;
}

export async function workflowText(config, path) {
  const response = await workflowResponse(config, path);
  try {
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body ?? []) {
      length += chunk.byteLength;
      if (length > 262144) throw new HttpError(503, "workflow_unavailable");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch { throw new HttpError(503, "workflow_unavailable"); }
}
