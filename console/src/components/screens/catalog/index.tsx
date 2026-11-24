// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useCallback, useEffect, useState } from "react";
import { LayoutGrid, RefreshCw } from "lucide-react";
import { ApiError, api } from "../../../services/apiClient";
import { useSession } from "../../../services/session";
import { useI18n } from "../../../locales/i18n";
import type {
  CapabilityCatalogItem,
  CatalogAccessState,
  CatalogVisibility,
} from "../../../types";
import { formatDate } from "../apps/format";
import { PageHeader } from "../../layout/PageHeader";
import { Badge, type BadgeVariant } from "../../common/Badge";
import { Button } from "../../common/Button";
import { Card, CardContent } from "../../common/Card";
import { ConfirmationDialog } from "../../common/ConfirmationDialog";
import { EmptyState } from "../../common/EmptyState";
import { ErrorState } from "../../common/ErrorState";
import { ForbiddenNotice } from "../../common/ForbiddenNotice";
import { LoadingSkeleton } from "../../common/LoadingSkeleton";
import { useToast } from "../../common/Toast";

const PAGE_LIMIT = 50;
const PURPOSE_MAX_LENGTH = 512;

const ACCESS_VARIANTS: Record<CatalogAccessState, BadgeVariant> = {
  none: "outline",
  requested: "warning",
  granted: "success",
};

export const CatalogScreen: React.FC = () => {
  const { t, language } = useI18n();
  const c = t.catalog;
  const { showToast } = useToast();
  const canRequest = useSession().can("core-writer");

  const [items, setItems] = useState<CapabilityCatalogItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);

  const [requestTarget, setRequestTarget] = useState<CapabilityCatalogItem | null>(
    null
  );
  const [purpose, setPurpose] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setLoadMoreFailed(false);
    try {
      const page = await api.listCapabilityCatalog({ limit: PAGE_LIMIT });
      setItems(page.items);
      setNextCursor(page.nextCursor);
    } catch (failure) {
      setItems([]);
      setNextCursor(null);
      setError(failure instanceof ApiError ? failure.status : 503);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    setLoadMoreFailed(false);
    try {
      const page = await api.listCapabilityCatalog({
        limit: PAGE_LIMIT,
        cursor: nextCursor,
      });
      setItems((previous) => [...previous, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch {
      setLoadMoreFailed(true);
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor]);

  const openRequest = (item: CapabilityCatalogItem) => {
    setPurpose("");
    setActionError(null);
    setRequestTarget(item);
  };

  const closeRequest = () => {
    if (submitting) return;
    setRequestTarget(null);
    setPurpose("");
    setActionError(null);
  };

  const submitRequest = async () => {
    const target = requestTarget;
    if (!target) return;
    const trimmed = purpose.trim();
    if (!trimmed || trimmed.length > PURPOSE_MAX_LENGTH) return;
    setSubmitting(true);
    setActionError(null);
    try {
      await api.createCapabilityAccessRequest(
        {
          capabilityId: target.capabilityId,
          version: target.version,
          purpose: trimmed,
        },
        crypto.randomUUID()
      );
      setItems((previous) =>
        previous.map((item) =>
          item.capabilityId === target.capabilityId &&
          item.version === target.version
            ? { ...item, myAccess: "requested" }
            : item
        )
      );
      showToast(c.requestDone);
      closeRequest();
    } catch {
      setActionError(c.requestError);
    } finally {
      setSubmitting(false);
    }
  };

  const visibilityLabel = (visibility: CatalogVisibility): string => {
    if (visibility === "tenant") return c.visibilityTenant;
    if (visibility === "units") return c.visibilityUnits;
    if (visibility === "applications") return c.visibilityApplications;
    return c.visibilityHidden;
  };

  const accessLabel = (state: CatalogAccessState): string => {
    if (state === "granted") return c.accessGranted;
    if (state === "requested") return c.accessRequested;
    return c.accessNone;
  };

  const accessNote = (state: CatalogAccessState): string | undefined => {
    if (state === "granted") return c.grantedNote;
    if (state === "requested") return c.requestedNote;
    return undefined;
  };

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

      {error === 403 ? (
        <ForbiddenNotice />
      ) : error ? (
        <ErrorState
          title={c.loadErrorTitle}
          message={c.loadErrorDesc}
          onRetry={() => void load()}
        />
      ) : loading ? (
        <Card>
          <CardContent>
            <p className="sr-only">{t.common.loading}</p>
            <LoadingSkeleton rows={5} />
          </CardContent>
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState
              title={c.emptyTitle}
              description={c.emptyDesc}
              icon={<LayoutGrid className="h-6 w-6" aria-hidden="true" />}
              actionLabel={t.common.refresh}
              onAction={() => void load()}
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="space-y-4">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-slate-600 dark:text-slate-300">
                <thead className="border-b border-slate-200/80 bg-slate-50 text-sm font-semibold uppercase text-slate-500 dark:border-[#243843] dark:bg-[#1B303B]/40 dark:text-slate-400">
                  <tr>
                    <th className="px-4 py-3">{c.colName}</th>
                    <th className="px-4 py-3">{c.colProvider}</th>
                    <th className="px-4 py-3">{c.colVersion}</th>
                    <th className="px-4 py-3">{c.colVisibility}</th>
                    <th className="px-4 py-3">{c.colPublished}</th>
                    <th className="px-4 py-3">{c.colAccess}</th>
                    <th className="px-4 py-3 text-right">{c.colActions}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-[#243843]/70">
                  {items.map((item) => (
                    <tr
                      key={`${item.capabilityId}:${item.version}`}
                      className="transition-colors hover:bg-slate-50/80 dark:hover:bg-[#1B303B]/30"
                    >
                      <td className="px-4 py-3">
                        <p className="font-semibold text-stone-ink dark:text-slate-100">
                          {item.title}
                        </p>
                        <p className="mt-0.5 font-mono text-xs text-slate-500 dark:text-slate-400">
                          {item.capabilityId}
                        </p>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">
                        {item.providerAppId}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">
                        {item.version}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="outline">{visibilityLabel(item.visibility)}</Badge>
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {formatDate(item.publishedAt, language)}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={ACCESS_VARIANTS[item.myAccess]}>
                          {accessLabel(item.myAccess)}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {canRequest ? (
                          <Button
                            size="sm"
                            onClick={() => openRequest(item)}
                            disabled={item.myAccess !== "none"}
                            title={accessNote(item.myAccess)}
                          >
                            {c.requestButton}
                          </Button>
                        ) : (
                          <span
                            className="text-xs text-slate-400 dark:text-slate-500"
                            aria-hidden="true"
                          >
                            —
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {loadMoreFailed && (
              <ErrorState
                title={c.loadMoreErrorTitle}
                message={c.loadMoreErrorDesc}
                onRetry={() => void loadMore()}
              />
            )}
            {nextCursor && (
              <div className="flex justify-center">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void loadMore()}
                  isLoading={loadingMore}
                >
                  {c.nextPage}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <ConfirmationDialog
        isOpen={requestTarget !== null}
        title={c.requestTitle}
        description={c.requestDesc}
        confirmLabel={c.requestConfirm}
        cancelLabel={t.common.cancel}
        variant="info"
        isLoading={submitting}
        confirmDisabled={!purpose.trim()}
        onCancel={closeRequest}
        onConfirm={() => {
          void submitRequest();
        }}
      >
        {requestTarget && (
          <div className="space-y-3">
            <div>
              <p className="text-sm font-semibold text-stone-ink dark:text-slate-100">
                {requestTarget.title}
              </p>
              <p className="mt-0.5 font-mono text-xs text-slate-500 dark:text-slate-400">
                {requestTarget.capabilityId} · {requestTarget.version}
              </p>
            </div>
            <div>
              <label
                htmlFor="catalog-request-purpose"
                className="mb-1 block text-sm font-semibold text-stone-ink dark:text-slate-200"
              >
                {c.requestPurposeLabel}
              </label>
              <textarea
                id="catalog-request-purpose"
                rows={3}
                maxLength={PURPOSE_MAX_LENGTH}
                value={purpose}
                onChange={(event) => setPurpose(event.target.value)}
                placeholder={c.requestPurposePlaceholder}
                className="w-full rounded border border-slate-200 bg-white px-3 py-1.5 text-sm text-stone-ink focus:outline-none focus:ring-1 focus:ring-junctura-blue dark:border-[#243843] dark:bg-[#13242D] dark:text-slate-100"
              />
            </div>
            {actionError && (
              <p
                role="alert"
                className="rounded border border-rose-200 bg-rose-50 px-2.5 py-2 text-sm text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-300"
              >
                {actionError}
              </p>
            )}
          </div>
        )}
      </ConfirmationDialog>
    </div>
  );
};
