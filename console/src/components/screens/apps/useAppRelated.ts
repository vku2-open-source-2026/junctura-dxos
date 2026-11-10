// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";
import type {
  Application,
  AuditEventEntry,
  CapabilityVersion,
  DirectoryPrincipal,
  StorageSummary,
} from "../../../types";
import { api } from "../../../services/apiClient";
import { useSession } from "../../../services/session";

export interface AppRelatedData {
  capabilities: CapabilityVersion[];
  storage: StorageSummary | null;
  audit: AuditEventEntry[];
  principals: DirectoryPrincipal[];
  loading: boolean;
  storageError: boolean;
}

const EMPTY: AppRelatedData = {
  capabilities: [],
  storage: null,
  audit: [],
  principals: [],
  loading: false,
  storageError: false,
};

export function useAppRelated(application: Application | null): AppRelatedData {
  const { can } = useSession();
  const canReadAudit = can("audit.read");
  const [data, setData] = useState<AppRelatedData>(EMPTY);

  useEffect(() => {
    if (!application) {
      setData(EMPTY);
      return;
    }
    let cancelled = false;
    setData({ ...EMPTY, loading: true });
    const optional = <T,>(promise: Promise<T>, fallback: T) =>
      promise.catch(() => fallback);
    void Promise.all([
      optional(api.getCapabilities(), [] as CapabilityVersion[]),
      optional(api.getStorageSummary(), null as StorageSummary | null),
      canReadAudit
        ? optional(api.getAuditEvents({ limit: 100 }), {
            items: [],
            nextCursor: null,
          })
        : Promise.resolve({ items: [], nextCursor: null }),
      canReadAudit
        ? optional(api.getDirectoryPrincipals(), {
            items: [],
            truncated: false,
          })
        : Promise.resolve({ items: [], truncated: false }),
    ]).then(([capabilities, storage, audit, principals]) => {
      if (cancelled) return;
      setData({
        capabilities,
        storage,
        audit: audit.items,
        principals: principals.items,
        loading: false,
        storageError: storage === null,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [application, canReadAudit]);

  return data;
}
