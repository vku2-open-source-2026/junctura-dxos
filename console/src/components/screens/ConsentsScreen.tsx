// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, RefreshCw, ShieldOff, UserCheck } from "lucide-react";
import type { SubjectConsent } from "../../types";
import { api } from "../../services/apiClient";
import { useI18n } from "../../locales/i18n";
import { useSession } from "../../services/session";
import { PageHeader } from "../layout/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "../common/Card";
import { Badge } from "../common/Badge";
import { Button } from "../common/Button";
import { EmptyState } from "../common/EmptyState";
import { ErrorState } from "../common/ErrorState";
import { LoadingSkeleton } from "../common/LoadingSkeleton";
import { PermissionDenied } from "../common/PermissionDenied";
import { SearchFilterBar } from "../common/SearchFilterBar";
import { StatCard } from "../common/StatCard";

const SOON_MS = 30 * 86_400_000;

export const ConsentsScreen: React.FC = () => {
  const { t, language } = useI18n();
  const c = t.consents;
  const { can } = useSession();

  const [consents, setConsents] = useState<SubjectConsent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState("");

  const numberLocale = language === "vi" ? "vi-VN" : "en-GB";

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      setConsents(await api.getConsents());
    } catch {
      setConsents([]);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const appName = (consent: SubjectConsent) =>
    consent.consumer.displayName ?? consent.consumer.appId;
  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString(numberLocale);

  const activeCount = consents.filter(
    (consent) => consent.state === "active"
  ).length;
  const revokedCount = consents.length - activeCount;
  const expiringSoon = consents.filter(
    (consent) =>
      consent.state === "active" &&
      Date.parse(consent.expiresAt) - Date.now() < SOON_MS
  ).length;

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return consents
      .filter((consent) => {
        if (!needle) return true;
        return [
          appName(consent),
          consent.capabilityId,
          consent.capabilityTitle ?? "",
          consent.purposes.join(" "),
        ]
          .join(" ")
          .toLowerCase()
          .includes(needle);
      })
      .sort((left, right) => {
        if (left.state !== right.state) return left.state === "active" ? -1 : 1;
        return Date.parse(left.expiresAt) - Date.parse(right.expiresAt);
      });
  }, [consents, query, numberLocale]);

  if (!can("audit.read")) {
    return <PermissionDenied actionName={c.title} requiredRole="audit.read" />;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={c.title}
        subtitle={c.subtitle}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load()}
            isLoading={loading}
            leftIcon={<RefreshCw className="w-3.5 h-3.5" />}
          >
            {t.common.refresh}
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard
          title={c.activeCount}
          value={activeCount}
          icon={<CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
        />
        <StatCard
          title={c.revokedCount}
          value={revokedCount}
          icon={<ShieldOff className="h-4 w-4" aria-hidden="true" />}
        />
        <StatCard
          title={c.expiringSoon}
          value={expiringSoon}
          icon={<UserCheck className="h-4 w-4" aria-hidden="true" />}
        />
      </div>

      <SearchFilterBar
        searchQuery={query}
        onSearchChange={setQuery}
        placeholder={c.searchPlaceholder}
      />

      {loadError ? (
        <ErrorState message={t.common.error} onRetry={() => void load()} />
      ) : loading ? (
        <LoadingSkeleton rows={4} />
      ) : visible.length === 0 ? (
        <EmptyState
          title={consents.length === 0 ? c.emptyTitle : c.noMatches}
          description={
            consents.length === 0 ? c.emptyDesc : c.noMatchesDesc
          }
        />
      ) : (
        <div className="space-y-4">
          {visible.map((consent) => (
            <Card key={consent.consentId}>
              <CardHeader>
                <div>
                  <CardTitle>{appName(consent)}</CardTitle>
                  <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
                    {consent.capabilityTitle ?? consent.capabilityId}
                  </p>
                </div>
                <Badge
                  variant={consent.state === "active" ? "teal" : "default"}
                >
                  {consent.state === "active" ? c.stateActive : c.stateRevoked}
                </Badge>
              </CardHeader>
              <CardContent className="min-w-0 space-y-1 text-sm text-slate-600 dark:text-slate-300">
                <p>
                  <span className="text-slate-500 dark:text-slate-400">
                    {c.purposeLabel}:{" "}
                  </span>
                  {consent.purposes.join(", ") || "—"}
                </p>
                <p className="text-slate-500 dark:text-slate-400">
                  {c.expiresLabel}: {formatDate(consent.expiresAt)}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <p className="rounded-md border border-slate-200/80 bg-slate-50 p-3 text-sm leading-relaxed text-slate-500 dark:border-[#243843] dark:bg-[#13242D] dark:text-slate-400">
        {c.privacyNote}
      </p>

      <p className="rounded-md border border-slate-200/80 bg-slate-50 p-3 text-sm leading-relaxed text-slate-500 dark:border-[#243843] dark:bg-[#13242D] dark:text-slate-400">
        {c.readOnlyNote}
      </p>
    </div>
  );
};
