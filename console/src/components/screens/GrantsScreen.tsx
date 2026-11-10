// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link2, Network, RefreshCw } from "lucide-react";
import type {
  AuditEventEntry,
  DirectoryPrincipal,
  TrustGraph,
  TrustGraphEdge,
} from "../../types";
import { api } from "../../services/apiClient";
import { useI18n } from "../../locales/i18n";
import { useSession } from "../../services/session";
import { useToast } from "../common/Toast";
import { PageHeader } from "../layout/PageHeader";
import { Button } from "../common/Button";
import { Card, CardContent } from "../common/Card";
import { EmptyState } from "../common/EmptyState";
import { ErrorState } from "../common/ErrorState";
import { LoadingSkeleton } from "../common/LoadingSkeleton";
import { SearchFilterBar } from "../common/SearchFilterBar";
import { displayPerson } from "../../services/display";
import {
  approveGrantProposal,
  rejectGrantProposal,
} from "../../services/grantActions";
import { ShareTable, type ShareAction, type ShareRow } from "./grants/ShareTable";
import { ShareTabs, type ShareFilter } from "./grants/ShareTabs";
import { GrantDetailDrawer } from "./grants/GrantDetailDrawer";
import { GrantDecisionDialog } from "./grants/GrantDecisionDialog";
import {
  appName,
  auditByResource,
  capabilityName,
  resolveActors,
  shareStateOf,
  type ShareState,
} from "./grants/shareMeta";

export const GrantsScreen: React.FC = () => {
  const { t, language } = useI18n();
  const g = t.grants;
  const { can, user } = useSession();
  const { showToast } = useToast();
  const canDecide = can("trust.approve");
  const canReadAudit = can("audit.read");

  const [graph, setGraph] = useState<TrustGraph | null>(null);
  const [audit, setAudit] = useState<AuditEventEntry[]>([]);
  const [principals, setPrincipals] = useState<DirectoryPrincipal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<ShareFilter>("all");
  const [detailEdge, setDetailEdge] = useState<TrustGraphEdge | null>(null);
  const [pendingEdge, setPendingEdge] = useState<TrustGraphEdge | null>(null);
  const [pendingAction, setPendingAction] = useState<ShareAction | null>(null);
  const [reason, setReason] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextGraph = await api.getTrustGraph();
      setGraph(nextGraph);
      const optional = <T,>(promise: Promise<T>, fallback: T) =>
        promise.catch(() => fallback);
      const [auditPage, principalPage] = await Promise.all([
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
      ]);
      setAudit(auditPage.items);
      setPrincipals(principalPage.items);
    } catch (failure) {
      const code = failure instanceof Error ? failure.message : "";
      setGraph(null);
      setError(
        code === "trust_permission_required"
          ? g.loadErrorPermission
          : g.loadErrorGeneric
      );
    } finally {
      setLoading(false);
    }
  }, [
    canReadAudit,
    g.loadErrorGeneric,
    g.loadErrorPermission,
  ]);

  useEffect(() => {
    void load();
    return api.subscribe(() => void load());
  }, [load]);

  const names = useMemo(
    () => new Map(graph?.nodes.map((node) => [node.appId, node.displayName]) ?? []),
    [graph]
  );
  const locale = language === "vi" ? "vi-VN" : "en-GB";

  const personName = useCallback(
    (subject: string | null | undefined): string => {
      if (!subject) return "—";
      const principal = principals.find((item) => item.subject === subject);
      return principal?.displayName ?? displayPerson(subject);
    },
    [principals]
  );

  const rows = useMemo<ShareRow[]>(() => {
    const eventsByGrant = auditByResource(audit);
    return (graph?.edges ?? [])
      .map((edge) => ({
        edge,
        state: shareStateOf(edge),
        actors: resolveActors(edge, eventsByGrant.get(edge.grantId) ?? [], personName),
      }))
      .sort(
        (left, right) =>
          Date.parse(right.edge.createdAt) - Date.parse(left.edge.createdAt)
      );
  }, [graph, audit, personName]);

  const counts = useMemo(() => {
    const result: Record<ShareState, number> = {
      pending: 0,
      active: 0,
      rejected: 0,
      revoked: 0,
      expired: 0,
    };
    for (const row of rows) result[row.state] += 1;
    return result;
  }, [rows]);

  const visibleRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (stateFilter !== "all" && row.state !== stateFilter) return false;
      if (!needle) return true;
      return [
        appName(names, row.edge.providerAppId),
        appName(names, row.edge.consumerAppId),
        capabilityName(row.edge),
        row.actors.approver ?? "",
        row.actors.decider ?? "",
        row.actors.reason ?? "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [rows, query, stateFilter, names]);

  const openDecision = (edge: TrustGraphEdge, action: ShareAction) => {
    setPendingEdge(edge);
    setPendingAction(action);
    setReason("");
    setActionError(null);
  };

  const closeDecision = () => {
    if (submitting) return;
    setPendingEdge(null);
    setPendingAction(null);
    setReason("");
    setActionError(null);
  };

  const confirmDecision = async () => {
    if (!pendingEdge || !pendingAction) return;
    const trimmed = reason.trim();
    if (pendingAction !== "approve" && !trimmed) {
      setActionError(g.reasonRequired);
      return;
    }
    setSubmitting(true);
    setActionError(null);
    try {
      if (pendingAction === "approve") {
        await approveGrantProposal(pendingEdge, user?.id ?? "");
        showToast(g.approveDone);
      } else {
        await rejectGrantProposal(pendingEdge, trimmed);
        showToast(
          pendingAction === "reject" ? g.rejectDone : g.revokeDone
        );
      }
      setPendingEdge(null);
      setPendingAction(null);
      setReason("");
      await load();
    } catch {
      setActionError(g.decisionError);
    } finally {
      setSubmitting(false);
    }
  };

  const detailActors = detailEdge
    ? resolveActors(
        detailEdge,
        auditByResource(audit).get(detailEdge.grantId) ?? [],
        personName
      )
    : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title={g.title}
        subtitle={g.subtitle}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <a
              href="#/connect-map"
              className="inline-flex items-center gap-1.5 rounded border border-slate-300 px-2.5 py-1 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800/60"
            >
              <Network className="h-3.5 w-3.5" aria-hidden="true" />
              {g.openMap}
            </a>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void load();
              }}
              isLoading={loading}
              leftIcon={<RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
            >
              {t.common.refresh}
            </Button>
          </div>
        }
      />

      <p className="rounded-md border border-slate-200/80 bg-slate-50 px-3 py-2 text-sm text-slate-600 dark:border-[#243843] dark:bg-[#13242D] dark:text-slate-300">
        {g.lifecycleNote}
      </p>

      {!canDecide && (
        <div className="flex items-start gap-3 rounded-md border border-amber-200/80 bg-amber-50/70 p-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-200">
          <Link2
            className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-400"
            aria-hidden="true"
          />
          <p className="leading-relaxed">{g.permissionHint}</p>
        </div>
      )}

      {error ? (
        <ErrorState
          title={g.loadErrorTitle}
          message={error}
          onRetry={() => {
            void load();
          }}
        />
      ) : loading && !graph ? (
        <Card>
          <CardContent>
            <p className="sr-only">{g.loading}</p>
            <LoadingSkeleton rows={5} />
          </CardContent>
        </Card>
      ) : !graph || graph.edges.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState
              title={g.emptyTitle}
              description={g.emptyDesc}
              icon={<Link2 className="h-6 w-6" aria-hidden="true" />}
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="space-y-4">
            <ShareTabs
              total={rows.length}
              counts={counts}
              value={stateFilter}
              onChange={setStateFilter}
            />

            <SearchFilterBar
              searchQuery={query}
              onSearchChange={setQuery}
              placeholder={g.searchPlaceholder}
              rightAction={
                <span className="text-sm text-slate-500 dark:text-slate-400">
                  {visibleRows.length} {g.countLabel}
                </span>
              }
            />

            {visibleRows.length === 0 ? (
              <EmptyState
                title={g.noResultsTitle}
                description={g.noResultsDesc}
                icon={<Link2 className="h-6 w-6" aria-hidden="true" />}
              />
            ) : (
              <ShareTable
                rows={visibleRows}
                names={names}
                locale={locale}
                canDecide={canDecide}
                onView={setDetailEdge}
                onDecision={openDecision}
              />
            )}
          </CardContent>
        </Card>
      )}

      <GrantDetailDrawer
        edge={detailEdge}
        actors={detailActors}
        names={names}
        locale={locale}
        onClose={() => setDetailEdge(null)}
      />

      <GrantDecisionDialog
        edge={pendingEdge}
        action={pendingAction}
        names={names}
        reason={reason}
        onReasonChange={setReason}
        error={actionError}
        isSubmitting={submitting}
        onConfirm={() => {
          void confirmDecision();
        }}
        onCancel={closeDecision}
      />
    </div>
  );
};
