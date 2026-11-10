// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import type { DirectoryPrincipal } from "../../../types";

export type PermissionGroup =
  | "applications"
  | "sharing"
  | "audit"
  | "data"
  | "identity"
  | "system"
  | "other";

const PERMISSION_GROUPS: Record<string, PermissionGroup> = {
  "applications.write": "applications",
  "applications.approve": "applications",
  "trust.write": "sharing",
  "trust.approve": "sharing",
  "audit.read": "audit",
  "core-reader": "data",
  "core-writer": "data",
  "identity.admin": "identity",
  "system.admin": "system",
};

export const PERMISSION_GROUP_ORDER: PermissionGroup[] = [
  "applications",
  "sharing",
  "audit",
  "data",
  "identity",
  "system",
  "other",
];

export function permissionGroup(permission: string): PermissionGroup {
  return PERMISSION_GROUPS[permission] ?? "other";
}

export function displayNameOf(
  principal: DirectoryPrincipal,
  unnamed: string
): string {
  return principal.displayName?.trim() || unnamed;
}

export function organizationOf(
  principal: DirectoryPrincipal,
  fallback: string
): string {
  return principal.organization?.trim() || fallback;
}

export function groupPermissions(
  permissions: string[]
): Array<{ group: PermissionGroup; permissions: string[] }> {
  const groups = new Map<PermissionGroup, string[]>();
  for (const permission of permissions) {
    const group = permissionGroup(permission);
    const list = groups.get(group) ?? [];
    list.push(permission);
    groups.set(group, list);
  }
  return PERMISSION_GROUP_ORDER.filter((group) => groups.has(group)).map(
    (group) => ({ group, permissions: groups.get(group) ?? [] })
  );
}
