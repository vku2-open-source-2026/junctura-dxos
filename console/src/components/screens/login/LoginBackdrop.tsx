// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";

export const LoginBackdrop: React.FC = () => (
  <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
    <svg className="absolute inset-0 h-full w-full text-junctura-blue/10 dark:text-[var(--accent)]/10">
      <defs>
        <pattern
          id="login-pattern"
          width="56"
          height="56"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(18)"
        >
          <circle cx="2" cy="2" r="1.4" fill="currentColor" />
          <path d="M0 28h56M28 0v56" stroke="currentColor" strokeWidth="0.35" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#login-pattern)" />
    </svg>
    <div className="absolute -left-24 top-1/4 h-72 w-72 rounded-full bg-[#18877A]/10 blur-3xl dark:bg-teal-500/10" />
    <div className="absolute -right-20 bottom-1/4 h-80 w-80 rounded-full bg-[#C58B62]/10 blur-3xl dark:bg-amber-500/10" />
  </div>
);
