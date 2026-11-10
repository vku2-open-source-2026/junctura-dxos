// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import type { AuditEventEntry, AuditVerification } from "../../types";
import { api } from "../../services/apiClient";
import { useI18n } from "../../locales/i18n";
import { PageHeader } from "../layout/PageHeader";
import { Button } from "../common/Button";
import { ErrorState } from "../common/ErrorState";
import { useToast } from "../common/Toast";
import { AuditTable } from "./audit/AuditTable";
import { IntegrityCard } from "./audit/IntegrityCard";
import {
  buildAuditRows,
  filterAuditRows,
  type RangeFilter,
  type ResultFilter,
} from "./audit/auditRows";

export const SecurityActivityScreen: React.FC = () => {
  const { t, language } = useI18n();
  const { showToast } = useToast();
  const a = t.audit;

  const [entries, setEntries] = useState<AuditEventEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState("");
  const [resultFilter, setResultFilter] = useState<ResultFilter>("all");
  const [rangeFilter, setRangeFilter] = useState<RangeFilter>("7d");

  const [verification, setVerification] = useState<AuditVerification | null>(
    null
  );
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const numberLocale = language === "vi" ? "vi-VN" : "en-GB";

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const page = await api.getAuditEvents({ limit: 100 });
      setEntries(page.items);
    } catch {
      setEntries([]);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => buildAuditRows(entries), [entries]);
  const filtered = useMemo(
    () => filterAuditRows(rows, query, resultFilter, rangeFilter),
    [rows, query, resultFilter, rangeFilter]
  );

  const runVerification = async () => {
    setVerifying(true);
    setVerifyError(null);
    try {
      setVerification(await api.verifyAuditChain());
    } catch (error) {
      setVerification(null);
      const code = error instanceof Error ? error.message : "";
      setVerifyError(
        code === "audit_permission_required" || code === "forbidden"
          ? a.permissionError
          : a.errorGeneric
      );
    } finally {
      setVerifying(false);
    }
  };

  const resultLabel = (result: string) =>
    (a as Record<string, string>)[`result_${result}`] ?? result;

  const exportCsv = () => {
    if (filtered.length === 0) {
      showToast(a.exportEmpty);
      return;
    }
    if (typeof URL.createObjectURL !== "function") {
      showToast(a.exportError);
      return;
    }
    const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const header = [
      a.colTime,
      a.colActor,
      a.colAction,
      a.colTarget,
      a.colResult,
    ];
    const lines = filtered.map((row) =>
      [
        new Date(row.timestamp).toLocaleString(numberLocale),
        row.actor,
        row.action,
        row.target,
        resultLabel(row.result),
      ].map(escape)
    );
    const csv =
      "\uFEFF" +
      [header.map(escape), ...lines].map((cells) => cells.join(",")).join("\r\n");
    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8;" })
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `audit-events-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast(a.exported.replace("{n}", String(filtered.length)));
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={a.title}
        subtitle={a.subtitle}
        actions={
          <>
            <Button
              variant="outline"
              size="md"
              onClick={() => void load()}
              isLoading={loading}
              leftIcon={<RefreshCw className="w-4 h-4" />}
            >
              {t.common.refresh}
            </Button>
            <Button
              variant="outline"
              size="md"
              onClick={exportCsv}
              leftIcon={<Download className="w-4 h-4" />}
            >
              {a.exportCsv}
            </Button>
          </>
        }
      />

      <IntegrityCard
        verification={verification}
        verifying={verifying}
        error={verifyError}
        numberLocale={numberLocale}
        onVerify={runVerification}
      />

      {loadError ? (
        <ErrorState message={a.errorGeneric} onRetry={() => void load()} />
      ) : (
        <AuditTable
          rows={filtered}
          query={query}
          onQueryChange={setQuery}
          resultFilter={resultFilter}
          onResultChange={setResultFilter}
          rangeFilter={rangeFilter}
          onRangeChange={setRangeFilter}
          numberLocale={numberLocale}
          loading={loading}
        />
      )}
    </div>
  );
};
