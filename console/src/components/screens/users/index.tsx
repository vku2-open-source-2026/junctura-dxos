// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { KeyRound, RefreshCw, Users } from "lucide-react";
import type { DirectoryPrincipal } from "../../../types";
import { ApiError, api } from "../../../services/apiClient";
import { useSession } from "../../../services/session";
import { useI18n } from "../../../locales/i18n";
import { PageHeader } from "../../layout/PageHeader";
import { Badge } from "../../common/Badge";
import { Button } from "../../common/Button";
import { Card, CardContent } from "../../common/Card";
import { EmptyState } from "../../common/EmptyState";
import { ErrorState } from "../../common/ErrorState";
import { LoadingSkeleton } from "../../common/LoadingSkeleton";
import { SearchFilterBar } from "../../common/SearchFilterBar";
import { displayNameOf, organizationOf } from "./userMeta";
import { UserPermissionsDrawer } from "./UserPermissionsDrawer";

type KindFilter = "all" | "admin" | "application" | "unknown";

const SELECT_CLASS =
  "rounded-md border border-[var(--border)] bg-[var(--card)] px-2.5 py-1.5 text-sm text-[var(--text)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]";

export const UsersScreen: React.FC = () => {
  const { t, language } = useI18n();
  const u = t.users;
  const { user } = useSession();
  const [items, setItems] = useState<DirectoryPrincipal[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<"generic" | "permission" | null>(null);
  const [query, setQuery] = useState("");
  const [orgFilter, setOrgFilter] = useState("all");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [selected, setSelected] = useState<DirectoryPrincipal | null>(null);
  const locale = language === "vi" ? "vi-VN" : "en-US";

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await api.getDirectoryPrincipals();
      setItems(page.items);
      setTruncated(page.truncated);
    } catch (failure) {
      setItems([]);
      setTruncated(false);
      setError(
        failure instanceof ApiError && failure.status === 403
          ? "permission"
          : "generic"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return api.subscribe(() => void load());
  }, [load]);

  const nameFor = useCallback(
    (principal: DirectoryPrincipal) => displayNameOf(principal, u.unnamed),
    [u.unnamed]
  );

  const kindLabel = (principal: DirectoryPrincipal) =>
    principal.kind === "admin"
      ? u.kindAdmin
      : principal.kind === "application"
        ? u.kindApplication
        : u.kindUnknown;

  const organizations = useMemo(() => {
    const values = new Set<string>();
    for (const principal of items) {
      const organization = principal.organization?.trim();
      if (organization) values.add(organization);
    }
    return [...values].sort((a, b) => a.localeCompare(b, locale));
  }, [items, locale]);

  const displayed = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((principal) => {
      const organization = principal.organization?.trim() ?? "";
      if (orgFilter !== "all" && organization !== orgFilter) {
        return false;
      }
      if (kindFilter !== "all" && (principal.kind ?? "unknown") !== kindFilter) {
        return false;
      }
      if (!needle) return true;
      const haystack = [
        nameFor(principal),
        principal.organization ?? "",
        principal.jobTitle ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [items, query, orgFilter, kindFilter, nameFor]);

  const selectedName = selected ? nameFor(selected) : "";

  return (
    <div className="space-y-6">
      <PageHeader
        title={u.title}
        subtitle={u.subtitle}
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

      {error === "permission" ? (
        <ErrorState
          title={u.permissionDeniedTitle}
          message={u.permissionDeniedDesc}
          onRetry={() => void load()}
        />
      ) : error ? (
        <ErrorState
          title={u.loadErrorTitle}
          message={u.loadErrorDesc}
          onRetry={() => void load()}
        />
      ) : loading && items.length === 0 ? (
        <Card>
          <CardContent>
            <p className="sr-only">{u.loading}</p>
            <LoadingSkeleton rows={6} />
          </CardContent>
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState
              title={u.emptyTitle}
              description={u.emptyDesc}
              icon={<Users className="h-6 w-6" aria-hidden="true" />}
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="space-y-4">
            <SearchFilterBar
              searchQuery={query}
              onSearchChange={setQuery}
              placeholder={u.searchPlaceholder}
              filterComponent={
                <div className="flex flex-wrap gap-2">
                  <label className="sr-only" htmlFor="user-org-filter">
                    {u.filterUnit}
                  </label>
                  <select
                    id="user-org-filter"
                    value={orgFilter}
                    onChange={(event) => setOrgFilter(event.target.value)}
                    className={SELECT_CLASS}
                  >
                    <option value="all">{u.allUnits}</option>
                    {organizations.map((organization) => (
                      <option key={organization} value={organization}>
                        {organization}
                      </option>
                    ))}
                  </select>
                  <label className="sr-only" htmlFor="user-kind-filter">
                    {u.filterKind}
                  </label>
                  <select
                    id="user-kind-filter"
                    value={kindFilter}
                    onChange={(event) =>
                      setKindFilter(event.target.value as KindFilter)
                    }
                    className={SELECT_CLASS}
                  >
                    <option value="all">{u.allKinds}</option>
                    <option value="admin">{u.kindAdmin}</option>
                    <option value="application">{u.kindApplication}</option>
                    <option value="unknown">{u.kindUnknown}</option>
                  </select>
                </div>
              }
              rightAction={
                <span className="text-sm text-[var(--muted)]">
                  {u.count.replace(
                    "{n}",
                    new Intl.NumberFormat(locale).format(displayed.length)
                  )}
                </span>
              }
            />

            {displayed.length === 0 ? (
              <EmptyState
                title={u.noMatchesTitle}
                description={u.noMatchesDesc}
                icon={<Users className="h-6 w-6" aria-hidden="true" />}
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[38rem] text-sm">
                  <caption className="sr-only">{u.title}</caption>
                  <thead>
                    <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--muted)]">
                      <th scope="col" className="px-2 py-2 font-semibold">
                        {u.tableUser}
                      </th>
                      <th scope="col" className="px-2 py-2 font-semibold">
                        {u.tableUnit}
                      </th>
                      <th scope="col" className="px-2 py-2 font-semibold">
                        {u.tableKind}
                      </th>
                      <th scope="col" className="px-2 py-2 font-semibold">
                        {u.tableStatus}
                      </th>
                      <th scope="col" className="px-2 py-2 font-semibold">
                        {u.tableAction}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayed.map((principal) => {
                      const isSelf = user?.id === principal.subject;
                      return (
                        <tr
                          key={principal.subject}
                          className="border-b border-[var(--border)]/60 last:border-0"
                        >
                          <td className="px-2 py-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium text-[var(--text)]">
                                {nameFor(principal)}
                              </span>
                              {isSelf && (
                                <Badge variant="junctura">{u.self}</Badge>
                              )}
                            </div>
                            {principal.jobTitle && (
                              <p className="mt-0.5 text-xs text-[var(--muted)]">
                                {principal.jobTitle}
                              </p>
                            )}
                          </td>
                          <td className="px-2 py-3 text-[var(--text)]">
                            {organizationOf(principal, u.noOrganization)}
                          </td>
                          <td className="px-2 py-3">
                            <Badge variant="default">{kindLabel(principal)}</Badge>
                          </td>
                          <td className="px-2 py-3">
                            <Badge
                              variant={principal.enabled ? "success" : "outline"}
                            >
                              {principal.enabled
                                ? u.statusEnabled
                                : u.statusDisabled}
                            </Badge>
                          </td>
                          <td className="px-2 py-3">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setSelected(principal)}
                              leftIcon={
                                <KeyRound
                                  className="h-3.5 w-3.5"
                                  aria-hidden="true"
                                />
                              }
                            >
                              {u.viewPermissions}
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {truncated && (
              <p className="text-sm text-[var(--muted)]">{u.truncated}</p>
            )}
          </CardContent>
        </Card>
      )}

      <UserPermissionsDrawer
        principal={selected}
        name={selectedName}
        onClose={() => setSelected(null)}
      />
    </div>
  );
};
