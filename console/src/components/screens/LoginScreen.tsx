// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { JuncturaLogo } from "../common/JuncturaLogo";
import { PublicControls } from "../common/PublicControls";
import { useI18n } from "../../locales/i18n";
import { getOidcError, type OidcErrorCode } from "../../services/oidc";
import { LoginBackdrop } from "./login/LoginBackdrop";
import { LoginForm } from "./login/LoginForm";
import type { IdentityState, ScreenId } from "../../types";

interface LoginScreenProps {
  onNavigate: (screen: ScreenId) => void;
  identityState: IdentityState;
  onRetryIdentity: () => void;
}

export const LoginScreen: React.FC<LoginScreenProps> = ({
  onNavigate,
  identityState,
  onRetryIdentity,
}) => {
  const { t } = useI18n();
  const [callbackError] = useState<OidcErrorCode | null>(getOidcError);

  const status = identityState.status;
  const needsSignOut =
    status === "forbidden" ||
    status === "rejected" ||
    status === "unavailable" ||
    status === "timeout";
  const identityNotice = needsSignOut
    ? status === "forbidden"
      ? t.identity.forbidden
      : t.identity[status]
    : null;

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-app-bg px-4 py-8 text-stone-ink dark:bg-[#0B161E] dark:text-slate-100">
      <LoginBackdrop />

      <main className="relative w-full max-w-[420px]">
        <div className="overflow-hidden rounded-md border border-slate-200/80 bg-white shadow-xl shadow-slate-900/5 dark:border-[#243843] dark:bg-[#13242D] dark:shadow-black/40">
          <div className="px-6 pb-5 pt-8 text-center sm:px-8">
            <div className="flex justify-center">
              <JuncturaLogo size={40} showText={true} />
            </div>
            <h1 className="mt-4 text-2xl font-bold tracking-tight text-stone-ink dark:text-slate-100">
              {t.login.title}
            </h1>
            <p className="mt-1 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
              {t.login.subtitle}
            </p>
          </div>

          <div className="px-6 pb-6 sm:px-8">
            <LoginForm
              callbackError={callbackError}
              identityNotice={identityNotice}
              onRetryIdentity={onRetryIdentity}
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 bg-slate-50/60 px-4 py-3 dark:border-[#243843]/70 dark:bg-[#0D1A22]/60">
            <PublicControls />
            <button
              type="button"
              onClick={() => onNavigate("welcome")}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-slate-500 transition-colors hover:bg-white hover:text-junctura-blue dark:text-slate-400 dark:hover:bg-[#1B303B] dark:hover:text-[var(--accent)]"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
              {t.login.backHome}
            </button>
          </div>
        </div>
      </main>
    </div>
  );
};
