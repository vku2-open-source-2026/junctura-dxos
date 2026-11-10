// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import {
  Activity,
  AlertTriangle,
  AppWindow,
  Building2,
  CheckCircle2,
  FolderArchive,
  GitBranch,
  Home,
  Inbox,
  Link2,
  List,
  Network,
  Plug,
  Settings,
  Table2,
  Users,
  type LucideIcon,
  ScrollText,
} from "lucide-react";

export type PermId =
  | "applications.write"
  | "applications.approve"
  | "trust.write"
  | "trust.approve"
  | "audit.read"
  | "core-reader"
  | "core-writer";

export const MODULE_GROUPS = [
  { id: "overview" },
  { id: "connect" },
  { id: "data" },
  { id: "process" },
  { id: "access" },
  { id: "security" },
  { id: "system" },
] as const;

export type ModuleGroupId = (typeof MODULE_GROUPS)[number]["id"];

export interface ModuleDef {
  id: string;
  group: ModuleGroupId;
  icon: LucideIcon;
  perm?: PermId;
  badgeKey?: "pending";
}

export const MODULES = [
  { id: "dashboard", group: "overview", icon: Home },
  { id: "traffic", group: "overview", icon: Activity },
  { id: "requests", group: "overview", icon: List },
  { id: "queue", group: "overview", icon: Inbox, badgeKey: "pending" },
  { id: "apps", group: "connect", icon: AppWindow },
  { id: "connect-map", group: "connect", icon: Network },
  { id: "caps", group: "connect", icon: Plug },
  { id: "grants", group: "connect", icon: Link2 },
  { id: "records", group: "data", icon: Table2, perm: "audit.read" },
  {
    id: "files",
    group: "data",
    icon: FolderArchive,
    perm: "audit.read",
  },
  { id: "workflows", group: "process", icon: GitBranch },
  { id: "users", group: "access", icon: Users, perm: "audit.read" },
  { id: "orgs", group: "access", icon: Building2, perm: "audit.read" },
  { id: "audit", group: "security", icon: ScrollText, perm: "audit.read" },
  {
    id: "consents",
    group: "security",
    icon: CheckCircle2,
    perm: "audit.read",
  },
  {
    id: "emergency",
    group: "security",
    icon: AlertTriangle,
    perm: "audit.read",
  },
  { id: "settings", group: "system", icon: Settings },
] as const satisfies readonly ModuleDef[];

export type ModuleId = (typeof MODULES)[number]["id"];

export type ScreenId =
  | ModuleId
  | "welcome"
  | "login"
  | "docs"
  | "profile"
  | "platform";

export const MODULE_IDS: ModuleId[] = MODULES.map((module) => module.id);

export const SIDEBAR_ITEM_IDS = [
  "dashboard",
  "queue",
  "apps",
  "caps",
  "users",
  "orgs",
  "audit",
] as const satisfies readonly ModuleId[];

export type SidebarItemId = (typeof SIDEBAR_ITEM_IDS)[number];

export const SIDEBAR_SCREEN_MAP: Partial<Record<ScreenId, ModuleId>> = {
  dashboard: "dashboard",
  traffic: "dashboard",
  requests: "dashboard",
  queue: "queue",
  apps: "apps",
  caps: "caps",
  "connect-map": "caps",
  grants: "caps",
  records: "records",
  files: "files",
  workflows: "workflows",
  users: "users",
  orgs: "orgs",
  audit: "audit",
  consents: "audit",
  emergency: "audit",
  settings: "settings",
};

export const SYSTEM_SCREEN_IDS: ScreenId[] = ["settings"];

export const DASHBOARD_SCREEN_IDS = [
  "dashboard",
  "traffic",
  "requests",
] as const satisfies readonly ScreenId[];

export function isModuleId(value: string): value is ModuleId {
  return (MODULE_IDS as string[]).includes(value);
}

export function getModule(id: string): ModuleDef | undefined {
  return MODULES.find((module) => module.id === id);
}

export function getModuleGroup(
  id: string
): (typeof MODULE_GROUPS)[number] | undefined {
  return MODULE_GROUPS.find((group) => group.id === id);
}
