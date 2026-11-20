// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import { Eye } from "lucide-react";
import { useI18n } from "../../locales/i18n";
import { isReadOnlyPermissions, useSession } from "../../services/session";

// Shown at the top of the app frame when the signed-in account only has
// read permissions.
export const ReadOnlyBanner: React.FC = () => {
  const { t } = useI18n();
  const { permissions } = useSession();
  if (!isReadOnlyPermissions(permissions)) return null;
  return (
    <div
      role="status"
      data-testid="readonly-banner"
      className="mb-3 flex items-start gap-2 rounded-md border border-slate-200/80 bg-slate-50 px-3 py-2 text-sm text-slate-600 dark:border-[#243843] dark:bg-[#13242D] dark:text-slate-300"
    >
      <Eye
        className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--accent)]"
        aria-hidden="true"
      />
      <p className="leading-relaxed">{t.session.readOnlyBanner}</p>
    </div>
  );
};

export default ReadOnlyBanner;
