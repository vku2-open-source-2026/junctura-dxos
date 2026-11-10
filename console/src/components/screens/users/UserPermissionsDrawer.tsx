// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import type { DirectoryPrincipal } from "../../../types";
import { useI18n } from "../../../locales/i18n";
import { Badge } from "../../common/Badge";
import { DetailDrawer } from "../../common/DetailDrawer";
import { groupPermissions, organizationOf } from "./userMeta";

interface UserPermissionsDrawerProps {
  principal: DirectoryPrincipal | null;
  name: string;
  onClose: () => void;
}

export const UserPermissionsDrawer: React.FC<UserPermissionsDrawerProps> = ({
  principal,
  name,
  onClose,
}) => {
  const { t } = useI18n();
  const u = t.users;
  const permissionNames = u.permissionNames as Record<string, string>;
  const kindLabel = principal
    ? principal.kind === "admin"
      ? u.kindAdmin
      : principal.kind === "application"
        ? u.kindApplication
        : u.kindUnknown
    : "";

  return (
    <DetailDrawer
      isOpen={principal !== null}
      onClose={onClose}
      title={u.permissionsDrawerTitle}
      subtitle={name}
    >
      {principal && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="default">{kindLabel}</Badge>
            <Badge variant={principal.enabled ? "success" : "outline"}>
              {principal.enabled ? u.statusEnabled : u.statusDisabled}
            </Badge>
          </div>
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-[var(--muted)]">{u.tableUnit}</dt>
              <dd className="mt-0.5 text-[var(--text)]">
                {organizationOf(principal, u.noOrganization)}
              </dd>
            </div>
            {principal.jobTitle && (
              <div>
                <dt className="text-xs text-[var(--muted)]">{u.tableRole}</dt>
                <dd className="mt-0.5 text-[var(--text)]">
                  {principal.jobTitle}
                </dd>
              </div>
            )}
          </dl>
          <div>
            <h4 className="text-sm font-semibold text-[var(--text)]">
              {u.tablePermissions}
            </h4>
            {principal.permissions.length === 0 ? (
              <p className="mt-1 text-sm text-[var(--muted)]">
                {u.noPermissionsHint}
              </p>
            ) : (
              <p className="mt-1 text-xs text-[var(--muted)]">
                {u.permissionsCount.replace(
                  "{n}",
                  String(principal.permissions.length)
                )}
              </p>
            )}
            <div className="mt-3 space-y-4">
              {groupPermissions(principal.permissions).map(
                ({ group, permissions }) => (
                  <section key={group}>
                    <h5 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
                      {u.permissionGroups[group]}
                    </h5>
                    <ul className="mt-1.5 space-y-1.5">
                      {permissions.map((permission) => (
                        <li
                          key={permission}
                          className="rounded-md border border-[var(--border)] px-2.5 py-1.5 text-sm text-[var(--text)]"
                        >
                          {permissionNames[permission] ?? permission}
                        </li>
                      ))}
                    </ul>
                  </section>
                )
              )}
            </div>
          </div>
        </div>
      )}
    </DetailDrawer>
  );
};
