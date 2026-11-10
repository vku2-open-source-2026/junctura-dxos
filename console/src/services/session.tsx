// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
} from "react";
import type { PermId } from "../constants/modules";
import type { UserIdentity } from "../types";
import { api } from "./apiClient";
import { startLogout } from "./oidc";

export interface SessionUser {
  id: string;
  name: string;
  tenantId: string;
  roles: string[];
  roleName: string;
}

const READER_PERMISSIONS: PermId[] = ["core-reader", "audit.read"];
const WRITER_PERMISSIONS: PermId[] = [
  "core-writer",
  "applications.write",
  "applications.approve",
  "trust.write",
  "trust.approve",
];

export function permissionsFromRoles(roles: readonly string[]): PermId[] {
  const permissions: PermId[] = [];
  const add = (perm: PermId) => {
    if (!permissions.includes(perm)) permissions.push(perm);
  };
  if (roles.includes("core-reader")) READER_PERMISSIONS.forEach(add);
  if (roles.includes("core-writer")) WRITER_PERMISSIONS.forEach(add);
  return permissions;
}

export interface SessionContextValue {
  user: SessionUser | null;
  permissions: PermId[];
  can: (perm?: PermId) => boolean;
  signOut: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

interface SessionProviderProps {
  identity?: UserIdentity;
  children: React.ReactNode;
}

export const SessionProvider: React.FC<SessionProviderProps> = ({
  identity,
  children,
}) => {
  const user = useMemo<SessionUser | null>(() => {
    if (!identity) return null;
    return {
      id: identity.subject,
      name: identity.preferredUsername || identity.subject,
      tenantId: identity.tenantId,
      roles: identity.roles,
      roleName: identity.roles.join(", "),
    };
  }, [identity]);

  const permissions = useMemo<PermId[]>(
    () => permissionsFromRoles(identity?.roles ?? []),
    [identity]
  );

  const can = useCallback(
    (perm?: PermId) => !perm || permissions.includes(perm),
    [permissions]
  );

  const signOut = useCallback(() => {
    api.setToken(null);
    startLogout();
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({ user, permissions, can, signOut }),
    [user, permissions, can, signOut]
  );

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
};

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error("useSession must be used within a SessionProvider");
  }
  return context;
}
