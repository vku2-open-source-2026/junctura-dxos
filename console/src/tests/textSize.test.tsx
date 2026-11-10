// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../locales/i18n";
import { vi as viStrings } from "../locales/vi";
import {
  TEXT_SIZE_STORAGE_KEY,
  ThemeProvider,
} from "../services/themeContext";
import { TextSizeSelector } from "../components/common/TextSizeSelector";

function renderSelector() {
  return render(
    <ThemeProvider>
      <I18nProvider>
        <TextSizeSelector />
      </I18nProvider>
    </ThemeProvider>
  );
}

function collectSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "tests" ? [] : collectSourceFiles(fullPath);
    }
    return /\.(ts|tsx)$/.test(entry.name) ? [fullPath] : [];
  });
}

describe("Text size preference", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-text-size");
  });

  afterEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-text-size");
  });

  it("applies and persists the chosen size on the document element", () => {
    localStorage.setItem(TEXT_SIZE_STORAGE_KEY, "lg");
    renderSelector();

    expect(document.documentElement).toHaveAttribute("data-text-size", "lg");
    expect(
      screen.getByRole("button", { name: viStrings.settings.textSizeLarge })
    ).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(
      screen.getByRole("button", { name: viStrings.settings.textSizeSmall })
    );

    expect(document.documentElement).toHaveAttribute("data-text-size", "sm");
    expect(localStorage.getItem(TEXT_SIZE_STORAGE_KEY)).toBe("sm");
  });

  it("defaults to the medium size", () => {
    renderSelector();

    expect(document.documentElement).toHaveAttribute("data-text-size", "md");
    expect(
      screen.getByRole("button", { name: viStrings.settings.textSizeMedium })
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("does not use hard-coded pixel font sizes in source files", () => {
    const srcDir = join(process.cwd(), "src");
    const offenders = collectSourceFiles(srcDir).filter((file) =>
      /text-\[[0-9]+px\]/.test(readFileSync(file, "utf8"))
    );

    expect(offenders).toEqual([]);
  });
});
