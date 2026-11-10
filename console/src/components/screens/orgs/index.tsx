// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useCallback, useEffect, useState } from "react";
import { Network, RefreshCw } from "lucide-react";
import type { DirectoryTree } from "../../../types";
import { ApiError, api } from "../../../services/apiClient";
import { useI18n } from "../../../locales/i18n";
import { PageHeader } from "../../layout/PageHeader";
import { Button } from "../../common/Button";
import { Card, CardContent } from "../../common/Card";
import { EmptyState } from "../../common/EmptyState";
import { ErrorState } from "../../common/ErrorState";
import { LoadingSkeleton } from "../../common/LoadingSkeleton";
import { OrgChart } from "./OrgChart";

export const OrganizationsScreen: React.FC = () => {
  const { t } = useI18n();
  const o = t.orgs;
  const [tree, setTree] = useState<DirectoryTree | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<
    "generic" | "permission" | "expired" | null
  >(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTree(await api.getDirectoryOrganizations());
    } catch (failure) {
      setTree(null);
      setError(
        failure instanceof ApiError
          ? failure.status === 403
            ? "permission"
            : failure.status === 401
              ? "expired"
              : "generic"
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

  return (
    <div className="space-y-6">
      <PageHeader
        title={o.title}
        subtitle={o.subtitle}
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
          title={o.permissionDeniedTitle}
          message={o.permissionDeniedDesc}
          onRetry={() => void load()}
        />
      ) : error === "expired" ? (
        <ErrorState
          title={o.sessionExpiredTitle}
          message={o.sessionExpiredDesc}
          onRetry={() => void load()}
        />
      ) : error ? (
        <ErrorState
          title={o.loadErrorTitle}
          message={o.loadErrorDesc}
          onRetry={() => void load()}
        />
      ) : loading && !tree ? (
        <Card>
          <CardContent>
            <p className="sr-only">{o.loading}</p>
            <LoadingSkeleton rows={6} />
          </CardContent>
        </Card>
      ) : !tree ? (
        <Card>
          <CardContent>
            <EmptyState
              title={o.emptyTitle}
              description={o.emptyDesc}
              icon={<Network className="h-6 w-6" aria-hidden="true" />}
            />
          </CardContent>
        </Card>
      ) : (
        <OrgChart tree={tree} />
      )}
    </div>
  );
};
