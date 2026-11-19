// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState } from "react";
import type { FeatureSeries, RecentRequest, TrafficSeries } from "../../../types";
import { ApiError, api } from "../../../services/apiClient";

function useAutoRefresh(load: (silent: boolean) => Promise<void>, refreshMs?: number) {
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    void loadRef.current(false);
    if (!refreshMs) return;
    const timer = window.setInterval(() => {
      void loadRef.current(true);
    }, refreshMs);
    return () => window.clearInterval(timer);
  }, [refreshMs, load]);
}

type LoadError = "generic" | "forbidden" | null;

export function useTrafficSeries(minutes: number, refreshMs?: number) {
  const [series, setSeries] = useState<TrafficSeries | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LoadError>(null);
  const requestId = useRef(0);

  const load = useCallback(
    async (silent = false) => {
      const current = ++requestId.current;
      if (!silent) setLoading(true);
      setError(null);
      try {
        const next = await api.getTrafficSeries(minutes);
        if (current === requestId.current) setSeries(next);
      } catch (failure) {
        if (current === requestId.current) {
          setSeries(null);
          setError(
            failure instanceof ApiError && failure.status === 403
              ? "forbidden"
              : "generic"
          );
        }
      } finally {
        if (current === requestId.current) setLoading(false);
      }
    },
    [minutes]
  );

  useAutoRefresh(load, refreshMs);

  return { series, loading, error, refresh: () => void load() };
}

export function useFeatureSeries(minutes: number, refreshMs?: number) {
  const [series, setSeries] = useState<FeatureSeries | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LoadError>(null);
  const requestId = useRef(0);

  const load = useCallback(
    async (silent = false) => {
      const current = ++requestId.current;
      if (!silent) setLoading(true);
      setError(null);
      try {
        const next = await api.getFeatureSeries(minutes);
        if (current === requestId.current) setSeries(next);
      } catch (failure) {
        if (current === requestId.current) {
          setSeries(null);
          setError(
            failure instanceof ApiError && failure.status === 403
              ? "forbidden"
              : "generic"
          );
        }
      } finally {
        if (current === requestId.current) setLoading(false);
      }
    },
    [minutes]
  );

  useAutoRefresh(load, refreshMs);

  return { series, loading, error, refresh: () => void load() };
}

export function useRecentRequests(limit: number, refreshMs?: number) {
  const [items, setItems] = useState<RecentRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LoadError>(null);
  const requestId = useRef(0);

  const load = useCallback(
    async (silent = false) => {
      const current = ++requestId.current;
      if (!silent) setLoading(true);
      setError(null);
      try {
        const next = await api.getRecentRequests(limit);
        if (current === requestId.current) setItems(next);
      } catch (failure) {
        if (current === requestId.current) {
          setItems([]);
          setError(
            failure instanceof ApiError && failure.status === 403
              ? "forbidden"
              : "generic"
          );
        }
      } finally {
        if (current === requestId.current) setLoading(false);
      }
    },
    [limit]
  );

  useAutoRefresh(load, refreshMs);

  return { items, loading, error, refresh: () => void load() };
}
