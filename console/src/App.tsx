// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useEffect, useState } from "react";
import type { ScreenId, IdentityState } from "./types";
import { api } from "./services/apiClient";
import { I18nProvider } from "./locales/i18n";
import { ThemeProvider } from "./services/themeContext";
import { SessionProvider, useSession } from "./services/session";
import { PendingApprovalsProvider } from "./services/pendingApprovals";
import { ToastProvider } from "./components/common/Toast";
import { AppShell } from "./components/layout/AppShell";
import { OverviewScreen } from "./components/screens/dashboard";
import { TrafficScreen } from "./components/screens/dashboard/TrafficScreen";
import { RequestsScreen } from "./components/screens/dashboard/RequestsScreen";
import { UsersScreen } from "./components/screens/users";
import { OrganizationsScreen } from "./components/screens/orgs";
import { QueueScreen } from "./components/screens/queue";
import { LandingScreen } from "./components/screens/LandingScreen";
import { LoginScreen } from "./components/screens/LoginScreen";
import { PlatformScreen } from "./components/screens/platform";
import { ProfileScreen } from "./components/screens/ProfileScreen";
import { ApplicationsScreen } from "./components/screens/ApplicationsScreen";
import { RecordsScreen } from "./components/screens/RecordsScreen";
import { FilesScreen } from "./components/screens/FilesScreen";
import { WorkflowsScreen } from "./components/screens/workflows";
import { SecurityActivityScreen } from "./components/screens/SecurityActivityScreen";
import { ConsentsScreen } from "./components/screens/ConsentsScreen";
import { EmergencyScreen } from "./components/screens/EmergencyScreen";
import { PlatformSettingsScreen } from "./components/screens/PlatformSettingsScreen";
import { CapabilitiesScreen } from "./components/screens/capabilities";
import { GrantsScreen } from "./components/screens/GrantsScreen";
import { ConnectMapScreen } from "./components/screens/connect/ConnectMapScreen";
import { DocsScreen } from "./components/screens/DocsScreen";
import type { PlatformFunctionId } from "./constants/platformFunctions";
import { hashPath, platformIdFromHash, screenFromHash } from "./services/appRouting";

const PUBLIC_SCREENS: ScreenId[] = ["welcome", "login"];

function isPublicScreen(screen: ScreenId): boolean {
  return PUBLIC_SCREENS.includes(screen);
}

interface AppContentProps {
  identityState: IdentityState;
  onRetryIdentity: () => void;
}

const AppContent: React.FC<AppContentProps> = ({
  identityState,
  onRetryIdentity,
}) => {
  const { user } = useSession();
  const [currentScreen, setCurrentScreen] = useState<ScreenId>(screenFromHash);
  const [platformServiceId, setPlatformServiceId] =
    useState<PlatformFunctionId | null>(platformIdFromHash);
  const hasSession = user !== null;
  const isPublic = isPublicScreen(currentScreen);

  useEffect(() => {
    const handleHashChange = () => {
      setCurrentScreen(screenFromHash());
      setPlatformServiceId(platformIdFromHash());
    };
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  useEffect(() => {
    const segment = hashPath()[0];
    if (segment === "services" || segment === "cores") {
      window.history.replaceState(null, "", "#/platform");
    }
  }, [currentScreen]);

  useEffect(() => {
    if (hasSession && isPublic) {
      setCurrentScreen("dashboard");
      window.history.replaceState(null, "", "#/dashboard");
      return;
    }
    if (!hasSession && !isPublic) {
      setCurrentScreen("login");
      window.history.replaceState(null, "", "#/login");
    }
  }, [hasSession, isPublic]);

  const handleNavigate = (screen: ScreenId) => {
    setCurrentScreen(screen);
    setPlatformServiceId(null);
    window.location.hash = `#/${screen}`;
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleNavigatePlatform = (serviceId: PlatformFunctionId | null) => {
    setCurrentScreen("platform");
    setPlatformServiceId(serviceId);
    window.location.hash = serviceId
      ? `#/platform/${serviceId}`
      : "#/platform";
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleOpenDocsApi = () => {
    setCurrentScreen("docs");
    window.history.replaceState(null, "", "#/docs/api");
    window.dispatchEvent(new Event("hashchange"));
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const renderActiveScreen = () => {
    switch (currentScreen) {
      case "dashboard":
        return <OverviewScreen onNavigate={handleNavigate} />;
      case "traffic":
        return <TrafficScreen />;
      case "requests":
        return <RequestsScreen />;
      case "queue":
        return <QueueScreen />;
      case "apps":
        return <ApplicationsScreen />;
      case "caps":
        return <CapabilitiesScreen />;
      case "users":
        return <UsersScreen />;
      case "orgs":
        return <OrganizationsScreen />;
      case "grants":
        return <GrantsScreen />;
      case "connect-map":
        return <ConnectMapScreen />;
      case "records":
        return <RecordsScreen />;
      case "files":
        return <FilesScreen />;
      case "workflows":
        return <WorkflowsScreen />;
      case "audit":
        return <SecurityActivityScreen />;
      case "consents":
        return <ConsentsScreen />;
      case "emergency":
        return <EmergencyScreen />;
      case "platform":
        return (
          <PlatformScreen
            serviceId={platformServiceId}
            onOpenService={handleNavigatePlatform}
            onNavigate={handleNavigate}
            onOpenDocs={handleOpenDocsApi}
          />
        );
      case "settings":
        return <PlatformSettingsScreen />;
      case "profile":
        return <ProfileScreen onNavigate={handleNavigate} />;
      case "docs":
        return <DocsScreen />;
      default:
        return <OverviewScreen onNavigate={handleNavigate} />;
    }
  };

  if (!hasSession) {
    if (currentScreen === "welcome") {
      return <LandingScreen onNavigate={handleNavigate} />;
    }
    return (
      <LoginScreen
        onNavigate={handleNavigate}
        identityState={identityState}
        onRetryIdentity={onRetryIdentity}
      />
    );
  }

  return (
    <AppShell
      currentScreen={currentScreen}
      onNavigate={handleNavigate}
      onNavigatePlatform={handleNavigatePlatform}
      onOpenDocsApi={handleOpenDocsApi}
      identityState={identityState}
    >
      {renderActiveScreen()}
    </AppShell>
  );
};

export const App: React.FC = () => {
  const [identityState, setIdentityState] = useState<IdentityState>({
    status: "loading",
  });

  const loadIdentity = () => {
    if (!api.getToken()) {
      setIdentityState({ status: "missing" });
      return;
    }
    setIdentityState({ status: "loading" });
    void api.getIdentity().then(setIdentityState);
  };

  useEffect(() => {
    loadIdentity();
    return api.subscribe(() => {
      loadIdentity();
    });
  }, []);

  return (
    <ThemeProvider>
      <I18nProvider>
        <SessionProvider identity={identityState.identity}>
          <PendingApprovalsProvider>
            <ToastProvider>
              <AppContent
                identityState={identityState}
                onRetryIdentity={loadIdentity}
              />
            </ToastProvider>
          </PendingApprovalsProvider>
        </SessionProvider>
      </I18nProvider>
    </ThemeProvider>
  );
};

export default App;
