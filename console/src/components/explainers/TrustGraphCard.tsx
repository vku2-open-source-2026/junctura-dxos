// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Loads the trust graph through the API client and renders TrustGraphView.
import React, { useCallback, useEffect, useState } from "react";
import type { TrustGraph, TrustGraphEdge } from "../../types";
import { api } from "../../services/apiClient";
import { useI18n } from "../../locales/i18n";
import { TrustGraphView } from "./TrustGraphView";
import { TRUST_GRAPH_STRINGS } from "./trustGraph.i18n";

export const TrustGraphCard: React.FC<{ canRevoke?: boolean; onChanged?: () => void }> = ({ canRevoke = false, onChanged }) => {
  const { language } = useI18n();
  const s = TRUST_GRAPH_STRINGS[language];
  const [graph, setGraph] = useState<TrustGraph | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      setGraph(await api.getTrustGraph());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
    return api.subscribe(() => void load());
  }, [load]);

  const revoke = async (edge: TrustGraphEdge, reason: string) => {
    await api.revokeTrustGrant(edge, reason);
    await load();
    onChanged?.();
  };

  return (
    <section className="rounded-md border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900/40">
      <h3 className="mb-1 text-lg font-semibold text-slate-900 dark:text-slate-100">{s.title}</h3>
      {failed ? (
        <p role="alert" className="py-8 text-center text-sm text-rose-700 dark:text-rose-300">
          {language === "vi" ? "Chưa tải được sơ đồ. Thử lại sau." : "Could not load the map. Try again later."}
        </p>
      ) : graph ? (
        <TrustGraphView graph={graph} canRevoke={canRevoke} onRevoke={revoke} />
      ) : (
        <div className="h-72 animate-pulse rounded-md bg-slate-100 dark:bg-slate-800" />
      )}
    </section>
  );
};

export default TrustGraphCard;
