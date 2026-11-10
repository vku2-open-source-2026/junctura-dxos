// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useState } from "react";
import { AlertCircle, CheckCircle, PlugZap, Save } from "lucide-react";
import { useI18n } from "../../locales/i18n";
import { api } from "../../services/apiClient";
import { PageHeader } from "../layout/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "../common/Card";
import { Button } from "../common/Button";
import { useToast } from "../common/Toast";
import { AppearanceCard } from "./settings/AppearanceCard";

export const PlatformSettingsScreen: React.FC = () => {
  const { t } = useI18n();
  const { showToast } = useToast();
  const s = t.settings;

  const [gatewayUrl, setGatewayUrl] = useState(() => api.getBaseUrl());
  const [gatewayError, setGatewayError] = useState<string | null>(null);
  const [probeMessage, setProbeMessage] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);

  const saveGateway = (event: React.FormEvent) => {
    event.preventDefault();
    setGatewayError(null);
    setProbeMessage(null);
    try {
      api.setBaseUrl(gatewayUrl);
      showToast(s.saveSuccess);
    } catch {
      setGatewayError(s.invalidGateway);
    }
  };

  const testConnection = async () => {
    setGatewayError(null);
    setProbeMessage(null);
    setProbing(true);
    try {
      if (!api.isApprovedGatewayUrl(gatewayUrl)) {
        setGatewayError(s.invalidGateway);
        return;
      }
      const result = await api.probeHealth(gatewayUrl);
      if (result.ok) {
        setProbeMessage(
          s.probeSuccess
            .replace("{latency}", String(result.latencyMs))
            .replace("{service}", result.service ?? "—")
            .replace("{status}", result.healthStatus ?? "—")
        );
      } else {
        setProbeMessage(
          s.probeErrorStatus.replace("{status}", String(result.status))
        );
      }
    } catch (error) {
      setProbeMessage(
        s.probeErrorNetwork.replace(
          "{message}",
          error instanceof Error ? error.message : ""
        )
      );
    } finally {
      setProbing(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader title={s.title} subtitle={s.subtitle} />

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <PlugZap className="h-5 w-5 text-teal-600 dark:text-teal-400" />
              <CardTitle>{s.gatewaySectionTitle}</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <p className="mb-4 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
              {s.gatewaySectionDesc}
            </p>
            <form onSubmit={saveGateway} className="space-y-3">
              <label className="block text-sm font-semibold text-stone-ink dark:text-slate-200">
                {s.gatewayUrlLabel}
                <input
                  value={gatewayUrl}
                  onChange={(event) => setGatewayUrl(event.target.value)}
                  placeholder="/api"
                  className="mt-1 w-full rounded-md border border-slate-200 bg-white px-3 py-2 font-mono text-sm text-stone-ink focus:outline-none focus:ring-1 focus:ring-junctura-blue dark:border-[#243843] dark:bg-[#13242D] dark:text-slate-100"
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="submit"
                  variant="primary"
                  size="md"
                  leftIcon={<Save className="h-4 w-4" />}
                >
                  {s.saveSettings}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="md"
                  isLoading={probing}
                  onClick={() => void testConnection()}
                >
                  {s.connectionTest}
                </Button>
              </div>
            </form>

            {gatewayError && (
              <p
                role="alert"
                className="mt-3 flex items-center gap-1 text-sm font-medium text-rose-600 dark:text-rose-400"
              >
                <AlertCircle className="h-4 w-4" />
                {gatewayError}
              </p>
            )}
            {probeMessage && (
              <p
                role="status"
                className="mt-3 flex items-center gap-1 text-sm font-medium text-teal-600 dark:text-teal-400"
              >
                <CheckCircle className="h-4 w-4" />
                {probeMessage}
              </p>
            )}
          </CardContent>
        </Card>

        <AppearanceCard />
      </div>
    </div>
  );
};
