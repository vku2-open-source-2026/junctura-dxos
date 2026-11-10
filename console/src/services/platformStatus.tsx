// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "./apiClient";
import type { HealthStatus, ReadyStatus } from "../types";
import {
  PLATFORM_FUNCTION_IDS,
  type PlatformFunctionId,
} from "../constants/platformFunctions";

export type PlatformStatus = "ready" | "degraded" | "error" | "unknown";

export type PlatformStatuses = Record<PlatformFunctionId, PlatformStatus>;

export interface PlatformServicesContextValue {
  checking: boolean;
  checkedAt: Date | null;
  statuses: PlatformStatuses;
  health: HealthStatus | null;
  ready: ReadyStatus | null;
  refresh: () => Promise<void>;
  aggregate: PlatformStatus;
  readyCount: number;
}

const PlatformServicesContext =
  createContext<PlatformServicesContextValue | null>(null);

function aggregateStatus(
  health: HealthStatus | null,
  ready: ReadyStatus | null
): PlatformStatus {
  if (health?.status === "error") return "error";
  if (ready?.status === "not_ready") return "degraded";
  if (ready?.status === "unknown") return "unknown";
  if (health?.status === "ok" && ready?.status === "ready") return "ready";
  if (health?.status === "degraded") return "degraded";
  return "unknown";
}

export const PlatformServicesProvider: React.FC<{
  children: React.ReactNode;
}> = ({ children }) => {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [ready, setReady] = useState<ReadyStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    setChecking(true);
    const [nextHealth, nextReady] = await Promise.all([
      api.getHealth(),
      api.getReady(),
    ]);
    if (!mounted.current) return;
    setHealth(nextHealth);
    setReady(nextReady);
    setChecking(false);
    setCheckedAt(new Date());
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  const aggregate = useMemo(
    () => aggregateStatus(health, ready),
    [health, ready]
  );

  const statuses = useMemo<PlatformStatuses>(
    () =>
      PLATFORM_FUNCTION_IDS.reduce(
        (result, id) => ({ ...result, [id]: aggregate }),
        {} as PlatformStatuses
      ),
    [aggregate]
  );

  const value = useMemo<PlatformServicesContextValue>(
    () => ({
      checking,
      checkedAt,
      statuses,
      health,
      ready,
      refresh,
      aggregate,
      readyCount:
        aggregate === "ready" ? PLATFORM_FUNCTION_IDS.length : 0,
    }),
    [checking, checkedAt, statuses, health, ready, refresh, aggregate]
  );

  return (
    <PlatformServicesContext.Provider value={value}>
      {children}
    </PlatformServicesContext.Provider>
  );
};

export function usePlatformServices(): PlatformServicesContextValue {
  const context = useContext(PlatformServicesContext);
  if (!context) {
    throw new Error(
      "usePlatformServices must be used within a PlatformServicesProvider"
    );
  }
  return context;
}
