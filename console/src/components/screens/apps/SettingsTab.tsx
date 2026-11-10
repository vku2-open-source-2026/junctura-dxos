// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import { Ban, Info } from "lucide-react";
import type { Application } from "../../../types";
import { useI18n } from "../../../locales/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "../../common/Card";
import { Button } from "../../common/Button";
import { AppStateBadge } from "./AppStateBadge";

interface SettingsTabProps {
  application: Application;
  onRevoke: () => void;
}

export const SettingsTab: React.FC<SettingsTabProps> = ({
  application,
  onRevoke,
}) => {
  const { t } = useI18n();
  const a = t.applications;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{a.settingsCurrentState}</CardTitle>
        </CardHeader>
        <CardContent>
          <AppStateBadge state={application.state} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>{a.settingsActionsTitle}</CardTitle>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              {a.settingsActionsDesc}
            </p>
          </div>
        </CardHeader>
        <CardContent>
          {application.state === "revoked" ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {a.settingsRevokedNotice}
            </p>
          ) : application.state === "pending" ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {a.pendingDesc}
            </p>
          ) : (
            <div className="space-y-3">
              <Button
                variant="destructive"
                size="sm"
                onClick={onRevoke}
                leftIcon={<Ban className="w-3.5 h-3.5" />}
              >
                {a.actionRevoke}
              </Button>
              <div className="flex items-start gap-2 text-sm text-slate-500 dark:text-slate-400">
                <Info className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
                <p>{a.selfRegistrationNotice}</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
