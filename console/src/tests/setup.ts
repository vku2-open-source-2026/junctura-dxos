// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import "@testing-library/jest-dom";
import { configure } from "@testing-library/react";

configure({ asyncUtilTimeout: 12000 });

Object.defineProperty(window, "scrollTo", {
  writable: true,
  value: () => {},
});

// Mock matchMedia for jsdom
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});
