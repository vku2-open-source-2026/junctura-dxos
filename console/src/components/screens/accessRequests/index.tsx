// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useCallback, useEffect, useState } from "react";
import { ArrowLeftRight, RefreshCw } from "lucide-react";
import { ApiError, api } from "../../../services/apiClient";
import { useSession } from "../../../services/session";
import { useI18n } from "../../../locales/i18n";
import type {
  AccessRequestState,
  ApiPage,
  CapabilityAccessRequest,
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
const REASON_MAX_LENGTH = 512;

type RequestDirection = "incoming" | "outgoing";

interface DirectionPage {
  items: CapabilityAccessRequest[];
  nextCursor: string | null;
  loaded: boolean;
  loading: boolean;
  error: number | null;
  loadMoreFailed: boolean;
}

const EMPTY_PAGE: DirectionPage = {
  items: [],
  nextCursor: null,
  loaded: false,
  loading: false,
  error: null,
  loadMoreFailed: false,
};

const STATE_VARIANTS: Record<AccessRequestState, BadgeVariant> = {
  pending: "warning",
  accepted: "success",
  declined: "destructive",
  withdrawn: "outline",
};

interface PendingAction {
  requestId: string;
  kind: "accept" | "decline" | "withdraw";
}

export const AccessRequestsScreen: React.FC = () => {
  const { t, language } = useI18n();
  const c = t.accessRequests;
  const { showToast } = useToast();
  const canDecide = useSession().can("core-writer");

  const [tab, setTab] = useState<RequestDirection>("incoming");
  const [pages, setPages] = useState<
    Record<RequestDirection, DirectionPage>
  >({ incoming: EMPTY_PAGE, outgoing: EMPTY_PAGE });

  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const patchPage = (
    direction: RequestDirection,
    update: (previous: DirectionPage) => DirectionPage
  ) => {
    setPages((previous) => ({
      ...previous,
      [direction]: update(previous[direction]),
    }));
  };

  const load = useCallback(
    async (direction: RequestDirection) => {
      patchPage(direction, (previous) => ({
        ...previous,
        loading: true,
        error: null,
        loadMoreFailed: false,
      }));
      try {
        const page = await api.listCapabilityAccessRequests({
          direction,
          limit: PAGE_LIMIT,
        });
        patchPage(direction, (previous) => ({
          ...previous,
          items: page.items,
          nextCursor: page.nextCursor,
          loaded: true,
        }));
      } catch (failure) {
        patchPage(direction, (previous) => ({
          ...previous,
          items: [],
          nextCursor: null,
          loaded: true,
          error: failure instanceof ApiError ? failure.status : 503,
        }));
      } finally {
        patchPage(direction, (previous) => ({
          ...previous,
          loading: false,
        }));
      }
    },
    []
  );

  const loadMore = useCallback(
    async (direction: RequestDirection) => {
      const cursor = pages[direction].nextCursor;
      if (!cursor) return;
      patchPage(direction, (previous) => ({
        ...previous,
        loadMoreFailed: false,
      }));
      try {
        const page = await api.listCapabilityAccessRequests({
          direction,
          limit: PAGE_LIMIT,
          cursor,
        });
        patchPage(direction, (previous) => ({
          ...previous,
          items: [...previous.items, ...page.items],
          nextCursor: page.nextCursor,
        }));
      } catch {
        patchPage(direction, (previous) => ({
          ...previous,
          loadMoreFailed: true,
        }));
      }
    },
    [pages]
  );

  useEffect(() => {
    void load("incoming");
  }, [load]);

  const switchTab = (direction: RequestDirection) => {
    setTab(direction);
    if (!pages[direction].loaded && !pages[direction].loading) {
      void load(direction);
    }
  };

  const refresh = () => {
    void load(tab);
  };

  const patchRequest = (
    direction: RequestDirection,
    requestId: string,
    update: Partial<CapabilityAccessRequest>
  ) => {
    patchPage(direction, (previous) => ({
      ...previous,
      items: previous.items.map((item) =>
        item.requestId === requestId ? { ...item, ...update } : item
      ),
    }));
  };

  const openAccept = (requestId: string) => {
    setReason("");
    setActionError(null);
    setPendingAction({ requestId, kind: "accept" });
  };

  const openDecline = (requestId: string) => {
    setReason("");
    setActionError(null);
    setPendingAction({ requestId, kind: "decline" });
  };

  const openWithdraw = (requestId: string) => {
    setReason("");
    setActionError(null);
    setPendingAction({ requestId, kind: "withdraw" });
  };

  const closeAction = () => {
    if (submitting) return;
    setPendingAction(null);
    setReason("");
    setActionError(null);
  };

  const confirmAction = async () => {
    const action = pendingAction;
    if (!action) return;
    if (action.kind === "decline" && !reason.trim()) return;
    const direction = tab;
    setSubmitting(true);
    setActionError(null);
    try {
      if (action.kind === "accept") {
        const updated = await api.acceptCapabilityAccessRequest(action.requestId);
        patchRequest(direction, action.requestId, {
          state: updated.state,
          grantId: updated.grantId,
          reason: updated.reason,
          updatedAt: updated.updatedAt,
        });
        showToast(c.acceptDone);
      } else if (action.kind === "decline") {
        const updated = await api.declineCapabilityAccessRequest(
          action.requestId,
          reason.trim()
        );
        patchRequest(direction, action.requestId, {
          state: updated.state,
          reason: updated.reason,
          updatedAt: updated.updatedAt,
        });
        showToast(c.declineDone);
      } else {
        const updated = await api.withdrawCapabilityAccessRequest(
          action.requestId
        );
        patchRequest(direction, action.requestId, {
          state: updated.state,
          updatedAt: updated.updatedAt,
        });
        showToast(c.withdrawDone);
      }
      closeAction();
    } catch {
      setActionError(c.actionError);
    } finally {
      setSubmitting(false);
    }
  };

  const stateLabel = (state: AccessRequestState): string => {
    if (state === "accepted") return c.stateAccepted;
    if (state === "declined") return c.stateDeclined;
    if (state === "withdrawn") return c.stateWithdrawn;
    return c.statePending;
  };

  const page = pages[tab];
  const actionTarget =
    pendingAction !== null
      ? page.items.find((item) => item.requestId === pendingAction.requestId) ??
        null
      : null;

  const renderTable = (
    direction: RequestDirection,
    directionPage: DirectionPage
  ) => {
    if (directionPage.error === 403) {
      return <ForbiddenNotice />;
    }
    if (directionPage.error) {
      return (
        <ErrorState
          title={c.loadErrorTitle}
          message={c.loadErrorDesc}
          onRetry={() => void load(direction)}
        />
      );
    }
    if (directionPage.loading) {
      return (
        <Card>
          <CardContent>
            <p className="sr-only">{t.common.loading}</p>
            <LoadingSkeleton rows={5} />
          </CardContent>
        </Card>
      );
    }
    if (directionPage.items.length === 0) {
      return (
        <Card>
          <CardContent>
            <EmptyState
              title={
                direction === "incoming"
                  ? c.emptyIncomingTitle
                  : c.emptyOutgoingTitle
              }
              description={
                direction === "incoming"
                  ? c.emptyIncomingDesc
                  : c.emptyOutgoingDesc
              }
              icon={<ArrowLeftRight className="h-6 w-6" aria-hidden="true" />}
              actionLabel={t.common.refresh}
              onAction={() => void load(direction)}
            />
          </CardContent>
        </Card>
      );
    }
    return (
      <Card>
        <CardContent className="space-y-4">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-slate-600 dark:text-slate-300">
              <thead className="border-b border-slate-200/80 bg-slate-50 text-sm font-semibold uppercase text-slate-500 dark:border-[#243843] dark:bg-[#1B303B]/40 dark:text-slate-400">
                <tr>
                  {direction === "incoming" ? (
                    <th className="px-4 py-3">{c.colRequester}</th>
                  ) : (
                    <th className="px-4 py-3">{c.colProvider}</th>
                  )}
                  <th className="px-4 py-3">{c.colCapability}</th>
                  <th className="px-4 py-3">{c.colPurpose}</th>
                  <th className="px-4 py-3">{c.colState}</th>
                  <th className="px-4 py-3">{c.colSent}</th>
                  <th className="px-4 py-3 text-right">{c.colActions}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-[#243843]/70">
                {directionPage.items.map((item) => {
                  const canAccept =
                    direction === "incoming" &&
                    item.state === "pending" &&
                    canDecide;
                  const canWithdraw =
                    direction === "outgoing" &&
                    item.state === "pending" &&
                    canDecide;
                  return (
                    <tr
                      key={item.requestId}
                      className="transition-colors hover:bg-slate-50/80 dark:hover:bg-[#1B303B]/30"
                    >
                      <td className="px-4 py-3 font-mono text-xs">
                        {direction === "incoming"
                          ? item.consumerAppId
                          : item.providerAppId}
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-mono text-xs text-stone-ink dark:text-slate-100">
                          {item.capabilityId}
                        </p>
                        <p className="mt-0.5 font-mono text-xs text-slate-500 dark:text-slate-400">
                          {item.version}
                        </p>
                      </td>
                      <td className="max-w-xs px-4 py-3 text-sm">
                        {item.purpose}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={STATE_VARIANTS[item.state]}>
                          {stateLabel(item.state)}
                        </Badge>
                        {item.state === "declined" && item.reason && (
                          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                            {c.declineReasonPrefix}
                            {item.reason}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {formatDate(item.createdAt, language)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="inline-flex justify-end gap-2">
                          {canAccept && (
                            <Button
                              size="sm"
                              onClick={() => openAccept(item.requestId)}
                            >
                              {c.acceptButton}
                            </Button>
                          )}
                          {canAccept && (
                            <Button
                              size="sm"
                              variant="destructive"
                              onClick={() => openDecline(item.requestId)}
                            >
                              {c.declineButton}
                            </Button>
                          )}
                          {canWithdraw && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => openWithdraw(item.requestId)}
                            >
                              {c.withdrawButton}
                            </Button>
                          )}
                          {!canAccept && !canWithdraw && (
                            <span
                              className="text-xs text-slate-400 dark:text-slate-500"
                              aria-hidden="true"
                            >
                              —
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {directionPage.loadMoreFailed && (
            <ErrorState
              title={c.loadMoreErrorTitle}
              message={c.loadMoreErrorDesc}
              onRetry={() => void loadMore(direction)}
            />
          )}
          {directionPage.nextCursor && (
            <div className="flex justify-center">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void loadMore(direction)}
              >
                {c.nextPage}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    );
  };

  const tabButton = (direction: RequestDirection, label: string) => {
    const active = tab === direction;
    return (
      <button
        key={direction}
        type="button"
        role="tab"
        aria-selected={active}
        onClick={() => switchTab(direction)}
        className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
          active
            ? "bg-[var(--accent-soft)] font-semibold text-[var(--accent)]"
            : "text-slate-500 hover:bg-[var(--accent-soft)]/60 hover:text-[var(--text)] dark:text-slate-400"
        }`}
      >
        {label}
      </button>
    );
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
            onClick={refresh}
            isLoading={page.loading}
            leftIcon={<RefreshCw className="w-3.5 h-3.5" />}
          >
            {t.common.refresh}
          </Button>
        }
      />

      <div
        role="tablist"
        aria-label={c.tabsLabel}
        className="flex gap-1 rounded-lg border border-[var(--border)] bg-[var(--card)] p-1 w-fit"
      >
        {tabButton("incoming", c.tabIncoming)}
        {tabButton("outgoing", c.tabOutgoing)}
      </div>

      {renderTable(tab, page)}

      <ConfirmationDialog
        isOpen={pendingAction !== null && actionTarget !== null}
        title={
          pendingAction?.kind === "accept"
            ? c.acceptTitle
            : pendingAction?.kind === "decline"
              ? c.declineTitle
              : c.withdrawTitle
        }
        description={
          pendingAction?.kind === "accept"
            ? c.acceptDesc
            : pendingAction?.kind === "decline"
              ? c.declineDesc
              : c.withdrawDesc
        }
        confirmLabel={
          pendingAction?.kind === "accept"
            ? c.acceptButton
            : pendingAction?.kind === "decline"
              ? c.declineButton
              : c.withdrawButton
        }
        cancelLabel={t.common.cancel}
        variant={
          pendingAction?.kind === "accept"
            ? "info"
            : pendingAction?.kind === "decline"
              ? "warning"
              : "danger"
        }
        isLoading={submitting}
        confirmDisabled={pendingAction?.kind === "decline" && !reason.trim()}
        onCancel={closeAction}
        onConfirm={() => {
          void confirmAction();
        }}
      >
        {actionTarget && pendingAction?.kind === "decline" && (
          <div className="space-y-3">
            <div>
              <p className="font-mono text-xs text-slate-500 dark:text-slate-400">
                {actionTarget.capabilityId} · {actionTarget.version}
              </p>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                {actionTarget.purpose}
              </p>
            </div>
            <div>
              <label
                htmlFor="access-request-decline-reason"
                className="mb-1 block text-sm font-semibold text-stone-ink dark:text-slate-200"
              >
                {c.reasonLabel}
              </label>
              <textarea
                id="access-request-decline-reason"
                rows={3}
                maxLength={REASON_MAX_LENGTH}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder={c.reasonPlaceholder}
                className="w-full rounded border border-slate-200 bg-white px-3 py-1.5 text-sm text-stone-ink focus:outline-none focus:ring-1 focus:ring-junctura-blue dark:border-[#243843] dark:bg-[#13242D] dark:text-slate-100"
              />
            </div>
          </div>
        )}
        {actionTarget && pendingAction?.kind === "withdraw" && (
          <div>
            <p className="font-mono text-xs text-slate-500 dark:text-slate-400">
              {actionTarget.capabilityId} · {actionTarget.version}
            </p>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
              {actionTarget.purpose}
            </p>
          </div>
        )}
        {actionError && (
          <p
            role="alert"
            className="mt-3 rounded border border-rose-200 bg-rose-50 px-2.5 py-2 text-sm text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-300"
          >
            {actionError}
          </p>
        )}
      </ConfirmationDialog>
    </div>
  );
};
