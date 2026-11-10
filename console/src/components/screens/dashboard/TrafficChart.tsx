// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useMemo, useState } from "react";
import type { TrafficBucket } from "../../../types";
import { useI18n } from "../../../locales/i18n";
import { errorCount, formatClock, formatDateTime } from "./metrics";

interface TrafficChartProps {
  buckets: TrafficBucket[];
  large?: boolean;
  description?: string;
}

function niceMax(value: number): number {
  if (value <= 5) return 5;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

export const TrafficChart: React.FC<TrafficChartProps> = ({
  buckets,
  large = false,
  description,
}) => {
  const { t, language } = useI18n();
  const d = t.dashboard;
  const [active, setActive] = useState<number | null>(null);
  const locale = language === "vi" ? "vi-VN" : "en-GB";
  const numberLocale = language === "vi" ? "vi-VN" : "en-US";

  const width = large ? 960 : 760;
  const height = large ? 330 : 240;
  const padding = { left: 42, right: 14, top: 14, bottom: 30 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const { top, stepWidth } = useMemo(() => {
    const maximum = buckets.reduce(
      (max, bucket) => Math.max(max, bucket.requests),
      0
    );
    return {
      top: niceMax(maximum),
      stepWidth: plotWidth / Math.max(1, buckets.length),
    };
  }, [buckets, plotWidth]);

  const barWidth = Math.max(2, Math.min(large ? 18 : 12, stepWidth - 2));
  const y = (value: number) =>
    padding.top + plotHeight * (1 - value / Math.max(1, top));
  const labelEvery = Math.max(1, Math.ceil(buckets.length / 8));
  const activeBucket = active === null ? null : buckets[active];
  const summary = description ?? d.chartDesc;

  const move = (direction: 1 | -1) => {
    if (buckets.length === 0) return;
    setActive((current) => {
      if (current === null) return direction === 1 ? 0 : buckets.length - 1;
      return Math.min(buckets.length - 1, Math.max(0, current + direction));
    });
  };

  return (
    <div className="w-full">
      <div className="relative">
        <div
          tabIndex={0}
          role="group"
          aria-label={d.chartAria}
          aria-describedby="traffic-chart-summary"
          onKeyDown={(event) => {
            if (event.key === "ArrowRight") {
              event.preventDefault();
              move(1);
            } else if (event.key === "ArrowLeft") {
              event.preventDefault();
              move(-1);
            } else if (event.key === "Escape") {
              setActive(null);
            }
          }}
          onFocus={() => setActive((current) => current ?? 0)}
          onBlur={() => setActive(null)}
          className="rounded-md outline-offset-4"
        >
          <svg
            viewBox={`0 0 ${width} ${height}`}
            width="100%"
            aria-hidden="true"
            className="block h-auto w-full"
          >
            {[0, 0.5, 1].map((fraction) => {
              const value = Math.round(top * fraction);
              return (
                <g key={fraction}>
                  <line
                    x1={padding.left}
                    x2={width - padding.right}
                    y1={y(value)}
                    y2={y(value)}
                    stroke="var(--chart-grid)"
                    strokeWidth="1"
                  />
                  <text
                    x={padding.left - 7}
                    y={y(value) + 4}
                    textAnchor="end"
                    fontSize="11"
                    fill="var(--chart-axis)"
                  >
                    {new Intl.NumberFormat(numberLocale).format(value)}
                  </text>
                </g>
              );
            })}

            {buckets.map((bucket, index) => {
              const x = padding.left + index * stepWidth;
              const barX = x + (stepWidth - barWidth) / 2;
              const totalHeight = Math.max(
                bucket.requests > 0 ? 1 : 0,
                plotHeight * (bucket.requests / Math.max(1, top))
              );
              const errors = errorCount(bucket);
              const errorHeight = Math.max(
                errors > 0 ? 1 : 0,
                plotHeight * (errors / Math.max(1, top))
              );
              const isActive = active === index;
              return (
                <g key={`${bucket.at}-${index}`}>
                  <rect
                    x={barX}
                    y={padding.top + plotHeight - totalHeight}
                    width={barWidth}
                    height={totalHeight}
                    rx={1}
                    fill="var(--chart-blue)"
                    opacity={active === null || isActive ? 1 : 0.6}
                  />
                  {errors > 0 && (
                    <rect
                      x={barX}
                      y={padding.top + plotHeight - errorHeight}
                      width={barWidth}
                      height={errorHeight}
                      rx={1}
                      fill="var(--chart-orange)"
                    />
                  )}
                  <rect
                    data-testid="traffic-point"
                    x={x}
                    y={padding.top}
                    width={stepWidth}
                    height={plotHeight}
                    fill="transparent"
                    onMouseEnter={() => setActive(index)}
                    onMouseLeave={() => setActive(null)}
                  />
                  {(index % labelEvery === 0 || isActive) && (
                    <text
                      x={x + stepWidth / 2}
                      y={height - 9}
                      textAnchor="middle"
                      fontSize="11"
                      fill="var(--chart-axis)"
                    >
                      {formatClock(bucket.at, locale)}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        </div>

        {activeBucket && (
          <div
            role="status"
            aria-live="polite"
            className="pointer-events-none absolute top-2 z-10 w-48 -translate-x-1/2 rounded-md border border-[var(--border)] bg-[var(--card)] p-2 text-xs shadow-lg"
            style={{
              left: `${Math.min(
                88,
                Math.max(
                  12,
                  ((padding.left + (active ?? 0) * stepWidth + stepWidth / 2) /
                    width) *
                    100
                )
              )}%`,
            }}
          >
            <p className="font-semibold text-[var(--text)]">
              {formatDateTime(activeBucket.at, locale)}
            </p>
            <p className="mt-1 flex justify-between gap-2 text-[var(--muted)]">
              <span>{d.chartRequests}</span>
              <span className="font-semibold text-[var(--text)]">
                {new Intl.NumberFormat(numberLocale).format(
                  activeBucket.requests
                )}
              </span>
            </p>
            <p className="flex justify-between gap-2 text-[var(--muted)]">
              <span>{d.chartErrors}</span>
              <span className="font-semibold text-[var(--text)]">
                {new Intl.NumberFormat(numberLocale).format(
                  errorCount(activeBucket)
                )}
              </span>
            </p>
            <p className="flex justify-between gap-2 text-[var(--muted)]">
              <span>{d.metricAvgLatency}</span>
              <span className="font-semibold text-[var(--text)]">
                {activeBucket.avgLatencyMs} ms
              </span>
            </p>
          </div>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-[var(--muted)]">
        <span className="inline-flex items-center gap-1.5">
          <span
            className="h-2.5 w-2.5 rounded-sm bg-[var(--chart-blue)]"
            aria-hidden="true"
          />
          {d.chartRequests}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="h-2.5 w-2.5 rounded-sm bg-[var(--chart-orange)]"
            aria-hidden="true"
          />
          {d.chartErrors}
        </span>
      </div>

      <p id="traffic-chart-summary" className="sr-only">
        {summary}
      </p>

      <table className="sr-only">
        <caption>{d.tableCaption}</caption>
        <thead>
          <tr>
            <th>{d.colTime}</th>
            <th>{d.chartRequests}</th>
            <th>{d.chartErrors}</th>
            <th>{d.metricAvgLatency}</th>
          </tr>
        </thead>
        <tbody>
          {buckets.map((bucket) => (
            <tr key={`row-${bucket.at}`}>
              <td>{formatDateTime(bucket.at, locale)}</td>
              <td>{bucket.requests}</td>
              <td>{errorCount(bucket)}</td>
              <td>{bucket.avgLatencyMs} ms</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
