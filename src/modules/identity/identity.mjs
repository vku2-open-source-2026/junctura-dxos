// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// The caller's verified identity: tenant and roles from the token, optional
// preferred username from the caller's own token, and the organization context
// from verified provider groups. An optional subjectId claim is only shown
// once the operator binding ties it to this login subject in this tenant and
// issuer; credentials and provider administration stay hidden.
import { applicationToken } from "../applications/applications.mjs";
import { HttpError, json } from "../../platform/http/http.mjs";

export async function verifiedSubjectBinding(config, identity, fetcher = fetch) {
  if (!config.dataUrl || !identity.subjectId) return false;
  let result;
  try {
    const db = await fetch(`${config.dataUrl}/rpc/subject_binding`, {
      method: "POST",
      headers: { Authorization: `Bearer ${applicationToken(identity, config.dataSecret, "junctura_subject_api")}`,
        "Content-Type": "application/json" },
      body: JSON.stringify({ payload: {} }),
      signal: AbortSignal.timeout(3000),
      redirect: "error",
    });
    if (!db.ok) throw Error();
    result = await db.json();
  } catch { return false; }
  return result?.status === 200 && result.value?.subjectId === identity.subjectId;
}

export async function handleIdentity(request, response, identity, config) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    throw new HttpError(405, "method_not_allowed");
  }
  if (new URL(request.url, "http://core").search) throw new HttpError(400, "invalid_query");
  const subjectId = await verifiedSubjectBinding(config, identity) ? identity.subjectId : undefined;
  return json(response, 200, {
    subject: identity.subject,
    tenantId: identity.tenantId,
    roles: identity.roles.filter(role => role === "core-reader" || role === "core-writer"),
    units: identity.units,
    groups: identity.groups,
    ...(subjectId ? { subjectId } : {}),
    ...(identity.preferredUsername ? { preferredUsername: identity.preferredUsername } : {}),
  });
}
