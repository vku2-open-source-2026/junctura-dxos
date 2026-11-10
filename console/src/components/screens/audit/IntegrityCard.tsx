// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import { AlertTriangle, CheckCircle, Clock, ShieldCheck } from "lucide-react";
import type { AuditVerification } from "../../../types";
import { useI18n } from "../../../locales/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "../../common/Card";
import { Badge } from "../../common/Badge";
import { Button } from "../../common/Button";
import { Term } from "../../common/Term";

interface IntegrityCardProps {
  verification: AuditVerification | null;
  verifying: boolean;
  error: string | null;
  numberLocale: string;
  onVerify: () => void;
}

export const IntegrityCard: React.FC<IntegrityCardProps> = ({
  verification,
  verifying,
  error,
  numberLocale,
  onVerify,
}) => {
  const { t } = useI18n();
  const a = t.audit;
  const label = (key: string) => (a as Record<string, string>)[key] ?? key;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-teal-600 dark:text-teal-400" />
          <CardTitle>
            <Term term="hashChain">{a.verifyTitle}</Term>
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 text-sm text-slate-600 dark:text-slate-300">
        <p className="leading-relaxed">{a.verifyDescription}</p>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            onClick={onVerify}
            disabled={verifying}
            leftIcon={<ShieldCheck className="w-4 h-4" />}
          >
            {verifying ? a.verifying : a.verifyButton}
          </Button>

        </div>

        {error && (
          <div
            role="alert"
            className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300"
          >
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {verification && (
          <div
            role="status"
            className={`space-y-2 rounded-md border p-4 ${
              verification.verified
                ? "border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/30"
                : "border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30"
            }`}
          >
            <div className="flex items-center gap-2 text-sm font-semibold">
              {verification.verified ? (
                <CheckCircle className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <AlertTriangle className="w-5 h-5 text-red-600 dark:text-red-400" />
              )}
              <span
                className={
                  verification.verified
                    ? "text-emerald-800 dark:text-emerald-200"
                    : "text-red-800 dark:text-red-200"
                }
              >
                {verification.verified ? a.intact : a.broken}
              </span>
            </div>

            {verification.verified ? (
              <p>{a.intactDesc}</p>
            ) : (
              verification.firstBreak && (
                <p className="text-red-700 dark:text-red-300">
                  {a.brokenAt} —{" "}
                  {label(`reason_${verification.firstBreak.reason}`)}
                </p>
              )
            )}

            <p>
              <strong>{verification.entries}</strong> {a.entries}
              {verification.newlySealed > 0 && (
                <>
                  {" · "}
                  <strong>{verification.newlySealed}</strong> {a.newlySealed}
                </>
              )}
              {" · "}
              <Clock className="inline w-3 h-3 -mt-0.5" />{" "}
              {new Date(verification.verifiedAt).toLocaleString(numberLocale)}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
