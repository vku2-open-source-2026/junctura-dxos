// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";

interface JuncturaLogoProps {
  size?: number;
  showText?: boolean;
  className?: string;
  onDark?: boolean;
}

export const JuncturaLogo: React.FC<JuncturaLogoProps> = ({
  size = 32,
  showText = true,
  className = "",
  onDark = false,
}) => {
  return (
    <div className={`flex items-center gap-3 select-none ${className}`}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 48 48"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="flex-shrink-0 transition-transform hover:scale-105 duration-200"
        aria-hidden="true"
      >
        {/* Base tile */}
        <rect
          width="48"
          height="48"
          rx="10"
          fill={onDark ? "#E8F3F5" : "var(--logo-tile, #172F3D)"}
        />
        
        {/* Layer 1 Facet: Junctura Blue */}
        <path
          d="M17 12H34V17H31V27C31 32.5228 26.5228 37 21 37H15V32H21C23.7614 32 26 29.7614 26 27V17H17V12Z"
          fill={onDark ? "#176B80" : "var(--logo-blue, #4FB3C8)"}
        />

        {/* Junction node: where applications meet */}
        <circle cx="28.5" cy="22" r="3.2" fill={onDark ? "#0F6F66" : "var(--logo-green, #5FCDBE)"} />

        {/* Junction accent: Sandstone */}
        <path
          d="M17 12H24V17H17V12Z"
          fill={onDark ? "#8A5A38" : "var(--logo-sand, #D8A581)"}
        />
      </svg>

      {showText && (
        <div className="flex flex-col">
          <span className="font-bold text-base leading-tight tracking-tight text-stone-ink dark:text-slate-100 font-sans">
            Junctura
          </span>
          <span className="text-xs font-medium uppercase tracking-wider text-[var(--muted)]">
            Console
          </span>
        </div>
      )}
    </div>
  );
};
