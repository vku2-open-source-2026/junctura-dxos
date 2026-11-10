// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import App from "../App";
import { api } from "../services/apiClient";
import { vi as viStrings } from "../locales/vi";
import { LOGIN_HINTS_URL } from "../services/loginHints";
import { TEST_IDENTITY } from "./apiMock";

const ACCOUNTS = [
  { username: "admin1", password: "fixture-secret-1", label: "Admin 1" },
  { username: "admin2", password: "fixture-secret-2", label: "Admin 2" },
];

interface FetchStubOptions {
  hints?: unknown;
  tokenStatus?: number;
  tokenBody?: unknown;
  tokenReject?: boolean;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(options: FetchStubOptions = {}) {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(LOGIN_HINTS_URL)) {
        return jsonResponse(200, options.hints ?? { accounts: ACCOUNTS });
      }
      if (url.includes("/protocol/openid-connect/token")) {
        if (options.tokenReject) throw new TypeError("network down");
        return jsonResponse(
          options.tokenStatus ?? 200,
          options.tokenBody ?? { access_token: "fixture-token" }
        );
      }
      if (url.includes("/v1/identity")) {
        return jsonResponse(200, TEST_IDENTITY);
      }
      return jsonResponse(404, {});
    }
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderLogin() {
  window.history.replaceState(null, "", "/#/login");
  return render(<App />);
}

async function findLoginHeading() {
  return screen.findByRole("heading", { name: viStrings.login.title });
}

describe("LoginScreen", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState(null, "", "/");
    api.setToken(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    sessionStorage.clear();
    api.setToken(null);
  });

  it("prefills the username and password from the optional hints file", async () => {
    stubFetch();
    renderLogin();
    await findLoginHeading();

    expect(await screen.findByDisplayValue("admin1")).toBeInTheDocument();
    expect(screen.getByLabelText(viStrings.login.passwordLabel)).toHaveValue(
      "fixture-secret-1"
    );
    expect(screen.queryByLabelText(/Tài khoản có sẵn/)).not.toBeInTheDocument();
  });

  it("exchanges the form credentials at the Keycloak token endpoint", async () => {
    const fetchMock = stubFetch();
    renderLogin();
    await findLoginHeading();
    await screen.findByDisplayValue("admin1");

    fireEvent.click(
      screen.getByRole("button", { name: viStrings.login.submit })
    );

    await waitFor(() => expect(api.getToken()).toBe("fixture-token"));

    const tokenCall = fetchMock.mock.calls.find(([input]) =>
      String(input).includes("/protocol/openid-connect/token")
    );
    if (!tokenCall) throw new Error("token endpoint was not called");
    const [url, init] = tokenCall;

    expect(String(url)).toBe(
      `${window.location.origin}/identity/realms/junctura/protocol/openid-connect/token`
    );
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("grant_type")).toBe("password");
    expect(body.get("client_id")).toBe("junctura-console");
    expect(body.get("scope")).toBe("openid");
    expect(body.get("username")).toBe("admin1");
    expect(body.get("password")).toBe("fixture-secret-1");
  });

  it("explains invalid credentials on a 401 response", async () => {
    stubFetch({ tokenStatus: 401, tokenBody: { error: "invalid_grant" } });
    renderLogin();
    await findLoginHeading();
    await screen.findByDisplayValue("admin1");

    fireEvent.click(
      screen.getByRole("button", { name: viStrings.login.submit })
    );

    expect(
      await screen.findByText(viStrings.login.invalidCredentials)
    ).toBeInTheDocument();
    expect(api.getToken()).toBeNull();
  });

  it("shows a plain network failure message when the token request fails", async () => {
    stubFetch({ tokenReject: true });
    renderLogin();
    await findLoginHeading();
    await screen.findByDisplayValue("admin1");

    fireEvent.click(
      screen.getByRole("button", { name: viStrings.login.submit })
    );

    expect(
      await screen.findByText(viStrings.login.loginFailed)
    ).toBeInTheDocument();
    expect(api.getToken()).toBeNull();
  });

  it("keeps the fields empty when the hints file is unavailable", async () => {
    stubFetch({ hints: { accounts: [] } });
    renderLogin();
    await findLoginHeading();

    expect(screen.queryByLabelText(/Tài khoản có sẵn/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(viStrings.login.usernameLabel)).toHaveValue(
      ""
    );
    expect(screen.getByLabelText(viStrings.login.passwordLabel)).toHaveValue(
      ""
    );
  });

  it("toggles password visibility", async () => {
    stubFetch();
    renderLogin();
    await findLoginHeading();
    await screen.findByDisplayValue("admin1");

    const passwordInput = screen.getByLabelText(viStrings.login.passwordLabel);
    expect(passwordInput).toHaveAttribute("type", "password");

    fireEvent.click(
      screen.getByRole("button", { name: viStrings.login.showPassword })
    );
    expect(passwordInput).toHaveAttribute("type", "text");

    fireEvent.click(
      screen.getByRole("button", { name: viStrings.login.hidePassword })
    );
    expect(passwordInput).toHaveAttribute("type", "password");
  });

  it("keeps SSO as a secondary action", async () => {
    stubFetch();
    renderLogin();
    await findLoginHeading();

    expect(
      screen.getByRole("button", { name: viStrings.login.sso })
    ).toBeInTheDocument();
    expect(
      screen.getByText(viStrings.login.or)
    ).toBeInTheDocument();
  });

  it("requires a username before submitting", async () => {
    stubFetch();
    renderLogin();
    await findLoginHeading();
    await screen.findByDisplayValue("admin1");

    fireEvent.change(screen.getByLabelText(viStrings.login.usernameLabel), {
      target: { value: "  " },
    });
    fireEvent.click(
      screen.getByRole("button", { name: viStrings.login.submit })
    );

    expect(
      await screen.findByText(viStrings.login.usernameRequired)
    ).toBeInTheDocument();
    expect(api.getToken()).toBeNull();
  });
});
