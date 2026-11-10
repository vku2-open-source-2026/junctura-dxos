// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0

export interface LoginHintAccount {
  label: string;
  username: string;
  password: string;
}

export const LOGIN_HINTS_URL = "/login-hints.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function parseLoginHints(payload: unknown): LoginHintAccount[] {
  if (!isRecord(payload) || !Array.isArray(payload.accounts)) return [];
  const accounts: LoginHintAccount[] = [];
  for (const entry of payload.accounts) {
    if (!isRecord(entry)) continue;
    const { username, password, label } = entry;
    if (!nonEmptyString(username) || typeof password !== "string") continue;
    accounts.push({
      username: username.trim(),
      password,
      label: nonEmptyString(label) ? label.trim() : username.trim(),
    });
  }
  return accounts;
}

export async function fetchLoginHints(
  signal?: AbortSignal
): Promise<LoginHintAccount[]> {
  try {
    const response = await fetch(LOGIN_HINTS_URL, {
      headers: { Accept: "application/json" },
      signal,
    });
    if (!response.ok) return [];
    const payload: unknown = await response.json();
    return parseLoginHints(payload);
  } catch {
    return [];
  }
}
