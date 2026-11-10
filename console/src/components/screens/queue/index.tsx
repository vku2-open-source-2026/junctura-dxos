// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useMemo, useState } from "react";
import { Inbox, RefreshCw } from "lucide-react";
import { useI18n } from "../../../locales/i18n";
import { usePendingApprovals } from "../../../services/pendingApprovals";
import { PageHeader } from "../../layout/PageHeader";
import { Card, CardContent } from "../../common/Card";
import { Button } from "../../common/Button";
import { EmptyState } from "../../common/EmptyState";
import { ErrorState } from "../../common/ErrorState";
import { LoadingSkeleton } from "../../common/LoadingSkeleton";
import { useToast } from "../../common/Toast";
import { QueueList } from "./QueueList";
import { QueueItemDetail } from "./QueueItemDetail";
import { QueueDecisionDialog } from "./QueueDecisionDialog";
import type { Decision, QueueFilter } from "./item";

export const QueueScreen: React.FC = () => {
  const { t } = useI18n();
  const q = t.queue;
  const { showToast } = useToast();
  const {
    items,
    loading,
    error,
    refresh,
    isSelf,
    canApprove,
    approve,
    reject,
  } = usePendingApprovals();

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<QueueFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [reason, setReason] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const selected = items.find((item) => item.id === selectedId) ?? null;

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((item) => {
      if (filter !== "all" && item.kind !== filter) return false;
      if (!needle) return true;
      const haystack =
        item.kind === "application"
          ? [item.displayName, item.appId]
          : [
              item.grant.title ?? "",
              item.grant.capabilityId,
              item.grant.providerAppId,
              item.grant.consumerAppId,
            ];
      return haystack.join(" ").toLowerCase().includes(needle);
    });
  }, [items, filter, query]);

  const openDecision = (next: Decision) => {
    setActionError(null);
    setReason("");
    setDecision(next);
  };

  const closeDecision = () => {
    if (isSubmitting) return;
    setDecision(null);
    setReason("");
    setActionError(null);
  };

  const handleConfirm = async () => {
    if (!selected || !decision) return;
    if (decision === "reject" && !reason.trim()) {
      setActionError(q.reasonRequired);
      return;
    }
    setIsSubmitting(true);
    setActionError(null);
    try {
      if (decision === "approve") {
        await approve(selected);
        showToast(q.approveDone);
      } else {
        await reject(selected, reason.trim());
        showToast(q.rejectDone);
      }
      setDecision(null);
      setReason("");
      setSelectedId(null);
    } catch {
      setActionError(q.actionError);
    } finally {
      setIsSubmitting(false);
    }
  };

  const selectedSelf = selected ? isSelf(selected) : false;
  const selectedCanApprove = selected ? canApprove(selected) : false;

  return (
    <div className="space-y-6">
      <PageHeader
        title={q.title}
        subtitle={q.subtitle}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void refresh();
            }}
            isLoading={loading}
            leftIcon={<RefreshCw className="w-3.5 h-3.5" />}
          >
            {t.common.refresh}
          </Button>
        }
      />

      {error ? (
        <ErrorState
          title={q.errorTitle}
          message={q.errorDesc}
          onRetry={() => {
            void refresh();
          }}
        />
      ) : loading ? (
        <Card>
          <CardContent>
            <p className="sr-only">{q.loading}</p>
            <LoadingSkeleton rows={5} />
          </CardContent>
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState
              title={q.emptyTitle}
              description={q.emptyDesc}
              icon={<Inbox className="h-6 w-6" aria-hidden="true" />}
            />
          </CardContent>
        </Card>
      ) : (
        <QueueList
          items={items}
          filtered={filtered}
          query={query}
          onQueryChange={setQuery}
          filter={filter}
          onFilterChange={setFilter}
          selectedId={selectedId}
          onSelect={setSelectedId}
          isSelf={isSelf}
        />
      )}

      <QueueItemDetail
        item={selected}
        self={selectedSelf}
        canApprove={selectedCanApprove}
        onClose={() => setSelectedId(null)}
        onApprove={() => openDecision("approve")}
        onReject={() => openDecision("reject")}
      />

      <QueueDecisionDialog
        item={selected}
        decision={decision}
        reason={reason}
        onReasonChange={setReason}
        actionError={actionError}
        isSubmitting={isSubmitting}
        onCancel={closeDecision}
        onConfirm={() => {
          void handleConfirm();
        }}
      />
    </div>
  );
};
