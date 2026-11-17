// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import { Activity, Building2, FlaskConical } from "lucide-react";
import { useI18n } from "../../locales/i18n";
import { useSession } from "../../services/session";

export const EnvironmentBanner: React.FC = () => {
  const { t } = useI18n();
  const { user } = useSession();
  const tenant = user?.tenantId;
  if (!tenant) return null;

  const kind = tenant.trim().toLowerCase();
  const isDemo = kind === "demo";
  const isProduction = kind === "production";

  const styles = isDemo
    ? "border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] text-[var(--color-warning)]"
    : isProduction
      ? "border-[var(--color-info-border)] bg-[var(--color-info-bg)] text-[var(--color-info)]"
      : "border-[var(--border)] bg-[var(--card)] text-[var(--muted)]";

  const Icon = isDemo ? FlaskConical : isProduction ? Activity : Building2;
  const label = isDemo
    ? t.environment.demo
    : isProduction
      ? t.environment.production
      : t.environment.tenant.replace("{tenant}", tenant);

  return (
    <div
      role="note"
      className={`mb-4 flex min-w-0 items-start gap-2 rounded-md border px-3 py-2 text-sm font-medium ${styles}`}
    >
      <Icon
        className="mt-0.5 h-4 w-4 flex-shrink-0"
        aria-hidden="true"
      />
      <span className="min-w-0 break-words">{label}</span>
    </div>
  );
};
