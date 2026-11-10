// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useCallback, useEffect, useState } from "react";
import type { Application, TrustGraph } from "../../types";
import { api } from "../../services/apiClient";
import { useI18n } from "../../locales/i18n";
import { useToast } from "../common/Toast";
import { LoadingSkeleton } from "../common/LoadingSkeleton";
import { ErrorState } from "../common/ErrorState";
import { EmptyState } from "../common/EmptyState";
import { AppList } from "./apps/AppList";
import { AppDetail } from "./apps/AppDetail";
import {
  AppApprovalDialog,
  type AppDecision,
} from "./apps/AppApprovalDialog";
import { AppRevokeDialog } from "./apps/AppRevokeDialog";
import { APPS_LIST_HASH, appDetailHash, useAppsRoute, type AppTab } from "./apps/route";

export const ApplicationsScreen: React.FC = () => {
  const { t, language } = useI18n();
  const { showToast } = useToast();
  const a = t.applications;
  const route = useAppsRoute();

  const [graph, setGraph] = useState<TrustGraph | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [detailApp, setDetailApp] = useState<Application | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<"not_found" | "failed" | null>(
    null
  );
  const [detailNonce, setDetailNonce] = useState(0);

  const [isApprovalOpen, setIsApprovalOpen] = useState(false);
  const [approvalDecision, setApprovalDecision] =
    useState<AppDecision>("approve");
  const [approvalReason, setApprovalReason] = useState("");
  const [isSubmittingApproval, setIsSubmittingApproval] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);

  const [isRevokeOpen, setIsRevokeOpen] = useState(false);
  const [revokeReason, setRevokeReason] = useState("");
  const [isSubmittingRevoke, setIsSubmittingRevoke] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const loadApplications = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      setGraph(await api.getTrustGraph());
    } catch {
      setLoadError(a.loadListFailed);
    } finally {
      setIsLoading(false);
    }
  }, [a.loadListFailed]);

  useEffect(() => {
    void loadApplications();
  }, [loadApplications]);

  useEffect(() => {
    if (!route.appId) {
      setDetailApp(null);
      setDetailError(null);
      setDetailLoading(false);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    api
      .getApplication(route.appId)
      .then((app) => {
        if (cancelled) return;
        setDetailApp(app);
        if (!app) setDetailError("not_found");
      })
      .catch(() => {
        if (!cancelled) setDetailError("failed");
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [route.appId, detailNonce]);

  const openApp = (appId: string) => {
    window.location.hash = appDetailHash(appId);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const backToList = () => {
    window.location.hash = APPS_LIST_HASH;
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const changeTab = (tab: AppTab) => {
    if (!detailApp) return;
    window.location.hash = appDetailHash(detailApp.appId, tab);
    setDetailNonce((value) => value + 1);
  };

  const refreshDetail = async () => {
    if (!detailApp) return;
    setDetailNonce((value) => value + 1);
    await loadApplications();
  };

  const openApproval = (decision: AppDecision) => {
    setApprovalDecision(decision);
    setApprovalReason("");
    setApprovalError(null);
    setIsApprovalOpen(true);
  };

  const handleApproval = async () => {
    if (!detailApp) return;
    const reason = approvalReason.trim();
    if (approvalDecision === "deny" && !reason) {
      setApprovalError(a.rejectReasonRequired);
      return;
    }
    setIsSubmittingApproval(true);
    setApprovalError(null);
    try {
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const approval = await api.createApproval({
        resourceType: "application",
        resourceId: detailApp.appId,
        resourceDigest: detailApp.digest,
        resourceRevision: detailApp.revision,
        requesterSubject: detailApp.ownerSubject,
        requesterAppId: detailApp.appId,
        decision: approvalDecision,
        expiresAt,
      });
      if (approvalDecision === "approve") {
        await api.approveApplication(
          detailApp.appId,
          approval.approvalId,
          detailApp.revision
        );
      } else {
        await api.transitionApplicationState(
          detailApp.appId,
          "revoke",
          reason,
          approval.approvalId,
          detailApp.revision
        );
      }
      await refreshDetail();
      setIsApprovalOpen(false);
      showToast(
        approvalDecision === "approve" ? a.approvalSuccess : a.denySuccess
      );
    } catch {
      setApprovalError(
        approvalDecision === "approve" ? a.approvalFailed : a.stateFailed
      );
    } finally {
      setIsSubmittingApproval(false);
    }
  };

  const openRevoke = () => {
    setRevokeReason("");
    setRevokeError(null);
    setIsRevokeOpen(true);
  };

  const handleRevoke = async () => {
    if (!detailApp) return;
    const reason = revokeReason.trim();
    if (!reason) {
      setRevokeError(a.stateReasonRequired);
      return;
    }
    setIsSubmittingRevoke(true);
    setRevokeError(null);
    try {
      await api.transitionApplicationState(
        detailApp.appId,
        "revoke",
        reason,
        undefined,
        detailApp.revision
      );
      await refreshDetail();
      setIsRevokeOpen(false);
      setRevokeReason("");
      showToast(a.stateSuccess);
    } catch {
      setRevokeError(a.stateFailed);
    } finally {
      setIsSubmittingRevoke(false);
    }
  };

  if (route.appId) {
    if (detailLoading && !detailApp) {
      return (
        <div className="space-y-6">
          <p className="sr-only">{a.loadingList}</p>
          <LoadingSkeleton rows={5} />
        </div>
      );
    }
    if (detailError === "not_found") {
      return (
        <EmptyState
          title={a.detailNotFoundTitle}
          description={a.detailNotFoundDesc}
          actionLabel={a.backToList}
          onAction={backToList}
        />
      );
    }
    if (detailError === "failed" || !detailApp) {
      return (
        <ErrorState
          message={a.detailLoadFailed}
          onRetry={() => setDetailNonce((value) => value + 1)}
        />
      );
    }
    return (
      <>
        <AppDetail
          application={detailApp}
          graph={graph}
          tab={route.tab}
          language={language}
          onBack={backToList}
          onTabChange={changeTab}
          onApprove={() => openApproval("approve")}
          onReject={() => openApproval("deny")}
          onRevoke={openRevoke}
        />
        <AppApprovalDialog
          isOpen={isApprovalOpen}
          application={detailApp}
          decision={approvalDecision}
          reason={approvalReason}
          error={approvalError}
          isSubmitting={isSubmittingApproval}
          onDecisionChange={setApprovalDecision}
          onReasonChange={setApprovalReason}
          onCancel={() => setIsApprovalOpen(false)}
          onConfirm={() => void handleApproval()}
        />
        <AppRevokeDialog
          isOpen={isRevokeOpen}
          appName={detailApp.displayName}
          reason={revokeReason}
          error={revokeError}
          isSubmitting={isSubmittingRevoke}
          onReasonChange={setRevokeReason}
          onConfirm={() => void handleRevoke()}
          onCancel={() => setIsRevokeOpen(false)}
        />
      </>
    );
  }

  return (
    <AppList
      applications={graph?.nodes ?? []}
      isLoading={isLoading}
      error={loadError}
      onOpen={openApp}
      onRetry={() => void loadApplications()}
    />
  );
};
