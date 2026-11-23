// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Internal object reconciliation. It measures published versions whose byte
// size PostgreSQL does not know yet, so the per-app quota charges complete
// sums, and it finishes staged upload attempts the database never confirmed:
// the database first invalidates only attempts it still references, under the
// same lock the charging commit uses, and only then are those bytes removed.
// The worker RPC scopes every statement to one tenant.
import { signInternalToken } from "../../platform/security/internal-token.mjs";
import { HttpError } from "../../platform/http/http.mjs";

const maxBytes = 5 * 1024 * 1024;
const unmeasuredLimit = 256;
const stagedLimit = 64;
// An unmeasurable version backs off exponentially instead of occupying the
// sweep head, so one failing batch cannot block the rows behind it.
const deferBaseSeconds = 60;
const deferMaxSeconds = 3600;

async function maintenance(config, operation, payload, request = fetch) {
  if (!config.dataUrl) throw new HttpError(503, "objects_unavailable");
  let result;
  try {
    const db = await request(`${config.dataUrl}/rpc/object_maintenance`, {
      method: "POST", redirect: "error",
      headers: { Authorization: `Bearer ${signInternalToken(config.dataSecret, {
        role: "junctura_objects_worker", aud: "junctura-data", exp: Math.floor(Date.now() / 1000) + 30 })}`,
        "Content-Type": "application/json" },
      body: JSON.stringify({ operation, payload }),
      signal: AbortSignal.timeout(10000),
    });
    if (!db.ok) throw Error();
    result = await db.json();
  } catch { throw new HttpError(503, "objects_unavailable"); }
  if (result?.error) throw new HttpError(result.status, result.error);
  if (result?.status !== 200) throw new HttpError(503, "objects_unavailable");
  return result.value;
}

// The published version's size, or 0 when its bytes no longer exist (the
// version stays uncounted and unlisted); null retries on the next pass.
async function measure(config, item, request = fetch) {
  try {
    const head = await request(`${config.objectsUrl}/junctura-app/${item.tenantId}/${item.appId}/${item.id}/${item.version}`,
      { method: "HEAD", signal: AbortSignal.timeout(10000), redirect: "error" });
    if (head.status === 404) return 0;
    if (!head.ok) return null;
    const length = Number(head.headers.get("content-length"));
    return Number.isSafeInteger(length) && length >= 1 && length <= maxBytes ? length : null;
  } catch { return null; }
}

async function removeStagedBytes(config, item, request = fetch) {
  // A crashed Core leaves bytes on both upload paths: the published target and
  // the quarantine it passed through first.
  const published = await request(`${config.objectsUrl}/junctura-app/${item.tenantId}/${item.appId}/${item.id}/${item.stagedVersion}`,
    { method: "DELETE", signal: AbortSignal.timeout(10000), redirect: "error" });
  await published.arrayBuffer();
  try {
    await (await request(`${config.objectsUrl}/junctura-quarantine/${item.tenantId}/${item.id}/${item.stagedVersion}`,
      { method: "DELETE", signal: AbortSignal.timeout(10000), redirect: "error" })).arrayBuffer();
  } catch {
    // Best-effort quarantine cleanup; the published bytes decide success.
  }
  return published.ok || published.status === 404;
}

export async function reconcileOnce(config, request = fetch, stopped = () => false) {
  await measurePass(config, request, stopped);
  await stagingPass(config, request, stopped);
}

async function measurePass(config, request, stopped) {
  // Keyset over (tenant, app, id): the sweep always advances past the rows it
  // just reported, including rows it could not measure this time, and stops
  // once the source reports an empty page.
  let after;
  for (;;) {
    if (stopped()) return;
    const unmeasured = await maintenance(config, "unmeasured",
      { limit: unmeasuredLimit, ...(after ? { after } : {}) }, request);
    if (!Array.isArray(unmeasured) || !unmeasured.length) return;
    const sizes = [];
    for (const item of unmeasured) {
      const size = await measure(config, item, request);
      if (size === null) {
        // Unmeasurable rows back off on a retry schedule instead of holding
        // the head of the next sweep.
        sizes.push({ tenantId: item.tenantId, appId: item.appId, id: item.id, version: item.version,
          defer: Math.min(deferMaxSeconds, deferBaseSeconds * 2 ** Math.min(item.attempts ?? 0, 6)) });
      } else {
        sizes.push({ tenantId: item.tenantId, appId: item.appId, id: item.id, version: item.version, size });
      }
    }
    await maintenance(config, "sizes", { sizes }, request);
    const last = unmeasured.at(-1);
    after = { tenantId: last.tenantId, appId: last.appId, id: last.id };
  }
}

async function stagingPass(config, request, stopped) {
  const staged = await maintenance(config, "staged", { limit: stagedLimit }, request);
  // Bytes that are the published version stay; only unconfirmed attempts are
  // candidates, and the database invalidates each one under the charging lock
  // before any byte is touched. A failed deletion leaves the invalidated
  // attempt in place, so the next pass retries it instead of leaking bytes.
  const candidates = staged.filter(item => item.stagedVersion !== item.publishedVersion);
  if (!candidates.length) return;
  const { confirmed = [] } = await maintenance(config, "unstaged", { items: candidates.map(item =>
    ({ tenantId: item.tenantId, appId: item.appId, id: item.id, stagedVersion: item.stagedVersion })) }, request);
  const cleared = [];
  for (const item of confirmed) {
    if (stopped()) return;
    try { if (!await removeStagedBytes(config, item, request)) continue; }
    catch { continue; } // A busy Filer retries on the next pass.
    cleared.push({ tenantId: item.tenantId, appId: item.appId, id: item.id, stagedVersion: item.stagedVersion });
  }
  if (cleared.length) {
    await maintenance(config, "unstaged", { items: cleared, cleared: true }, request);
  }
}

export function startObjectReconciler(config, delay = 30_000) {
  if (!config.objectsUrl || !config.dataUrl) return undefined;
  let stopped = false;
  async function tick() {
    try { await reconcileOnce(config, fetch, () => stopped); }
    catch { /* Retry database or storage outages on the next pass. */ }
    if (!stopped) timer = setTimeout(tick, delay).unref();
  }
  let timer = setTimeout(tick, delay).unref();
  return () => { stopped = true; clearTimeout(timer); };
}
