// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import { ChevronRight } from "lucide-react";
import {
  getModule,
  type ModuleId,
  type ScreenId,
} from "../../constants/modules";
import {
  PLATFORM_FUNCTIONS,
  platformFunctionForScreen,
} from "../../constants/platformFunctions";
import { platformIdFromHash } from "../../services/appRouting";
import { useI18n } from "../../locales/i18n";

interface BreadcrumbsProps {
  currentScreen: ScreenId;
}

export const Breadcrumbs: React.FC<BreadcrumbsProps> = ({ currentScreen }) => {
  const { t } = useI18n();
  const module = getModule(currentScreen);
  const activeFunction = platformIdFromHash();
  const fn = currentScreen === "platform" && activeFunction
    ? PLATFORM_FUNCTIONS[activeFunction]
    : platformFunctionForScreen(currentScreen);

  let groupLabel: string | null = fn ? t.platform.tierLabel : null;
  let currentLabel: string;

  if (currentScreen === "platform") {
    currentLabel = activeFunction
      ? t.platform.functions[activeFunction].name
      : t.platform.title;
  } else if (fn) {
    const moduleLabel = module ? t.modules[module.id as ModuleId]?.label : undefined;
    currentLabel = moduleLabel ?? t.platform.functions[fn.id].name;
  } else if (module) {
    currentLabel = t.modules[module.id as ModuleId].label;
  } else if (currentScreen === "docs") {
    groupLabel = t.sidebar.groups.docs;
    currentLabel = t.docs.title;
  } else if (currentScreen === "profile") {
    currentLabel = t.profile.title;
  } else {
    currentLabel = t.common.appName;
  }

  return (
    <nav
      aria-label={t.session.breadcrumb}
      className="flex min-w-0 items-center gap-1.5 overflow-hidden text-xs text-[var(--muted)]"
    >
      {groupLabel && (
        <>
          <span className="hidden truncate min-[1280px]:inline">{groupLabel}</span>
          <ChevronRight
            className="hidden h-3 w-3 flex-shrink-0 min-[1280px]:inline"
            aria-hidden="true"
          />
        </>
      )}
      <span className="min-w-0 truncate font-semibold text-[var(--text)]">
        {currentLabel}
      </span>
    </nav>
  );
};
