// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useMemo } from "react";
import { RefreshCw } from "lucide-react";
import { useI18n } from "../../../locales/i18n";
import { PageHeader } from "../../layout/PageHeader";
import { Button } from "../../common/Button";
import { FeatureTable } from "./FeatureTable";
import { useFeatureSeries } from "./useMetrics";

export const TrafficScreen: React.FC = () => {
  const { t } = useI18n();
  const d = t.dashboard;
  const { series, loading, error, refresh } = useFeatureSeries(60, 30_000);

  const features = useMemo(
    () =>
      [...(series?.features ?? [])].sort(
        (left, right) =>
          right.requests - left.requests ||
          left.feature.localeCompare(right.feature)
      ),
    [series]
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={d.trafficTitle}
        subtitle={d.trafficSubtitle}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            isLoading={loading}
            leftIcon={<RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
          >
            {t.common.refresh}
          </Button>
        }
      />

      <FeatureTable
        features={features}
        loading={loading}
        loadError={error}
        onRetry={refresh}
      />
    </div>
  );
};
