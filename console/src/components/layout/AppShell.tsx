// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useState } from "react";
import { ScreenId, IdentityState } from "../../types";
import { Sidebar } from "./Sidebar";
import { Header } from "./Header";
import { ServicePanel } from "./ServicePanel";
import { PageTabs } from "./PageTabs";
import { CommandPalette } from "./CommandPalette";
import { JuncturaLogo } from "../common/JuncturaLogo";
import { useI18n } from "../../locales/i18n";
import { PlatformServicesProvider } from "../../services/platformStatus";
import type { PlatformFunctionId } from "../../constants/platformFunctions";
import { X } from "lucide-react";

const COLLAPSED_STORAGE_KEY = "junctura_sidebar_collapsed";
const PANEL_OPEN_STORAGE_KEY = "junctura_service_panel_open";

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage is optional; the current tab keeps the state.
  }
}

interface AppShellProps {
  currentScreen: ScreenId;
  onNavigate: (screen: ScreenId) => void;
  onNavigatePlatform: (serviceId: PlatformFunctionId | null) => void;
  onOpenDocsApi: () => void;
  identityState: IdentityState;
  children: React.ReactNode;
}

export const AppShell: React.FC<AppShellProps> = ({
  currentScreen,
  onNavigate,
  onNavigatePlatform,
  onOpenDocsApi,
  identityState,
  children,
}) => {
  const { t } = useI18n();
  const [isCollapsed, setIsCollapsed] = useState(
    () => readStored(COLLAPSED_STORAGE_KEY) === "1"
  );
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const [isPaletteOpen, setIsPaletteOpen] = useState(false);
  const [isPanelOpen, setIsPanelOpen] = useState(
    () => readStored(PANEL_OPEN_STORAGE_KEY) === "1"
  );

  const toggleCollapsed = () => {
    setIsCollapsed((previous) => {
      const next = !previous;
      writeStored(COLLAPSED_STORAGE_KEY, next ? "1" : "0");
      return next;
    });
  };

  const setPanelOpen = (open: boolean) => {
    setIsPanelOpen(open);
    writeStored(PANEL_OPEN_STORAGE_KEY, open ? "1" : "0");
  };

  const handleServiceNavigate = (serviceId: PlatformFunctionId | null) => {
    onNavigatePlatform(serviceId);
    setIsMobileOpen(false);
  };

  const handlePanelNavigate = (screen: ScreenId) => {
    onNavigate(screen);
    setIsMobileOpen(false);
  };

  const handleMobileNavigate = (screen: ScreenId) => {
    onNavigate(screen);
    setIsMobileOpen(false);
  };

  return (
    <PlatformServicesProvider>
      <div className="flex min-h-screen flex-col bg-[var(--bg)] font-sans text-[var(--text)] transition-colors duration-200">
        <div className="hidden md:block">
          <Sidebar
            currentScreen={currentScreen}
            onNavigate={onNavigate}
            isCollapsed={isCollapsed}
            onToggleCollapse={toggleCollapsed}
          />
        </div>

        {isMobileOpen && (
          <div
            className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs md:hidden"
            onClick={() => setIsMobileOpen(false)}
          >
            <div
              className="h-full w-[17rem] p-2"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex h-full flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--card)] shadow-2xl">
                <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
                  <JuncturaLogo size={28} showText />
                  <button
                    type="button"
                    onClick={() => setIsMobileOpen(false)}
                    className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-500/10 hover:text-[var(--text)]"
                    aria-label={t.common.close}
                  >
                    <X className="h-5 w-5" aria-hidden="true" />
                  </button>
                </div>
                <div className="min-h-0 flex-1">
                  <Sidebar
                    currentScreen={currentScreen}
                    onNavigate={handleMobileNavigate}
                    isCollapsed={false}
                    onToggleCollapse={() => {}}
                    showCollapse={false}
                    embedded
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        <div
          className={`flex w-full min-w-0 flex-1 flex-col transition-all duration-300 ${
            isCollapsed ? "md:pl-[5.5rem]" : "md:pl-[17.5rem]"
          }`}
        >
          <Header
            currentScreen={currentScreen}
            onNavigate={onNavigate}
            onOpenMobileMenu={() => setIsMobileOpen(true)}
            onOpenPalette={() => setIsPaletteOpen(true)}
            identityState={identityState}
            isPanelOpen={isPanelOpen}
            onTogglePanel={() => setPanelOpen(!isPanelOpen)}
          />

          <main className="mx-auto w-full min-w-0 max-w-7xl flex-1 p-4 md:p-8">
            <PageTabs currentScreen={currentScreen} onNavigate={onNavigate} />
            {children}
          </main>
        </div>

        <ServicePanel
          open={isPanelOpen}
          onClose={() => setPanelOpen(false)}
          onNavigate={handlePanelNavigate}
          onOpenService={handleServiceNavigate}
          onOpenDocs={onOpenDocsApi}
        />

        <CommandPalette
          open={isPaletteOpen}
          onOpenChange={setIsPaletteOpen}
          onNavigate={onNavigate}
          onNavigatePlatform={handleServiceNavigate}
        />
      </div>
    </PlatformServicesProvider>
  );
};
