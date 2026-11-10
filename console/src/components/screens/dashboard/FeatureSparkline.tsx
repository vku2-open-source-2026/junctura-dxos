// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import type { FeatureBucket } from "../../../types";

interface FeatureSparklineProps {
  points: FeatureBucket[];
  label: string;
}

const WIDTH = 120;
const HEIGHT = 28;

export const FeatureSparkline: React.FC<FeatureSparklineProps> = ({
  points,
  label,
}) => {
  const maximum = points.reduce(
    (max, point) => Math.max(max, point.requests),
    0
  );
  const step = WIDTH / Math.max(1, points.length);
  const barWidth = Math.max(1, step - 1);
  const baseline = HEIGHT - 1;

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="h-7 w-28"
      preserveAspectRatio="none"
    >
      <line
        x1="0"
        x2={WIDTH}
        y1={baseline}
        y2={baseline}
        stroke="var(--chart-grid)"
        strokeWidth="1"
      />
      {points.map((point, index) => {
        const height =
          maximum > 0 ? Math.round((point.requests / maximum) * (HEIGHT - 2)) : 0;
        return (
          <rect
            key={`${point.at}-${index}`}
            x={index * step}
            y={baseline - height}
            width={barWidth}
            height={height}
            fill="var(--chart-blue)"
          />
        );
      })}
    </svg>
  );
};
