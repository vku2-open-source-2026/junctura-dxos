// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort(
    (a, b) => b - a
  );
  return (light + 0.05) / (dark + 0.05);
}

const LIGHT = {
  bg: "#F4F6F6",
  card: "#FFFFFF",
  border: "#DCE3E5",
  text: "#172F3D",
  muted: "#5B6B73",
  accent: "#176B80",
  accentSoft: "#E5F0F3",
  logoBlue: "#4FB3C8",
  logoGreen: "#5FCDBE",
  logoSand: "#D8A581",
  logoTile: "#172F3D",
};

const DARK = {
  bg: "#0D1A22",
  card: "#13242D",
  border: "#243843",
  text: "#E8F3F5",
  muted: "#9DB1BA",
  accent: "#4FB3C8",
  accentSoft: "#13242D",
  logoBlue: "#176B80",
  logoGreen: "#0F6F66",
  logoSand: "#8A5A38",
  logoTile: "#E8F3F5",
};

const MIN_TEXT_CONTRAST = 4.5;

describe("task 27 theme contrast", () => {
  it("keeps primary text pairs readable in light mode", () => {
    expect(contrast(LIGHT.text, LIGHT.bg)).toBeGreaterThanOrEqual(
      MIN_TEXT_CONTRAST
    );
    expect(contrast(LIGHT.text, LIGHT.card)).toBeGreaterThanOrEqual(
      MIN_TEXT_CONTRAST
    );
    expect(contrast(LIGHT.muted, LIGHT.bg)).toBeGreaterThanOrEqual(
      MIN_TEXT_CONTRAST
    );
    expect(contrast(LIGHT.muted, LIGHT.card)).toBeGreaterThanOrEqual(
      MIN_TEXT_CONTRAST
    );
    expect(contrast(LIGHT.accent, LIGHT.card)).toBeGreaterThanOrEqual(
      MIN_TEXT_CONTRAST
    );
    expect(contrast(LIGHT.accent, LIGHT.accentSoft)).toBeGreaterThanOrEqual(
      MIN_TEXT_CONTRAST
    );
  });

  it("keeps primary text pairs readable in dark mode", () => {
    expect(contrast(DARK.text, DARK.bg)).toBeGreaterThanOrEqual(
      MIN_TEXT_CONTRAST
    );
    expect(contrast(DARK.text, DARK.card)).toBeGreaterThanOrEqual(
      MIN_TEXT_CONTRAST
    );
    expect(contrast(DARK.muted, DARK.bg)).toBeGreaterThanOrEqual(
      MIN_TEXT_CONTRAST
    );
    expect(contrast(DARK.muted, DARK.card)).toBeGreaterThanOrEqual(
      MIN_TEXT_CONTRAST
    );
    expect(contrast(DARK.accent, DARK.bg)).toBeGreaterThanOrEqual(
      MIN_TEXT_CONTRAST
    );
    expect(contrast(DARK.accent, DARK.card)).toBeGreaterThanOrEqual(
      MIN_TEXT_CONTRAST
    );
  });

  it("keeps the logo readable on its tile in both modes", () => {
    expect(contrast(LIGHT.logoTile, LIGHT.card)).toBeGreaterThanOrEqual(
      MIN_TEXT_CONTRAST
    );
    expect(contrast(DARK.logoTile, DARK.card)).toBeGreaterThanOrEqual(
      MIN_TEXT_CONTRAST
    );
    for (const mark of [LIGHT.logoBlue, LIGHT.logoGreen, LIGHT.logoSand]) {
      expect(contrast(mark, LIGHT.logoTile)).toBeGreaterThanOrEqual(
        MIN_TEXT_CONTRAST
      );
    }
    for (const mark of [DARK.logoBlue, DARK.logoGreen, DARK.logoSand]) {
      expect(contrast(mark, DARK.logoTile)).toBeGreaterThanOrEqual(
        MIN_TEXT_CONTRAST
      );
    }
  });
});
