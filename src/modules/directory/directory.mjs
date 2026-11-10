// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Read-only tenant directory: enrolled management principals and the real
// organization/application tree. The database enforces audit.read on the
// verified caller; Core only asserts the private directory role.
import { applicationToken } from "../applications/applications.mjs";
import { HttpError, json } from "../../platform/http/http.mjs";

export const DIRECTORY_PRINCIPALS_PATH = "/v1/directory/principals";
export const DIRECTORY_ORGANIZATIONS_PATH = "/v1/directory/organizations";

const RPC = {
  [DIRECTORY_PRINCIPALS_PATH]: "directory_principals",
  [DIRECTORY_ORGANIZATIONS_PATH]: "directory_organizations",
};

const profileText = (value) => value === null ||
  (typeof value === "string" && value.length >= 1 && value.length <= 200 &&
    !/[\u0000-\u001f\u007f]/u.test(value));

function validPrincipals(value) {
  return Array.isArray(value?.items) && typeof value.truncated === "boolean" &&
    value.items.every((item) => item && typeof item === "object" &&
      typeof item.subject === "string" && typeof item.issuer === "string" &&
      typeof item.managementClient === "string" && Array.isArray(item.permissions) &&
      item.permissions.every((permission) => typeof permission === "string") &&
      typeof item.enabled === "boolean" &&
      Object.hasOwn(item, "displayName") && profileText(item.displayName) &&
      Object.hasOwn(item, "organization") && profileText(item.organization) &&
      Object.hasOwn(item, "jobTitle") && profileText(item.jobTitle) &&
      Object.hasOwn(item, "kind") && (item.kind === null || item.kind === "admin" || item.kind === "application"));
}

function validOrganizations(value) {
  const root = value?.root;
  return root && typeof root === "object" && typeof root.id === "string" &&
    typeof root.name === "string" && root.kind === "platform" &&
    Array.isArray(root.children) && root.children.every((child) =>
      child && typeof child === "object" && typeof child.id === "string" &&
      typeof child.name === "string" &&
      (child.kind === "organization" || child.kind === "application") &&
      Array.isArray(child.children)) &&
    Array.isArray(value.relations) && value.relations.every((relation) =>
      relation && typeof relation.from === "string" && typeof relation.to === "string" &&
      typeof relation.label === "string") &&
    typeof value.truncated === "boolean";
}

export async function handleDirectory(request, response, identity, config, url) {
  const rpc = RPC[url.pathname];
  if (!rpc) throw new HttpError(404, "not_found");
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    throw new HttpError(405, "method_not_allowed");
  }
  if (url.search) throw new HttpError(400, "invalid_query");
  if (!config.dataUrl) throw new HttpError(503, "directory_unavailable");
  if (!identity.clientId) throw new HttpError(403, "verified_client_required");
  let result;
  try {
    const db = await fetch(`${config.dataUrl}/rpc/${rpc}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${applicationToken(identity, config.dataSecret, "junctura_directory_api")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ payload: {} }),
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    if (!db.ok) throw Error();
    result = await db.json();
  } catch { throw new HttpError(503, "directory_unavailable"); }
  if (result?.error) throw new HttpError(result.status, result.error);
  if (result?.status !== 200) throw new HttpError(503, "directory_unavailable");
  if (rpc === "directory_principals" ? !validPrincipals(result.value) : !validOrganizations(result.value)) {
    throw new HttpError(503, "directory_unavailable");
  }
  response.setHeader("Cache-Control", "no-store");
  return json(response, 200, result.value);
}
