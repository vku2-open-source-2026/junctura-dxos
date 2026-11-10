// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PermId } from "../constants/modules";
import type { TrustGraph, TrustGraphEdge } from "../types";
import { api } from "./apiClient";
import { approveGrantProposal, rejectGrantProposal } from "./grantActions";
import { useSession } from "./session";

export interface PendingApplicationItem {
  id: string;
  kind: "application";
  createdAt: string;
  perm: PermId;
  appId: string;
  displayName: string;
  owned: boolean;
}

export interface PendingGrantItem {
  id: string;
  kind: "grant";
  createdAt: string;
  perm: PermId;
  grant: TrustGraphEdge;
  owned: boolean;
}

export type PendingApprovalItem =
  | PendingApplicationItem
  | PendingGrantItem;

interface PendingApprovalsContextValue {
  items: PendingApprovalItem[];
  loading: boolean;
  error: boolean;
  refresh: () => Promise<void>;
  isSelf: (item: PendingApprovalItem) => boolean;
  canApprove: (item: PendingApprovalItem) => boolean;
  approve: (item: PendingApprovalItem) => Promise<void>;
  reject: (item: PendingApprovalItem, reason: string) => Promise<void>;
}

const PendingApprovalsContext =
  createContext<PendingApprovalsContextValue | null>(null);

function approvalExpiry(now = Date.now()): string {
  return new Date(now + 10 * 60 * 1000).toISOString();
}

function toItems(graph: TrustGraph): PendingApprovalItem[] {
  const ownedApps = new Set(
    graph.nodes.filter((node) => node.owned).map((node) => node.appId)
  );
  const appItems: PendingApplicationItem[] = graph.nodes
    .filter((node) => node.state === "pending")
    .map((node) => ({
      id: `application:${node.appId}`,
      kind: "application",
      createdAt: graph.generatedAt,
      perm: "applications.approve",
      appId: node.appId,
      displayName: node.displayName,
      owned: node.owned,
    }));
  const grantItems: PendingGrantItem[] = graph.edges
    .filter((edge) => edge.state === "pending")
    .map((edge) => ({
      id: `grant:${edge.grantId}`,
      kind: "grant",
      createdAt: edge.createdAt,
      perm: "trust.approve",
      grant: edge,
      owned: ownedApps.has(edge.providerAppId),
    }));
  return [...appItems, ...grantItems].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt)
  );
}

export const PendingApprovalsProvider: React.FC<{
  children: React.ReactNode;
}> = ({ children }) => {
  const { user, can } = useSession();
  const [graph, setGraph] = useState<TrustGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const mounted = useRef(true);

  const load = useCallback(async (showLoading: boolean): Promise<void> => {
    if (showLoading) setLoading(true);
    try {
      const next = await api.getTrustGraph();
      if (!mounted.current) return;
      setGraph(next);
      setError(false);
    } catch {
      if (mounted.current) setError(true);
    } finally {
      if (mounted.current && showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load(true);
    const interval = setInterval(() => {
      void load(false);
    }, 15000);
    const unsubscribeApi = api.subscribe(() => {
      void load(false);
    });
    return () => {
      mounted.current = false;
      clearInterval(interval);
      unsubscribeApi();
    };
  }, [load]);

  const items = useMemo<PendingApprovalItem[]>(
    () => (graph ? toItems(graph) : []),
    [graph]
  );

  const isSelf = useCallback(
    (item: PendingApprovalItem): boolean => item.owned,
    []
  );

  const canApprove = useCallback(
    (item: PendingApprovalItem): boolean => can(item.perm),
    [can]
  );

  const refresh = useCallback(async (): Promise<void> => {
    await load(true);
  }, [load]);

  const approve = useCallback(
    async (item: PendingApprovalItem): Promise<void> => {
      if (!user) throw new Error("no_active_session");
      if (isSelf(item)) throw new Error("self_approval_forbidden");
      if (!canApprove(item)) throw new Error("approval_permission_required");
      if (item.kind === "application") {
        const app = await api.getApplication(item.appId);
        if (!app) throw new Error("application_not_found");
        const approval = await api.createApproval({
          resourceType: "application",
          resourceId: app.appId,
          resourceDigest: app.digest,
          resourceRevision: app.revision,
          requesterSubject: app.ownerSubject,
          requesterAppId: app.appId,
          decision: "approve",
          expiresAt: approvalExpiry(),
        });
        await api.approveApplication(
          app.appId,
          approval.approvalId,
          app.revision
        );
      } else {
        await approveGrantProposal(item.grant, user.id);
      }
      await load(false);
    },
    [user, isSelf, canApprove, load]
  );

  const reject = useCallback(
    async (item: PendingApprovalItem, reason: string): Promise<void> => {
      const trimmed = reason.trim();
      if (!trimmed) throw new Error("reason_required");
      if (!user) throw new Error("no_active_session");
      if (isSelf(item)) throw new Error("self_approval_forbidden");
      if (!canApprove(item)) throw new Error("approval_permission_required");
      if (item.kind === "application") {
        const app = await api.getApplication(item.appId);
        if (!app) throw new Error("application_not_found");
        const approval = await api.createApproval({
          resourceType: "application",
          resourceId: app.appId,
          resourceDigest: app.digest,
          resourceRevision: app.revision,
          requesterSubject: app.ownerSubject,
          requesterAppId: app.appId,
          decision: "deny",
          expiresAt: approvalExpiry(),
        });
        await api.transitionApplicationState(
          app.appId,
          "revoke",
          trimmed,
          approval.approvalId,
          app.revision
        );
      } else {
        await rejectGrantProposal(item.grant, trimmed);
      }
      await load(false);
    },
    [user, isSelf, canApprove, load]
  );

  const value = useMemo<PendingApprovalsContextValue>(
    () => ({
      items,
      loading,
      error,
      refresh,
      isSelf,
      canApprove,
      approve,
      reject,
    }),
    [items, loading, error, refresh, isSelf, canApprove, approve, reject]
  );

  return (
    <PendingApprovalsContext.Provider value={value}>
      {children}
    </PendingApprovalsContext.Provider>
  );
};

export function usePendingApprovals(): PendingApprovalsContextValue {
  const context = useContext(PendingApprovalsContext);
  if (!context) {
    throw new Error(
      "usePendingApprovals must be used within a PendingApprovalsProvider"
    );
  }
  return context;
}
