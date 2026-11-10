// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useMemo } from "react";
import { ArrowLeft } from "lucide-react";
import type { Application, Language, TrustGraph } from "../../../types";
import { useI18n } from "../../../locales/i18n";
import { PageHeader } from "../../layout/PageHeader";
import { Button } from "../../common/Button";
import { AppStateBadge } from "./AppStateBadge";
import { OverviewTab } from "./OverviewTab";
import { SettingsTab } from "./SettingsTab";
import { buildAppDetailModel } from "./appDetailModel";
import { useAppRelated } from "./useAppRelated";
import { APP_TABS, type AppTab } from "./route";

interface AppDetailProps {
  application: Application;
  graph: TrustGraph | null;
  tab: AppTab;
  language: Language;
  onBack: () => void;
  onTabChange: (tab: AppTab) => void;
  onApprove: () => void;
  onReject: () => void;
  onRevoke: () => void;
}

export const AppDetail: React.FC<AppDetailProps> = ({
  application,
  graph,
  tab,
  language,
  onBack,
  onTabChange,
  onApprove,
  onReject,
  onRevoke,
}) => {
  const { t } = useI18n();
  const a = t.applications;
  const related = useAppRelated(application);

  const names = useMemo(
    () =>
      new Map(
        (graph?.nodes ?? []).map((node) => [node.appId, node.displayName])
      ),
    [graph]
  );

  const model = useMemo(
    () =>
      buildAppDetailModel(application, {
        graph,
        capabilities: related.capabilities,
        storage: related.storage,
        audit: related.audit,
        principals: related.principals,
      }),
    [application, graph, related]
  );

  const labels: Record<AppTab, string> = {
    overview: a.tabOverview,
    settings: a.tabSettings,
  };

  const handleTabKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number
  ) => {
    let delta = 0;
    if (event.key === "ArrowRight") delta = 1;
    else if (event.key === "ArrowLeft") delta = -1;
    else if (event.key === "Home") delta = -index;
    else if (event.key === "End") delta = APP_TABS.length - 1 - index;
    else return;
    event.preventDefault();
    const next = APP_TABS[(index + delta + APP_TABS.length) % APP_TABS.length];
    onTabChange(next);
    requestAnimationFrame(() => {
      document.getElementById(`app-tab-${next}`)?.focus();
    });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={application.displayName}
        subtitle={a.detailOwnerUnit + ": " + (model.ownerUnit ?? "—")}
        badges={<AppStateBadge state={application.state} />}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={onBack}
            leftIcon={<ArrowLeft className="w-3.5 h-3.5" />}
          >
            {a.backToList}
          </Button>
        }
      />

      <div
        role="tablist"
        aria-label={application.displayName}
        className="inline-flex max-w-full overflow-x-auto rounded-md border border-slate-200 bg-slate-50 p-1 dark:border-[#243843] dark:bg-[#13242D]"
      >
        {APP_TABS.map((item, index) => {
          const active = item === tab;
          return (
            <button
              key={item}
              id={`app-tab-${item}`}
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => onTabChange(item)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
              className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                active
                  ? "bg-white text-junctura-blue shadow-sm dark:bg-[#1B303B] dark:text-[var(--accent)]"
                  : "text-slate-600 hover:text-stone-ink dark:text-slate-400 dark:hover:text-slate-200"
              }`}
            >
              {labels[item]}
            </button>
          );
        })}
      </div>

      {tab === "overview" && (
        <OverviewTab
          application={application}
          model={model}
          related={related}
          names={names}
          language={language}
          onApprove={onApprove}
          onReject={onReject}
        />
      )}
      {tab === "settings" && (
        <SettingsTab application={application} onRevoke={onRevoke} />
      )}
    </div>
  );
};
