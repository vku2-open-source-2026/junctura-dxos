// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Directory synchronization with the identity provider through a dedicated
// service account. Organization groups live under a top-level per-tenant
// namespace group: /{tenant}/{unit}/{group}. Every change is verified by
// reading the provider back; a change that cannot be confirmed reports
// failure and leaves the desired state to converge on a retry. The adapter
// never returns provider internals, only whether a step succeeded.
const childOf = (children, name) => (Array.isArray(children) ? children : [])
  .find(child => child?.name === name);

export function createDirectorySync(config, fetcher = fetch) {
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
    const issued = await response.json().catch(() => ({}));
    if (typeof issued.access_token !== "string" || !issued.access_token) throw new SyncFailure("unavailable");
    cachedToken = { value: issued.access_token,
      until: Date.now() + Math.max(0, (Number.isFinite(issued.expires_in) ? issued.expires_in : 60) - 10) * 1000 };
    return cachedToken.value;
  }

  async function call(path, { method = "GET", body } = {}) {
    let response;
    try {
      response = await fetcher(`${admin}${path}`, {
        method, redirect: "error", signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Bearer ${await token()}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch { throw new SyncFailure("unavailable"); }
    if (response.status === 404) { await response.body?.cancel(); return undefined; }
    if (!response.ok) { await response.body?.cancel(); throw new SyncFailure("unavailable"); }
    if (response.status === 204) return undefined;
    return response.json().catch(() => undefined);
  }

  async function namespace(tenant) {
    const read = async () => {
      const found = await call(`/groups?search=${encodeURIComponent(tenant)}&exact=true&max=500`);
      return (Array.isArray(found) ? found : []).find(group => group?.name === tenant);
    };
    const top = await read();
    if (top?.id) return top;
    await call("/groups", { method: "POST", body: { name: tenant } });
    const created = await read();
    if (!created?.id) throw new SyncFailure("unavailable");
    return created;
  }

  async function child(parent, name, path) {
    const found = childOf(await call(`/groups/${parent.id}/children`), name);
    if (found?.id) return found;
    await call(`/groups/${parent.id}/children`, { method: "POST", body: { name } });
    const created = childOf(await call(`/groups/${parent.id}/children`), name);
    if (!created?.id) throw new SyncFailure("unavailable");
    return created;
  }

  async function locate(tenant, unit, group) {
    const root = await namespace(tenant);
    const unitGroup = await child(root, unit);
    if (group === undefined) return unitGroup;
    return child(unitGroup, group);
  }

  async function removeGroupById(id) {
    for (const subgroup of (await call(`/groups/${id}/children`)) ?? []) {
      await removeGroupById(subgroup.id);
    }
    await call(`/groups/${id}`, { method: "DELETE" });
    if ((await call(`/groups/${id}`)) !== undefined) throw new SyncFailure("unavailable");
  }

  const user = async subject => {
    const found = await call(`/users/${encodeURIComponent(subject)}`);
    if (!found?.id) throw new SyncFailure("not_found");
    return found;
  };

  const memberGroups = async subject => (await call(`/users/${subject.id}/groups`)) ?? [];

  return {
    async putUnit(tenant, unit) {
      await locate(tenant, unit);
    },
    async removeUnit(tenant, unit) {
      const root = await namespace(tenant);
      const unitGroup = childOf(await call(`/groups/${root.id}/children`), unit);
      if (unitGroup?.id) await removeGroupById(unitGroup.id);
    },
    async putGroup(tenant, unit, group) {
      await locate(tenant, unit, group);
    },
    async removeGroup(tenant, unit, group) {
      const root = await namespace(tenant);
      const unitGroup = childOf(await call(`/groups/${root.id}/children`), unit);
      if (!unitGroup?.id) return;
      const subgroup = childOf(await call(`/groups/${unitGroup.id}/children`), group);
      if (subgroup?.id) await removeGroupById(subgroup.id);
    },
    async putMember(tenant, unit, subject, groups) {
      const person = await user(subject);
      // The subject must already belong to this tenant: provisioning marks that
      // with a membership under the tenant namespace group.
      const memberships = await memberGroups(person);
      if (!memberships.some(membership => membership.path === `/${tenant}` ||
        membership.path?.startsWith(`/${tenant}/`))) {
        throw new SyncFailure("not_found");
      }
      const root = await namespace(tenant);
      const unitGroup = await child(root, unit);
      const desired = new Map([[unitGroup.id, unitGroup]]);
      for (const name of groups) desired.set((await child(unitGroup, name)).id, name);
      for (const membership of memberships) {
        if (!desired.has(membership.id) && membership.path?.startsWith(`${unitGroup.path}/`)) {
          await call(`/users/${person.id}/groups/${membership.id}`, { method: "DELETE" });
        }
      }
      for (const id of desired.keys()) {
        await call(`/users/${person.id}/groups/${id}`, { method: "PUT" });
      }
      const seen = new Set((await memberGroups(person)).map(membership => membership.id));
      for (const id of desired.keys()) if (!seen.has(id)) throw new SyncFailure("unavailable");
    },
    async removeMember(tenant, unit, subject) {
      const root = await namespace(tenant);
      const unitGroup = childOf(await call(`/groups/${root.id}/children`), unit);
      if (!unitGroup?.id) return;
      let person;
      try { person = await user(subject); } catch (error) {
        if (error instanceof SyncFailure && error.code === "not_found") return;
        throw error;
      }
      for (const membership of await memberGroups(person)) {
        if (membership.id === unitGroup.id || membership.path?.startsWith(`${unitGroup.path}/`)) {
          await call(`/users/${person.id}/groups/${membership.id}`, { method: "DELETE" });
        }
      }
      for (const membership of await memberGroups(person)) {
        if (membership.id === unitGroup.id || membership.path?.startsWith(`${unitGroup.path}/`)) {
          throw new SyncFailure("unavailable");
        }
      }
    },
  };
}
