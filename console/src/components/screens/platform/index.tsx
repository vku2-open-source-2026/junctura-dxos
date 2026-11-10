// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import type { ScreenId } from "../../../constants/modules";
import type { PlatformFunctionId } from "../../../constants/platformFunctions";
import { PlatformOverview } from "./PlatformOverview";
import { PlatformDetail } from "./PlatformDetail";

interface PlatformScreenProps {
  serviceId: PlatformFunctionId | null;
  onOpenService: (serviceId: PlatformFunctionId | null) => void;
  onNavigate: (screen: ScreenId) => void;
  onOpenDocs: () => void;
}

export const PlatformScreen: React.FC<PlatformScreenProps> = ({
  serviceId,
  onOpenService,
  onNavigate,
  onOpenDocs,
}) => {
  if (serviceId) {
    return (
      <PlatformDetail
        serviceId={serviceId}
        onBack={() => onOpenService(null)}
        onNavigate={onNavigate}
        onOpenDocs={onOpenDocs}
      />
    );
  }
  return (
    <PlatformOverview
      onOpenService={(id) => onOpenService(id)}
      onOpenDocs={onOpenDocs}
    />
  );
};
