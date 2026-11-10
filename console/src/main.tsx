// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { handleCallback } from "./services/oidc";
import "./index.css";

const rootElement = document.getElementById("root");

async function bootstrap(): Promise<void> {
  const result = await handleCallback();
  if (result.status === "success") {
    window.history.replaceState(null, "", "#/dashboard");
  } else if (result.status === "error") {
    window.history.replaceState(null, "", "#/login");
  }
  if (!rootElement) return;
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

void bootstrap();
