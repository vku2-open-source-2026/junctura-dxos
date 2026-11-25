// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { createDirectorySync } from "../directory/keycloak.mjs";

export const consoleAccessRoles = ["console-admin", "console-manager", "console-viewer"];
const accessRole = "junctura-access";
const reason = "not_assigned_to_app";
const isEntry = value => typeof value?.id === "string";
const isList = value => Array.isArray(value) && value.every(isEntry);
const unitMapper = {
  name: "junctura-unit", protocol: "openid-connect", protocolMapper: "oidc-usermodel-attribute-mapper",
  config: { "user.attribute": "junctura_unit", "claim.name": "junctura_unit", "jsonType.label": "String",
    "access.token.claim": "true", "introspection.token.claim": "true" },
};

export function accessFlows(alias, clientId) {
  const isConsole = clientId === "junctura-console";
  const adminCondition = negate => ({ name: "conditional-user-role",
    config: { condUserRole: `${clientId}.console-admin`, negate: String(negate) } });
  const otpBranch = (suffix, authenticator) => ({ name: `${alias}-${suffix}`, requirement: "CONDITIONAL", children: [
    { name: "conditional-user-configured" }, { name: authenticator },
    ...(isConsole ? [adminCondition(true)] : []),
  ] });
  // Install required admin OTP before narrowing the existing optional branches.
  // The execution priority keeps it after sign-in, including cookie-based SSO.
  const adminOtpBranch = (flow, children) => isConsole ? [{ name: `${alias}-${flow}-admin-otp`,
    requirement: "CONDITIONAL", priority: 50, children: [adminCondition(false), ...children] }] : [];
  const directOtp = "direct-grant-validate-otp";
  const adminDirectConfigured = `${alias}-direct-admin-configured-otp`;
  return [
    { alias: `${alias}-browser`, children: [
      ...adminOtpBranch("browser", [{ name: "auth-otp-form" }]),
      { name: `${alias}-sign-in`, children: [
        { name: "auth-cookie", requirement: "ALTERNATIVE" },
        { name: `${alias}-forms`, requirement: "ALTERNATIVE", children: [
          { name: "auth-username-password-form" },
          otpBranch("otp", "auth-otp-form"),
        ] },
      ] },
      deniedBranch(`${alias}-browser`, clientId),
    ] },
    { alias: `${alias}-direct`, children: [
      ...adminOtpBranch("direct", [
        { name: adminDirectConfigured, requirement: "CONDITIONAL", children: [
          { name: "conditional-user-configured" }, { name: directOtp },
        ] },
        // The direct OTP validator throws if the user has no credential. Deny that case explicitly.
        { name: `${alias}-direct-admin-otp-denied`, requirement: "CONDITIONAL", children: [
          { name: "conditional-sub-flow-executed", config: { flow_to_check: adminDirectConfigured, check_result: "not-executed" } },
          { name: "deny-access-authenticator", config: { denyErrorMessage: "credentialSetupRequired" } },
        ] },
      ]),
      { name: "direct-grant-validate-username" },
      { name: "direct-grant-validate-password" },
      otpBranch("direct-otp", directOtp),
      deniedBranch(`${alias}-direct`, clientId),
    ] },
  ];
}

function deniedBranch(alias, clientId) {
  return { name: `${alias}-denied`, requirement: "CONDITIONAL", children: [
    { name: "conditional-user-role", config: { condUserRole: `${clientId}.${accessRole}`, negate: "true" } },
    { name: "deny-access-authenticator", config: { denyErrorMessage: reason } },
  ] };
}

export function createApplicationProvider(config, beforeWrite, fetcher = fetch) {
  const provider = createDirectorySync({ ...config, directorySyncClientId: config.appSyncClientId,
    directorySyncSecret: config.appSyncSecret }, fetcher, beforeWrite);
  if (!provider) return undefined;
  const { call } = provider;
  const get = (path, expect = isEntry) => call(path, { expect });
  const write = (path, method, body) => call(path, { method, body });
  const fail = () => { throw new Error("app_provider_unavailable"); };
  const clientPath = id => `/clients/${id}`;

  async function client(clientId) {
    const item = (await get(`/clients?clientId=${encodeURIComponent(clientId)}`, isList))
      ?.find(item => item.clientId === clientId);
    if (!item) fail();
    return (await get(clientPath(item.id))) ?? fail();
  }

  const usesClientSecret = item => !item.publicClient && item.clientAuthenticatorType === "client-secret";
  const readClientSecret = path => get(`${path}/client-secret`, value => typeof value?.value === "string" && value.value.length > 0);

  async function role(path, name, attributes) {
    const target = `${path}/roles/${encodeURIComponent(name)}`;
    let value = await get(target);
    if (!value) {
      await write(`${path}/roles`, "POST", { name, attributes });
      value = await get(target);
    }
    return value ?? fail();
  }

  async function flowTree(alias, children) {
    const path = `/authentication/flows/${encodeURIComponent(alias)}/executions`;
    for (const [index, child] of children.entries()) {
      const { name, requirement = "REQUIRED", config, priority = index * 10 } = child;
      const find = async () => (await get(path, isList))?.find(item => item.level === 0 &&
        (child.children ? item.displayName === name : item.providerId === name));
      let execution = await find();
      if (!execution) {
        if (child.children) await write(`${path}/flow`, "POST", { alias: name, type: "basic-flow", priority });
        else await write(`${path}/execution`, "POST", { provider: name, priority });
        execution = (await find()) ?? fail();
      }
      if (child.children) await flowTree(name, child.children);
      if (config) {
        const desired = { alias: `${alias}-${name}`, config };
        const configPath = `/authentication/config/${execution.authenticationConfig}`;
        if (!execution.authenticationConfig) {
          await write(`/authentication/executions/${execution.id}/config`, "POST", desired);
        } else {
          const current = await get(configPath);
          if (Object.keys(config).some(key => current?.config?.[key] !== config[key])) await write(configPath, "PUT", desired);
        }
      }
      if (execution.requirement !== requirement) await write(path, "PUT", { ...execution, requirement });
    }
  }

  async function flow({ alias, children }) {
    const path = "/authentication/flows";
    let item = (await get(path, isList))?.find(item => item.alias === alias);
    if (!item) {
      await write(path, "POST", { alias, providerId: "basic-flow", topLevel: true, builtIn: false });
      item = (await get(path, isList))?.find(item => item.alias === alias) ?? fail();
    }
    await flowTree(alias, children);
    return item.id;
  }

  async function composite(parent, child) {
    const path = `/roles-by-id/${parent.id}/composites`;
    if (!(await get(path, isList))?.some(role => role.id === child.id)) await write(path, "POST", [child]);
    if (!(await get(path, isList))?.some(role => role.id === child.id)) fail();
  }

  async function configure(clientId, appId) {
    const item = await client(clientId);
    const path = clientPath(item.id);
    const access = await role(path, accessRole);
    const [browser, directGrant] = accessFlows(`junctura-${appId}`, clientId);
    const browserId = await flow(browser);
    const directId = await flow(directGrant);
    // Disable grants that could issue a user token without the configured flow.
    const attributes = { ...item.attributes, "use.refresh.tokens": "false", "standard.token.exchange.enabled": "false",
      "oauth2.jwt.authorization.grant.enabled": "false", "oidc.ciba.grant.enabled": "false",
      "oauth2.device.authorization.grant.enabled": "false", "pkce.code.challenge.method": "S256" };
    const overrides = { ...item.authenticationFlowBindingOverrides, browser: browserId, direct_grant: directId };
    const standardFlowEnabled = clientId === "junctura-console" ||
      (Boolean(item.standardFlowEnabled) && Boolean(item.redirectUris?.length) && item.redirectUris.every(uri => !uri.includes("*")));
    if (Object.keys(attributes).some(key => attributes[key] !== item.attributes?.[key]) ||
        Object.keys(overrides).some(key => overrides[key] !== item.authenticationFlowBindingOverrides?.[key]) ||
        item.implicitFlowEnabled || Boolean(item.standardFlowEnabled) !== standardFlowEnabled) {
      await write(path, "PUT", { id: item.id, clientId, type: item.type, implicitFlowEnabled: false,
        standardFlowEnabled, attributes, authenticationFlowBindingOverrides: overrides,
        ...(item.authorizationServicesEnabled ? { authorizationServicesEnabled: true } : {}),
        ...(!item.authenticationFlowBindingOverrides?.browser && (item.standardFlowEnabled || item.implicitFlowEnabled || item.directAccessGrantsEnabled)
          ? { notBefore: Math.floor(Date.now() / 1000) } : {}) });
    }
    const optionalScopes = await get(`${path}/optional-client-scopes`, isList);
    const offline = optionalScopes?.find(scope => scope.name === "offline_access");
    if (offline) await write(`${path}/optional-client-scopes/${offline.id}`, "DELETE");
    const stored = await get(path);
    if (stored?.authenticationFlowBindingOverrides?.browser !== browserId ||
        stored.authenticationFlowBindingOverrides.direct_grant !== directId ||
        stored.attributes?.["use.refresh.tokens"] !== "false") fail();
    if (clientId === "junctura-console") {
      for (const name of consoleAccessRoles) await composite(await role(path, name), access);
    } else {
      const mappers = await get(`${path}/protocol-mappers/models`, isList);
      const existing = mappers?.find(value => value.name === unitMapper.name);
      if (!existing) await write(`${path}/protocol-mappers/models`, "POST", unitMapper);
      else if (Object.keys(unitMapper.config).some(key => existing.config?.[key] !== unitMapper.config[key])) {
        await write(`${path}/protocol-mappers/models/${existing.id}`, "PUT", { ...unitMapper, id: existing.id });
      }
    }
    return { item, path, access };
  }

  let consoleClientId;
  return {
    configure,
    async getConnectionSecret(clientId) {
      const item = await client(clientId);
      if (!usesClientSecret(item)) return undefined;
      return (await readClientSecret(clientPath(item.id)))?.value ?? fail();
    },
    async consoleRoles(subject) {
      consoleClientId ??= (await client("junctura-console")).id;
      const mapping = await get(`/users/${encodeURIComponent(subject)}/role-mappings/clients/${consoleClientId}/composite`, isList);
      return mapping?.map(role => role.name) ?? [];
    },
    async applyAssignment(tenant, clientId, appId, assignment) {
      const { item, path, access } = await configure(clientId, appId);
      const name = `junctura-assignment-${assignment.assignmentId}`;
      if (!assignment.enabled) {
        await write(`${path}/roles/${name}`, "DELETE");
        if (await get(`${path}/roles/${name}`)) fail();
        return;
      }
      const child = await role(path, name, { unit: [assignment.unit], role: [assignment.role] });
      await composite(child, access);
      const targetPath = assignment.targetType === "subject"
        ? `/users/${encodeURIComponent(assignment.target)}`
        : `/groups/${(await provider.groupForAssignment(tenant, assignment.unit,
          assignment.targetType === "group" ? assignment.target : undefined)).id}`;
      const mapping = `${targetPath}/role-mappings/clients/${item.id}`;
      if (!(await get(mapping, isList))?.some(role => role.id === child.id)) await write(mapping, "POST", [child]);
      if (!(await get(mapping, isList))?.some(role => role.id === child.id)) fail();
    },
    async prepareRotation(clientId) {
      const item = await client(clientId);
      if (!usesClientSecret(item)) throw new Error("oidc_secret_unsupported");
      const path = clientPath(item.id);
      return async secret => {
        await write(path, "PUT", { id: item.id, clientId, type: item.type, secret,
          ...(item.authorizationServicesEnabled ? { authorizationServicesEnabled: true } : {}) });
        const stored = await readClientSecret(path);
        if (stored?.value !== secret) fail();
        await write(`${path}/client-secret/rotated`, "DELETE");
      };
    },
  };
}
