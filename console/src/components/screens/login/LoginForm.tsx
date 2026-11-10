// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, KeyRound, LogOut, ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "../../common/Button";
import { useI18n } from "../../../locales/i18n";
import { useSession } from "../../../services/session";
import {
  clearOidcError,
  PasswordSignInError,
  signInWithPassword,
  startLogin,
  type OidcErrorCode,
} from "../../../services/oidc";
import { fetchLoginHints } from "../../../services/loginHints";

const inputClassName =
  "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-stone-ink placeholder:text-slate-400 focus:border-junctura-blue focus:outline-none focus:ring-1 focus:ring-junctura-blue dark:border-[#33505C] dark:bg-[#0D1A22] dark:text-slate-100 dark:placeholder:text-slate-500";

interface LoginFormProps {
  callbackError: OidcErrorCode | null;
  identityNotice: string | null;
  onRetryIdentity: () => void;
}

export const LoginForm: React.FC<LoginFormProps> = ({
  callbackError,
  identityNotice,
  onRetryIdentity,
}) => {
  const { t } = useI18n();
  const { signOut } = useSession();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState<"password" | "sso" | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const touchedRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetchLoginHints(controller.signal).then((list) => {
      if (controller.signal.aborted) return;
      if (list.length > 0 && !touchedRef.current) {
        setUsername(list[0].username);
        setPassword(list[0].password);
      }
    });
    return () => controller.abort();
  }, []);

  const handlePasswordLogin = async (
    event: React.FormEvent<HTMLFormElement>
  ) => {
    event.preventDefault();
    if (busy) return;

    const trimmedUsername = username.trim();
    if (!trimmedUsername) {
      setLoginError(t.login.usernameRequired);
      return;
    }
    if (!password) {
      setLoginError(t.login.passwordRequired);
      return;
    }

    setLoginError(null);
    clearOidcError();
    setBusy("password");
    try {
      await signInWithPassword(trimmedUsername, password);
    } catch (error) {
      setLoginError(
        error instanceof PasswordSignInError &&
          error.code === "invalid_credentials"
          ? t.login.invalidCredentials
          : t.login.loginFailed
      );
    } finally {
      setBusy(null);
    }
  };

  const handleSso = async () => {
    if (busy) return;
    setLoginError(null);
    clearOidcError();
    setBusy("sso");
    try {
      await startLogin(username.trim() || undefined);
    } catch {
      setLoginError(t.login.ssoNotConfigured);
      setBusy(null);
    }
  };

  const oidcMessage =
    callbackError === "sso_not_configured"
      ? t.login.ssoNotConfigured
      : callbackError
        ? t.login.ssoFailed
        : null;
  const authNotice = loginError ?? oidcMessage;

  return (
    <form
      className="space-y-3.5"
      onSubmit={(event) => void handlePasswordLogin(event)}
      noValidate
    >
      <div>
        <label
          htmlFor="login-username"
          className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300"
        >
          {t.login.usernameLabel}
        </label>
        <input
          id="login-username"
          name="username"
          type="text"
          autoComplete="username"
          autoFocus
          value={username}
          onChange={(event) => {
            touchedRef.current = true;
            setUsername(event.target.value);
          }}
          placeholder={t.login.usernamePlaceholder}
          className={inputClassName}
        />
      </div>

      <div>
        <label
          htmlFor="login-password"
          className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300"
        >
          {t.login.passwordLabel}
        </label>
        <div className="relative">
          <input
            id="login-password"
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            value={password}
            onChange={(event) => {
              touchedRef.current = true;
              setPassword(event.target.value);
            }}
            placeholder={t.login.passwordPlaceholder}
            className={`${inputClassName} pr-11`}
          />
          <button
            type="button"
            onClick={() => setShowPassword((current) => !current)}
            aria-label={
              showPassword ? t.login.hidePassword : t.login.showPassword
            }
            title={
              showPassword ? t.login.hidePassword : t.login.showPassword
            }
            className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-md text-slate-500 transition-colors hover:text-junctura-blue focus:outline-none focus:ring-1 focus:ring-junctura-blue dark:text-slate-400 dark:hover:text-[var(--accent)]"
          >
            {showPassword ? (
              <EyeOff className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Eye className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>

      {authNotice && (
        <p
          role="alert"
          aria-live="polite"
          className="flex items-start gap-1.5 text-sm leading-relaxed text-amber-700 dark:text-amber-300"
        >
          <ShieldAlert
            className="mt-0.5 h-3.5 w-3.5 flex-shrink-0"
            aria-hidden="true"
          />
          {authNotice}
        </p>
      )}

      <Button
        type="submit"
        variant="primary"
        size="lg"
        isLoading={busy === "password"}
        disabled={busy !== null}
        leftIcon={
          busy !== "password" ? (
            <KeyRound className="h-4 w-4" aria-hidden="true" />
          ) : undefined
        }
        className="w-full"
      >
        {busy === "password" ? t.login.submitting : t.login.submit}
      </Button>

      <div className="flex items-center gap-3">
        <span
          className="h-px flex-1 bg-slate-200 dark:bg-[#243843]"
          aria-hidden="true"
        />
        <span className="text-xs font-medium text-slate-400 dark:text-slate-500">
          {t.login.or}
        </span>
        <span
          className="h-px flex-1 bg-slate-200 dark:bg-[#243843]"
          aria-hidden="true"
        />
      </div>

      <Button
        type="button"
        variant="outline"
        size="lg"
        onClick={() => void handleSso()}
        isLoading={busy === "sso"}
        disabled={busy !== null}
        leftIcon={
          busy !== "sso" ? (
            <ShieldCheck className="h-4 w-4" aria-hidden="true" />
          ) : undefined
        }
        className="w-full"
      >
        {busy === "sso" ? t.login.ssoBusy : t.login.sso}
      </Button>

      {identityNotice && (
        <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
          <p role="status" className="leading-relaxed">
            {identityNotice}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={onRetryIdentity}
              leftIcon={<KeyRound className="h-3.5 w-3.5" aria-hidden="true" />}
            >
              {t.common.retry}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={signOut}
              leftIcon={<LogOut className="h-3.5 w-3.5" aria-hidden="true" />}
            >
              {t.session.signOut}
            </Button>
          </div>
        </div>
      )}
    </form>
  );
};
