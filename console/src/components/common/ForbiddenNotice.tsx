// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import { EyeOff } from "lucide-react";
import { useI18n } from "../../locales/i18n";

interface ForbiddenNoticeProps {
  className?: string;
}

// Friendly state for a 403 from the API: this is not an error, the account
// simply cannot see this block.
export const ForbiddenNotice: React.FC<ForbiddenNoticeProps> = ({
  className = "",
}) => {
  const { t } = useI18n();
  return (
    <div
      role="status"
      data-testid="forbidden-notice"
      className={`flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50/70 p-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-200 ${className}`}
    >
      <EyeOff
        className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-400"
        aria-hidden="true"
      />
      <p className="leading-relaxed">{t.common.forbiddenView}</p>
    </div>
  );
};

export default ForbiddenNotice;
