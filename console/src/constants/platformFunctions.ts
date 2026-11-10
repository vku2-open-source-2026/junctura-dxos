// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import {
  AppWindow,
  Database,
  Fingerprint,
  FolderArchive,
  GitBranch,
  Network,
  Share2,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import type { ModuleId, ScreenId } from "./modules";

export const PLATFORM_FUNCTION_IDS = [
  "identity",
  "gateway",
  "data",
  "files",
  "workflows",
  "app-management",
  "capability-sharing",
  "security-audit",
] as const;

export type PlatformFunctionId = (typeof PLATFORM_FUNCTION_IDS)[number];
export type PlatformFunctionTier = "core" | "extended";

export interface PlatformFunctionDef {
  id: PlatformFunctionId;
  icon: LucideIcon;
  color: string;
  tier: PlatformFunctionTier;
  screens: ScreenId[];
}

export const PLATFORM_FUNCTIONS: Record<
  PlatformFunctionId,
  PlatformFunctionDef
> = {
  identity: {
    id: "identity",
    icon: Fingerprint,
    color: "bg-[#E5F0F3] text-[#176B80] dark:bg-[#4FB3C8]/10 dark:text-[#9AD4DF]",
    tier: "core",
    screens: [],
  },
  gateway: {
    id: "gateway",
    icon: Network,
    color:
      "bg-[#EEF1F2] text-[#4E5D64] dark:bg-[#9DB1BA]/10 dark:text-[#B9C9CF]",
    tier: "core",
    screens: [],
  },
  data: {
    id: "data",
    icon: Database,
    color:
      "bg-[#E6F5F3] text-[#18877A] dark:bg-[#5FCDBE]/10 dark:text-[#8FDCCF]",
    tier: "core",
    screens: ["records"],
  },
  files: {
    id: "files",
    icon: FolderArchive,
    color:
      "bg-[#FBF4EE] text-[#8A5A38] dark:bg-[#D8A581]/10 dark:text-[#E3B99E]",
    tier: "core",
    screens: ["files"],
  },
  workflows: {
    id: "workflows",
    icon: GitBranch,
    color:
      "bg-[#EDEFF6] text-[#4C5878] dark:bg-[#9AA7C7]/10 dark:text-[#B7C2DB]",
    tier: "core",
    screens: ["workflows"],
  },
  "app-management": {
    id: "app-management",
    icon: AppWindow,
    color:
      "bg-[#F7ECE8] text-[#8C5A4A] dark:bg-[#D8A581]/10 dark:text-[#E0BBAA]",
    tier: "extended",
    screens: ["apps", "queue"],
  },
  "capability-sharing": {
    id: "capability-sharing",
    icon: Share2,
    color:
      "bg-[#E4F2F0] text-[#0F6F66] dark:bg-[#5FCDBE]/10 dark:text-[#97D8CF]",
    tier: "extended",
    screens: ["connect-map", "caps", "grants"],
  },
  "security-audit": {
    id: "security-audit",
    icon: ShieldCheck,
    color:
      "bg-[#F1EFE6] text-[#6B6240] dark:bg-[#C7BE91]/10 dark:text-[#CFC7A6]",
    tier: "extended",
    screens: ["audit", "consents", "emergency"],
  },
};

export const PLATFORM_FUNCTION_LIST: PlatformFunctionDef[] =
  PLATFORM_FUNCTION_IDS.map((id) => PLATFORM_FUNCTIONS[id]);

export const PLATFORM_CORE_FUNCTIONS: PlatformFunctionDef[] =
  PLATFORM_FUNCTION_LIST.filter((item) => item.tier === "core");

export const PLATFORM_EXTENDED_FUNCTIONS: PlatformFunctionDef[] =
  PLATFORM_FUNCTION_LIST.filter((item) => item.tier === "extended");

export const PANEL_FUNCTION_IDS = [
  "data",
  "files",
  "workflows",
  "app-management",
  "capability-sharing",
  "security-audit",
] as const satisfies readonly PlatformFunctionId[];

export const PANEL_FUNCTION_LIST: PlatformFunctionDef[] =
  PANEL_FUNCTION_IDS.map((id) => PLATFORM_FUNCTIONS[id]);

export const PLATFORM_SIDEBAR_ITEM: Partial<
  Record<PlatformFunctionId, ModuleId>
> = {
  "app-management": "apps",
  "capability-sharing": "caps",
  "security-audit": "audit",
  data: "records",
  workflows: "workflows",
};

export function isPlatformFunctionId(
  value: string
): value is PlatformFunctionId {
  return (PLATFORM_FUNCTION_IDS as readonly string[]).includes(value);
}

export function platformFunctionForScreen(
  screen: ScreenId
): PlatformFunctionDef | undefined {
  return PLATFORM_FUNCTION_LIST.find((item) => item.screens.includes(screen));
}
