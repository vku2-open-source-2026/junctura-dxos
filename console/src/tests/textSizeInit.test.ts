// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function scriptTags(html: string): string[] {
  return html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) ?? [];
}

function openingTag(tag: string): string {
  const end = tag.indexOf(">");
  return end === -1 ? tag : tag.slice(0, end + 1);
}

describe("Text size initialization script", () => {
  const html = readFileSync(join(process.cwd(), "index.html"), "utf8");

  it("loads the text size initializer from a same-origin file", () => {
    expect(html).toContain('<script src="/text-size-init.js"></script>');
  });

  it("does not rely on inline scripts that the CSP would block", () => {
    const inline = scriptTags(html).filter(
      (tag) => !/\bsrc\s*=/i.test(openingTag(tag))
    );

    expect(inline).toEqual([]);
  });
});
