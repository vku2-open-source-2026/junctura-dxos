// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import type { ApplicationState } from "../../../types";
import { Badge, type BadgeVariant } from "../../common/Badge";
import { useI18n } from "../../../locales/i18n";

interface AppStateBadgeProps {
  state: ApplicationState;
}

export const AppStateBadge: React.FC<AppStateBadgeProps> = ({ state }) => {
  const { t } = useI18n();

  const config: Record<
    ApplicationState,
    { variant: BadgeVariant; label: string }
  > = {
    active: { variant: "teal", label: t.applications.stateActive },
    pending: { variant: "warning", label: t.applications.statePending },
    suspended: { variant: "destructive", label: t.applications.stateSuspended },
    revoked: { variant: "outline", label: t.applications.stateRevoked },
  };

  const current = config[state];
  return <Badge variant={current.variant}>{current.label}</Badge>;
};
