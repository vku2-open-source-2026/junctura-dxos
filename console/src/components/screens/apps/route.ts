// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";

export type AppTab = "overview" | "settings";

export const APP_TABS: AppTab[] = ["overview", "settings"];

export interface AppsRoute {
  appId: string | null;
  tab: AppTab;
}

export const APPS_LIST_HASH = "#/apps";

export function isAppTab(value: string | null): value is AppTab {
  return value !== null && (APP_TABS as string[]).includes(value);
}

export function appDetailHash(appId: string, tab: AppTab = "overview"): string {
  const base = `#/apps/${encodeURIComponent(appId)}`;
  return tab === "overview" ? base : `${base}?tab=${tab}`;
}

export function parseAppsRoute(hash: string): AppsRoute {
  const raw = hash.replace(/^#\/?/, "");
  const [path, query = ""] = raw.split("?");
  const segments = path.split("/").filter(Boolean);
  if (segments[0] !== "apps" || segments.length < 2) {
    return { appId: null, tab: "overview" };
  }
  const appId = decodeURIComponent(segments[1]);
  const requestedTab = new URLSearchParams(query).get("tab");
  return {
    appId: appId || null,
    tab: isAppTab(requestedTab) ? requestedTab : "overview",
  };
}

export function useAppsRoute(): AppsRoute {
  const [route, setRoute] = useState<AppsRoute>(() =>
    parseAppsRoute(window.location.hash)
  );

  useEffect(() => {
    const handleHashChange = () => {
      setRoute(parseAppsRoute(window.location.hash));
    };
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  return route;
}
