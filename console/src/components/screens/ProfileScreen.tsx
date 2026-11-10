// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import {
  Globe,
  Laptop,
  LogOut,
  Moon,
  ShieldCheck,
  Sun,
  UserRound,
} from "lucide-react";
import type { ScreenId } from "../../constants/modules";
import { useI18n } from "../../locales/i18n";
import { useTheme } from "../../services/themeContext";
import { useSession } from "../../services/session";
import { useToast } from "../common/Toast";
import { PageHeader } from "../layout/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "../common/Card";
import { Badge } from "../common/Badge";
import { Button } from "../common/Button";

function initials(name: string): string {
  return name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(-2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
}

interface ProfileScreenProps {
  onNavigate: (screen: ScreenId) => void;
}

export const ProfileScreen: React.FC<ProfileScreenProps> = ({ onNavigate }) => {
  const { t, language, setLanguage } = useI18n();
  const { theme, setTheme } = useTheme();
  const { user, permissions, signOut } = useSession();
  const { showToast } = useToast();
  const s = t.profile;

  if (!user) return null;

  const handleSignOut = () => {
    signOut();
    showToast(s.signedOutToast);
    onNavigate("welcome");
  };

  const languageButtonClass = (active: boolean) =>
    `px-4 py-2 rounded-md border text-sm font-semibold transition-all cursor-pointer ${
      active
        ? "bg-[#176B80] text-white border-[#176B80] shadow-sm"
        : "bg-white dark:bg-[#1B303B]/40 border-slate-200 dark:border-[#243843] text-slate-700 dark:text-slate-300 hover:bg-slate-50"
    }`;

  const themeButtonClass = (active: boolean) =>
    `flex items-center gap-2 px-3.5 py-1.5 rounded-md border text-sm font-medium cursor-pointer ${
      active
        ? "bg-slate-100 dark:bg-slate-800 border-slate-400 text-stone-ink dark:text-slate-100 font-semibold"
        : "border-slate-200 dark:border-[#243843] text-slate-600 dark:text-slate-400"
    }`;

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader
        title={s.title}
        subtitle={s.subtitle}
      />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card className="overflow-visible">
          <CardContent className="space-y-5">
            <div className="flex items-center gap-4">
              <span
                className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-full bg-[#176B80] text-base font-semibold text-white"
                aria-hidden="true"
              >
                {initials(user.name)}
              </span>
              <div className="min-w-0">
                <h2 className="truncate text-base font-semibold text-stone-ink dark:text-slate-100">
                  {user.name}
                </h2>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <Badge variant="junctura">{user.roleName || "—"}</Badge>
                </div>
              </div>
            </div>

            <dl className="grid grid-cols-1 gap-3 border-t border-slate-100 pt-4 text-sm dark:border-[#243843]/70 sm:grid-cols-2">
              <div>
                <dt className="text-slate-500 dark:text-slate-400">
                  {s.nameLabel}
                </dt>
                <dd className="mt-0.5 break-all font-mono text-xs font-medium text-stone-ink dark:text-slate-100">
                  {user.id}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500 dark:text-slate-400">
                  {s.unitLabel}
                </dt>
                <dd className="mt-0.5 break-all font-medium text-stone-ink dark:text-slate-100">
                  {user.tenantId}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500 dark:text-slate-400">
                  {s.roleLabel}
                </dt>
                <dd className="mt-0.5 font-medium text-stone-ink dark:text-slate-100">
                  {user.roles.join(", ") || "—"}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-teal-600 dark:text-teal-400" />
              <CardTitle>{s.permissionsTitle}</CardTitle>
            </div>
            <Badge variant="outline">{permissions.length}</Badge>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm leading-relaxed text-slate-500 dark:text-slate-400">
              {s.permissionsDesc}
            </p>
            {permissions.length === 0 ? (
              <p className="text-sm text-slate-400">{s.noPermissions}</p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {permissions.map((permission) => (
                  <li key={permission}>
                    <Badge variant="teal">
                      {t.login.permissions[permission] ?? permission}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <UserRound className="h-5 w-5 text-junctura-blue dark:text-[var(--accent)]" />
            <CardTitle>{s.preferencesTitle}</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <p className="text-sm leading-relaxed text-slate-500 dark:text-slate-400">
            {s.preferencesDesc}
          </p>

          <div>
            <span className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-stone-ink dark:text-slate-200">
              <Globe className="h-3.5 w-3.5" aria-hidden="true" />
              {t.settings.languageLabel}
            </span>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => setLanguage("vi")}
                className={languageButtonClass(language === "vi")}
              >
                {t.settings.languageVi}
              </button>
              <button
                type="button"
                onClick={() => setLanguage("en")}
                className={languageButtonClass(language === "en")}
              >
                {t.settings.languageEn}
              </button>
            </div>
          </div>

          <div>
            <span className="mb-2 block text-sm font-semibold text-stone-ink dark:text-slate-200">
              {t.settings.themeLabel}
            </span>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => setTheme("light")}
                className={themeButtonClass(theme === "light")}
              >
                <Sun className="h-4 w-4 text-amber-500" />
                <span>{t.settings.lightTheme}</span>
              </button>
              <button
                type="button"
                onClick={() => setTheme("dark")}
                className={themeButtonClass(theme === "dark")}
              >
                <Moon className="h-4 w-4 text-sky-400" />
                <span>{t.settings.darkTheme}</span>
              </button>
              <button
                type="button"
                onClick={() => setTheme("system")}
                className={themeButtonClass(theme === "system")}
              >
                <Laptop className="h-4 w-4" />
                <span>{t.settings.systemTheme}</span>
              </button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{s.sessionTitle}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
          <p className="text-sm leading-relaxed text-slate-500 dark:text-slate-400">
            {s.sessionDesc}
          </p>
          <Button
            variant="destructive"
            size="md"
            leftIcon={<LogOut className="h-4 w-4" />}
            onClick={handleSignOut}
          >
            {s.signOut}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
};
