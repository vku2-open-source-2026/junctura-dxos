// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import { useI18n } from "../../../locales/i18n";
import { useSession } from "../../../services/session";
import { PageHeader } from "../../layout/PageHeader";
import { TrustGraphCard } from "../../explainers/TrustGraphCard";

export const ConnectMapScreen: React.FC = () => {
  const { t } = useI18n();
  const c = t.connect;
  const { can } = useSession();

  return (
    <div className="space-y-6">
      <PageHeader title={c.title} subtitle={c.subtitle} />
      <TrustGraphCard canRevoke={can("trust.write") || can("trust.approve")} />
    </div>
  );
};
