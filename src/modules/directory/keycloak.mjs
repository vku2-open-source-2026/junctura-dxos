// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Directory synchronization with the identity provider through a dedicated
// service account. Organization groups live under a top-level per-tenant
// namespace group: /{tenant}/{unit}/{group}. Every change is verified by
// reading the provider back; a change that cannot be confirmed reports
// failure and leaves the desired state for reconciliation. The adapter
// never returns provider internals, only whether a step succeeded.
const PAGE = 200;

const childOf = (children, name) => (Array.isArray(children) ? children : [])
  .find(child => child?.name === name);

export function createDirectorySync(config, fetcher = fetch, beforeWrite = async () => {}) {
  if (!config.identityUrl || !config.directorySyncClientId || !config.directorySyncSecret) return undefined;
  const [, realm] = /\/realms\/([^/]+)$/.exec(config.identityUrl) ?? [];
  if (!realm) return undefined;
  const admin = `${config.identityUrl.replace(/\/realms\/[^/]+$/, "")}/admin/realms/${realm}`;

  class SyncFailure extends Error {
    constructor(code) { super(code); this.code = code; }
  }

  let cachedToken;
  async function token() {
    if (cachedToken?.until > Date.now()) return cachedToken.value;
    let response;
    try {
      response = await fetcher(`${config.identityUrl}/protocol/openid-connect/token`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
        body: new URLSearchParams({ grant_type: "client_credentials",
          client_id: config.directorySyncClientId, client_secret: config.directorySyncSecret }),
      });
    } catch { throw new SyncFailure("unavailable"); }
    if (!response.ok) { await response.body?.cancel(); throw new SyncFailure("unavailable"); }
    const issued = await response.json().catch(() => { throw new SyncFailure("unavailable"); });
    if (typeof issued.access_token !== "string" || !issued.access_token) throw new SyncFailure("unavailable");
    cachedToken = { value: issued.access_token,
      until: Date.now() + Math.max(0, (Number.isFinite(issued.expires_in) ? issued.expires_in : 60) - 10) * 1000 };
    return cachedToken.value;
  }

  async function call(path, { method = "GET", body, expect } = {}) {
    const accessToken = await token();
    if (method !== "GET") await beforeWrite();
    let response;
    try {
      response = await fetcher(`${admin}${path}`, {
        method, redirect: "error", signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Bearer ${accessToken}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch { throw new SyncFailure("unavailable"); }
    if (response.status === 404) { await response.body?.cancel(); return undefined; }
    if (!response.ok) {
      await response.body?.cancel();
      throw Object.assign(new SyncFailure("unavailable"), { method, providerStatus: response.status });
    }
    if (method !== "GET") { await response.body?.cancel(); return; }
    const value = await response.json().catch(() => { throw new SyncFailure("unavailable"); });
    if (response.status !== 200 || !expect(value)) throw new SyncFailure("unavailable");
    return value;
  }

  const isGroup = item => typeof item?.id === "string" && !!item.id &&
    typeof item.name === "string" && typeof item.path === "string";
  const isUser = item => typeof item?.id === "string" && !!item.id;

  // Listing endpoints page by default; only a full walk can prove absence.
  // Servers may cap pages below the requested max, so the offset advances by
  // the returned batch until it comes back empty.
  async function allPages(path) {
    const items = [];
    let first = 0;
    while (true) {
      const separator = path.includes("?") ? "&" : "?";
      const batch = await call(`${path}${separator}first=${first}&max=${PAGE}`,
        { expect: value => Array.isArray(value) && value.every(isGroup) });
      if (batch === undefined) return undefined;
      items.push(...batch);
      if (batch.length === 0) return items;
      first += batch.length;
      if (items.length > 10000) throw new SyncFailure("unavailable");
    }
  }

  async function findNamespace(tenant) {
    const roots = await allPages(`/groups?search=${encodeURIComponent(tenant)}&exact=true`);
    if (!roots) throw new SyncFailure("unavailable");
    return roots.find(group => group.path === `/${tenant}`);
  }

  async function namespace(tenant) {
    const top = await findNamespace(tenant);
    if (top) return top;
    await call("/groups", { method: "POST", body: { name: tenant } });
    const created = await findNamespace(tenant);
    if (!created) throw new SyncFailure("unavailable");
    return created;
  }

  async function findChild(parent, name) {
    if (!parent) return undefined;
    return childOf(await allPages(`/groups/${parent.id}/children`), name);
  }

  async function requireChild(parent, name) {
    const child = await findChild(parent, name);
    if (!child) throw new SyncFailure("unavailable");
    return child;
  }

  async function ensureChild(parent, name) {
    const found = await findChild(parent, name);
    if (found?.id) return found;
    await call(`/groups/${parent.id}/children`, { method: "POST", body: { name } });
    const created = await findChild(parent, name);
    if (!created?.id) throw new SyncFailure("unavailable");
    return created;
  }

  async function removeGroupById(id) {
    await call(`/groups/${id}`, { method: "DELETE" });
    if ((await call(`/groups/${id}`, { expect: isGroup })) !== undefined) throw new SyncFailure("unavailable");
  }

  const user = async subject => {
    const found = await call(`/users/${encodeURIComponent(subject)}`, { expect: isUser });
    if (!found) throw new SyncFailure("not_found");
    return found;
  };

  const memberGroups = async subject => {
    const groups = await allPages(`/users/${subject.id}/groups`);
    if (!groups) throw new SyncFailure("unavailable");
    return groups;
  };

  const underUnit = (membership, unitGroup) => membership?.path === unitGroup.path ||
    membership.path?.startsWith(`${unitGroup.path}/`);

  return {
    call,
    async groupForAssignment(tenant, unit, group) {
      const unitGroup = await requireChild(await findNamespace(tenant), unit);
      return group ? requireChild(unitGroup, group) : unitGroup;
    },
    // The named login subject must already belong to this tenant: provisioning
    // marks that with membership in the exact tenant root group.
    async verifySubject(tenant, subject) {
      const person = await user(subject);
      const memberships = await memberGroups(person);
      if (!memberships.some(membership => membership.path === `/${tenant}`)) {
        throw new SyncFailure("not_found");
      }
    },
    async putUnit(tenant, unit) {
      await ensureChild(await namespace(tenant), unit);
    },
    async removeUnit(tenant, unit) {
      const root = await findNamespace(tenant);
      const unitGroup = await findChild(root, unit);
      if (unitGroup?.id) await removeGroupById(unitGroup.id);
    },
    async putGroup(tenant, unit, group) {
      await ensureChild(await ensureChild(await namespace(tenant), unit), group);
    },
    async removeGroup(tenant, unit, group) {
      const root = await findNamespace(tenant);
      const unitGroup = await findChild(root, unit);
      if (!unitGroup?.id) return;
      const subgroup = await findChild(unitGroup, group);
      if (subgroup?.id) await removeGroupById(subgroup.id);
    },
    async putMember(tenant, unit, subject, groups) {
      const person = await user(subject);
      // The subject must already belong to this tenant: provisioning marks that
      // with membership in the exact tenant root group. Deeper groups never
      // prove enrollment, because their names can repeat across tenants.
      const memberships = await memberGroups(person);
      if (!memberships.some(membership => membership.path === `/${tenant}`)) {
        throw new SyncFailure("not_found");
      }
      const root = await findNamespace(tenant);
      const unitGroup = await requireChild(root, unit);
      const desired = new Map([[unitGroup.id, unitGroup]]);
      for (const name of groups) {
        const group = await requireChild(unitGroup, name);
        desired.set(group.id, group);
      }
      for (const membership of memberships) {
        if (!desired.has(membership.id) && underUnit(membership, unitGroup)) {
          await call(`/users/${person.id}/groups/${membership.id}`, { method: "DELETE" });
        }
      }
      const existing = new Set(memberships.map(membership => membership.id));
      for (const id of desired.keys()) {
        if (existing.has(id)) continue;
        await call(`/users/${person.id}/groups/${id}`, { method: "PUT" });
      }
      // Read the whole membership set back: only an exact match of every
      // desired group inside this unit confirms the change.
      const actual = new Set((await memberGroups(person))
        .filter(membership => underUnit(membership, unitGroup)).map(membership => membership.id));
      for (const id of desired.keys()) if (!actual.has(id)) throw new SyncFailure("unavailable");
      if (actual.size !== desired.size) throw new SyncFailure("unavailable");
    },
    async removeMember(tenant, unit, subject) {
      const root = await findNamespace(tenant);
      const unitGroup = await findChild(root, unit);
      if (!unitGroup?.id) return;
      let person;
      try { person = await user(subject); } catch (error) {
        if (error instanceof SyncFailure && error.code === "not_found") return;
        throw error;
      }
      for (const membership of await memberGroups(person)) {
        if (underUnit(membership, unitGroup)) {
          await call(`/users/${person.id}/groups/${membership.id}`, { method: "DELETE" });
        }
      }
      for (const membership of await memberGroups(person)) {
        if (underUnit(membership, unitGroup)) throw new SyncFailure("unavailable");
      }
    },
  };
}
