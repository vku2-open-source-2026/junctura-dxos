// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Database, Layers, RefreshCw, ShieldCheck, Table2 } from "lucide-react";
import type {
  StorageCollectionStructure,
  StorageSummary,
} from "../../types";
import { ApiError, api } from "../../services/apiClient";
import { useI18n } from "../../locales/i18n";
import { useSession } from "../../services/session";
import { PageHeader } from "../layout/PageHeader";
import { Button } from "../common/Button";
import { Card, CardContent } from "../common/Card";
import { EmptyState } from "../common/EmptyState";
import { ErrorState } from "../common/ErrorState";
import { LoadingSkeleton } from "../common/LoadingSkeleton";
import { PermissionDenied } from "../common/PermissionDenied";
import { StatCard } from "../common/StatCard";
import {
  CollectionTable,
  type SelectedCollection,
} from "./records/CollectionTable";
import {
  CollectionStructurePanel,
  type StructureStatus,
} from "./records/CollectionStructurePanel";

export const RecordsScreen: React.FC = () => {
  const { t, language } = useI18n();
  const r = t.records;
  const { can } = useSession();
  const allowed = can("audit.read");
  const [summary, setSummary] = useState<StorageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<"permission" | "generic" | null>(null);
  const [selected, setSelected] = useState<SelectedCollection | null>(null);
  const [structure, setStructure] =
    useState<StorageCollectionStructure | null>(null);
  const [structureAppName, setStructureAppName] = useState("");
  const [structureStatus, setStructureStatus] =
    useState<StructureStatus>("idle");
  const structureRequest = useRef(0);

  const numberLocale = language === "vi" ? "vi-VN" : "en-US";
  const number = (value: number) =>
    new Intl.NumberFormat(numberLocale).format(value);
  const dateFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(language === "vi" ? "vi-VN" : "en-US", {
        dateStyle: "short",
        timeStyle: "short",
      }),
    [language]
  );

  const load = useCallback(async () => {
    if (!allowed) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setSummary(await api.getStorageSummary());
    } catch (failure) {
      setSummary(null);
      setError(
        failure instanceof ApiError && failure.status === 403
          ? "permission"
          : "generic"
      );
    } finally {
      setLoading(false);
    }
  }, [allowed]);

  useEffect(() => {
    void load();
    return api.subscribe(() => void load());
  }, [load]);

  const loadStructure = useCallback(
    async (appId: string, name: string, appName: string) => {
      const requestId = ++structureRequest.current;
      setStructureStatus("loading");
      setStructure(null);
      setStructureAppName(appName);
      try {
        const data = await api.getStorageCollections(appId);
        if (requestId !== structureRequest.current) return;
        const match = data.collections.find(
          (collection) => collection.name === name
        );
        setStructure(match ?? null);
        setStructureAppName(data.application.name || appName);
        setStructureStatus("ready");
      } catch (failure) {
        if (requestId !== structureRequest.current) return;
        setStructure(null);
        setStructureStatus(
          failure instanceof ApiError && failure.status === 403
            ? "permission"
            : "error"
        );
      }
    },
    []
  );

  const selectCollection = (appId: string, name: string) => {
    const appName =
      summary?.applications.find((app) => app.id === appId)?.name ?? "";
    setSelected({ appId, name });
    void loadStructure(appId, name, appName);
  };

  const closeStructure = () => {
    structureRequest.current += 1;
    setSelected(null);
    setStructure(null);
    setStructureAppName("");
    setStructureStatus("idle");
  };

  const retryStructure = () => {
    if (!selected) return;
    void loadStructure(
      selected.appId,
      selected.name,
      structureAppName
    );
  };

  const applications = summary?.applications ?? [];
  const withData = applications.filter((app) => app.collections.length > 0);
  const totals = summary?.totals.collections ?? [];
  const totalRecords = totals.reduce(
    (sum, collection) => sum + collection.records,
    0
  );
  const maxRecords = Math.max(
    1,
    ...applications.flatMap((app) =>
      app.collections.map((collection) => collection.records)
    )
  );

  const collectionLabel = (name: string): string => {
    const names = r.collectionNames as Record<string, string>;
    return (
      names[name] ??
      name
        .split(/[-_]/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ")
    );
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={r.title}
        subtitle={r.subtitle}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load()}
            isLoading={loading}
            leftIcon={<RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
          >
            {t.common.refresh}
          </Button>
        }
      />

      {!allowed ? (
        <Card>
          <CardContent>
            <PermissionDenied actionName={r.title} requiredRole="audit.read" />
          </CardContent>
        </Card>
      ) : error ? (
        <ErrorState
          title={
            error === "permission" ? r.permissionDeniedTitle : r.loadErrorTitle
          }
          message={
            error === "permission" ? r.permissionDeniedDesc : r.loadErrorDesc
          }
          onRetry={() => void load()}
        />
      ) : loading && !summary ? (
        <Card>
          <CardContent>
            <p className="sr-only">{r.loading}</p>
            <LoadingSkeleton rows={6} />
          </CardContent>
        </Card>
      ) : !summary ? (
        <Card>
          <CardContent>
            <EmptyState
              title={r.emptyTitle}
              description={r.emptyDesc}
              icon={<Database className="h-6 w-6" aria-hidden="true" />}
            />
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard
              title={r.statApplications}
              value={number(withData.length)}
              subtitle={r.statApplicationsHint}
              icon={<Database className="h-4 w-4" aria-hidden="true" />}
            />
            <StatCard
              title={r.statCollections}
              value={number(totals.length)}
              subtitle={r.statCollectionsHint}
              icon={<Layers className="h-4 w-4" aria-hidden="true" />}
            />
            <StatCard
              title={r.statRecords}
              value={number(totalRecords)}
              subtitle={r.statRecordsHint}
              icon={<Table2 className="h-4 w-4" aria-hidden="true" />}
            />
          </div>

          <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
            <Card className="min-w-0">
              <CardContent className="space-y-4">
                <div className="flex items-start gap-2 rounded-md border border-[var(--border)] bg-[var(--accent-soft)]/40 px-3 py-2 text-sm text-[var(--muted)]">
                  <ShieldCheck
                    className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--accent)]"
                    aria-hidden="true"
                  />
                  <p>{r.privacyNote}</p>
                </div>

                {withData.length === 0 ? (
                  <EmptyState
                    title={r.emptyTitle}
                    description={r.emptyDesc}
                    icon={<Database className="h-6 w-6" aria-hidden="true" />}
                  />
                ) : (
                  <CollectionTable
                    applications={withData}
                    number={number}
                    dateFormat={dateFormat}
                    collectionLabel={collectionLabel}
                    maxRecords={maxRecords}
                    selected={selected}
                    onSelect={selectCollection}
                  />
                )}
              </CardContent>
            </Card>

            <CollectionStructurePanel
              status={structureStatus}
              collection={structure}
              appName={structureAppName}
              number={number}
              dateFormat={dateFormat}
              onRetry={retryStructure}
              onClose={closeStructure}
            />
          </div>
        </>
      )}
    </div>
  );
};
