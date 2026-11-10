// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useEffect, useRef, useState } from "react";
import { LogOut, Settings, UserRound } from "lucide-react";
import type { ScreenId } from "../../constants/modules";
import { useI18n } from "../../locales/i18n";
import { useSession } from "../../services/session";

function initials(name: string): string {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(-2)
    .map((word) => word[0])
    .join("")
    .toUpperCase();
}

interface SidebarAccountProps {
  onNavigate: (screen: ScreenId) => void;
  isCollapsed: boolean;
  embedded: boolean;
}

export const SidebarAccount: React.FC<SidebarAccountProps> = ({
  onNavigate,
  isCollapsed,
  embedded,
}) => {
  const { t } = useI18n();
  const { user, signOut } = useSession();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const rail = isCollapsed && !embedded;

  useEffect(() => {
    if (!open) return;
    const handleClick = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const roleLabel = user ? user.roleName : "";

  return (
    <div
      className="relative border-t border-[var(--border)] p-2"
      ref={containerRef}
    >
      {user ? (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-label={t.sidebar.accountMenu}
          aria-expanded={open}
          className={`flex w-full items-center gap-2.5 rounded-lg p-1.5 text-left transition-colors hover:bg-slate-500/10 ${
            rail ? "justify-center" : ""
          }`}
        >
          <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-xs font-semibold text-white">
            {initials(user.name)}
          </span>
          {!rail && (
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-[var(--text)]">
                {user.name}
              </p>
              <p className="truncate text-xs text-[var(--muted)]">{roleLabel}</p>
            </div>
          )}
        </button>
      ) : (
        !rail && (
          <p className="px-1 text-sm text-[var(--muted)]">
            {t.session.signedOut}
          </p>
        )
      )}

      {open && user && (
        <div
          role="menu"
          aria-label={t.sidebar.accountMenu}
          className={`absolute bottom-full z-50 mb-2 w-52 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--card)] p-1 shadow-xl ${
            rail ? "left-0" : "left-2 right-2 w-auto"
          }`}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onNavigate("profile");
            }}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-[var(--text)] hover:bg-slate-500/10"
          >
            <UserRound className="h-4 w-4" aria-hidden="true" />
            {t.profile.title}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onNavigate("settings");
            }}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-[var(--text)] hover:bg-slate-500/10"
          >
            <Settings className="h-4 w-4" aria-hidden="true" />
            {t.modules.settings.label}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              signOut();
              onNavigate("welcome");
            }}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-rose-600 hover:bg-rose-500/10 dark:text-rose-300"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" />
            {t.session.signOut}
          </button>
        </div>
      )}
    </div>
  );
};
