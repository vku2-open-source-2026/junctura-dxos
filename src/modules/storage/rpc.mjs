// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Calls a private, read-only storage function through PostgREST. The internal
// token names the dedicated database role; the function still verifies
// audit.read from the verified caller claims in PostgreSQL.
import { applicationToken } from "../applications/applications.mjs";
import { HttpError } from "../../platform/http/http.mjs";

export async function storageRpc(config, identity, role, name, payload) {
  if (!config.dataUrl) throw new HttpError(503, "storage_unavailable");
  let response;
  try {
    response = await fetch(`${config.dataUrl}/rpc/${name}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${applicationToken(identity, config.dataSecret, role)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ payload }),
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
  } catch { throw new HttpError(503, "storage_unavailable"); }
  if (!response.ok) throw new HttpError(503, "storage_unavailable");
  let result;
  try { result = await response.json(); } catch { throw new HttpError(503, "storage_unavailable"); }
  if (result?.error) throw new HttpError(result.status, result.error);
  return result;
}
