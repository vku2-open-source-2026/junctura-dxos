// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import { Activity } from "lucide-react";
import type { FeatureMetric } from "../../../types";
import { useI18n } from "../../../locales/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "../../common/Card";
import { EmptyState } from "../../common/EmptyState";
import { ErrorState } from "../../common/ErrorState";
import { LoadingSkeleton } from "../../common/LoadingSkeleton";
import { FeatureSparkline } from "./FeatureSparkline";

interface FeatureTableProps {
  features: FeatureMetric[];
  loading: boolean;
  loadError: boolean;
  onRetry: () => void;
}

export const FeatureTable: React.FC<FeatureTableProps> = ({
  features,
  loading,
  loadError,
  onRetry,
}) => {
  const { t, language } = useI18n();
  const d = t.dashboard;
  const numberLocale = language === "vi" ? "vi-VN" : "en-US";
  const number = (value: number) =>
    new Intl.NumberFormat(numberLocale).format(value);
  const nameOf = (feature: string): string => {
    const names = d.featureNames as Record<string, string>;
    return names[feature] ?? feature;
  };
  const busiest = features.reduce(
    (max, feature) => Math.max(max, feature.requests),
    0
  );

  return (
    <Card>
      <CardHeader>
        <div className="min-w-0">
          <CardTitle>{d.featureTableTitle}</CardTitle>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {d.featureTableDesc}
          </p>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {loadError ? (
          <div className="p-5">
            <ErrorState
              title={d.loadError}
              message={d.loadErrorHint}
              onRetry={onRetry}
            />
          </div>
        ) : loading && features.length === 0 ? (
          <div className="p-5">
            <LoadingSkeleton rows={5} />
          </div>
        ) : features.length === 0 ? (
          <div className="p-5">
            <EmptyState
              title={d.featureEmptyTitle}
              description={d.featureEmptyDesc}
              icon={<Activity className="h-6 w-6" aria-hidden="true" />}
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">{d.featureTableTitle}</caption>
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--muted)]">
                  <th className="px-3 py-2 font-semibold">{d.colFeatureName}</th>
                  <th className="px-3 py-2 font-semibold">
                    {d.colFeatureRequests}
                  </th>
                  <th className="px-3 py-2 text-right font-semibold">
                    {d.col4xx}
                  </th>
                  <th className="px-3 py-2 text-right font-semibold">
                    {d.col5xx}
                  </th>
                  <th className="px-3 py-2 text-right font-semibold">
                    {d.colAvgMs}
                  </th>
                  <th className="px-3 py-2 text-right font-semibold">
                    {d.colMaxMs}
                  </th>
                  <th className="px-3 py-2 font-semibold">{d.colPerMinute}</th>
                </tr>
              </thead>
              <tbody>
                {features.map((feature) => {
                  const name = nameOf(feature.feature);
                  const share =
                    busiest > 0 ? (feature.requests / busiest) * 100 : 0;
                  return (
                    <tr
                      key={feature.feature}
                      className="border-b border-[var(--border)]/60 last:border-0"
                    >
                      <td className="whitespace-nowrap px-3 py-2 font-medium text-[var(--text)]">
                        {name}
                      </td>
                      <td className="min-w-36 px-3 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-[var(--text)]">
                            {number(feature.requests)}
                          </span>
                        </div>
                        <div
                          className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[var(--accent-soft)]"
                          role="img"
                          aria-label={d.featureBarAria.replace("{name}", name)}
                        >
                          <div
                            className="h-full rounded-full bg-[var(--chart-blue)]"
                            style={{ width: `${Math.max(2, share)}%` }}
                          />
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right text-[var(--muted)]">
                        {number(feature.errors4xx)}
                      </td>
                      <td className="px-3 py-2 text-right text-[var(--muted)]">
                        {number(feature.errors5xx)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right text-[var(--muted)]">
                        {number(feature.avgLatencyMs)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right text-[var(--muted)]">
                        {number(feature.maxLatencyMs)}
                      </td>
                      <td className="px-3 py-2">
                        <FeatureSparkline
                          points={feature.series}
                          label={d.featureSparklineAria.replace("{name}", name)}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
