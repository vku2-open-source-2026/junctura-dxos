// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import React, { createContext, useContext, useState, useEffect } from "react";
import { TextSize, Theme } from "../types";

export const TEXT_SIZE_STORAGE_KEY = "junctura_text_size";
const DEFAULT_TEXT_SIZE: TextSize = "md";

function readStoredTextSize(): TextSize {
  const saved = localStorage.getItem(TEXT_SIZE_STORAGE_KEY);
  return saved === "sm" || saved === "md" || saved === "lg"
    ? saved
    : DEFAULT_TEXT_SIZE;
}

interface ThemeContextType {
  theme: Theme;
  isDark: boolean;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  textSize: TextSize;
  setTextSize: (size: TextSize) => void;
}

const ThemeContext = createContext<ThemeContextType | null>(null);

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [theme, setThemeState] = useState<Theme>(() => {
    const saved = localStorage.getItem("junctura_theme");
    return (saved === "light" || saved === "dark" || saved === "system") ? saved : "light";
  });

  const [textSize, setTextSizeState] = useState<TextSize>(readStoredTextSize);

  const [isDark, setIsDark] = useState<boolean>(false);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-text-size", textSize);
    localStorage.setItem(TEXT_SIZE_STORAGE_KEY, textSize);
  }, [textSize]);

  useEffect(() => {
    const root = document.documentElement;
    let dark = false;

    if (theme === "dark") {
      dark = true;
    } else if (theme === "system") {
      dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    }

    setIsDark(dark);
    if (dark) {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
    localStorage.setItem("junctura_theme", theme);
  }, [theme]);

  const setTheme = (newTheme: Theme) => {
    setThemeState(newTheme);
  };

  const toggleTheme = () => {
    setThemeState((prev) => (prev === "dark" ? "light" : "dark"));
  };

  const setTextSize = (size: TextSize) => {
    setTextSizeState(size);
  };

  return (
    <ThemeContext.Provider
      value={{ theme, isDark, setTheme, toggleTheme, textSize, setTextSize }}
    >
      {children}
    </ThemeContext.Provider>
  );
};

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
