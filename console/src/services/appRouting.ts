// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { MODULE_IDS, type ScreenId } from "../constants/modules";
import {
  isPlatformFunctionId,
  type PlatformFunctionId,
} from "../constants/platformFunctions";

const LEGACY_SCREEN_MAP: Record<string, ScreenId> = {
  overview: "dashboard",
  applications: "apps",
  capabilities: "caps",
  resources: "records",
  security: "audit",
  cores: "platform",
  services: "platform",
  "getting-started": "docs",
  "api-explorer": "docs",
  workflows: "workflows",
  settings: "settings",
};

const EXTRA_SCREENS: ScreenId[] = [
  "welcome",
  "login",
  "docs",
  "profile",
  "platform",
];

const VALID_SCREENS: ScreenId[] = [...MODULE_IDS, ...EXTRA_SCREENS];

function isScreenId(value: string): value is ScreenId {
  return (VALID_SCREENS as string[]).includes(value);
}

export function hashPath(): string[] {
  const hash = window.location.hash.replace(/^#\/?/, "");
  return hash.split("?")[0].split("/").filter(Boolean);
}

export function screenFromHash(): ScreenId {
  const path = hashPath();
  if (path.length === 0) return "welcome";
  const segment = path[0];
  const mapped = LEGACY_SCREEN_MAP[segment] ?? segment;
  return isScreenId(mapped) ? mapped : "welcome";
}

export function platformIdFromHash(): PlatformFunctionId | null {
  const path = hashPath();
  if (path[0] !== "platform" || !path[1]) return null;
  return isPlatformFunctionId(path[1]) ? path[1] : null;
}
