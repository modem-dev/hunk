import { describe, expect, test } from "bun:test";
import { BUNDLED_SHIKI_THEME_IDS } from "../../packages/hunk/src/core/theme/catalog";
import { TERMINAL_THEME_ID } from "../../packages/hunk/src/core/theme/terminalColors";
import { THEMES } from "../../packages/hunk/src/ui/themes";
import { buildWebThemeIndex, renderReviewPageDocument } from "./build-web";

describe("buildWebThemeIndex", () => {
  // Intent: the browser gets the terminal's own resolved tokens for every built-in theme,
  // so there is no second derivation to drift, and the terminal theme is left out.
  test("carries every built-in theme's tokens as the terminal resolves them", () => {
    const index = buildWebThemeIndex();

    expect(index.themes.map((theme) => theme.id)).toEqual([...BUNDLED_SHIKI_THEME_IDS]);
    expect(index.themes.some((theme) => theme.id === TERMINAL_THEME_ID)).toBe(false);
    for (const [position, theme] of index.themes.entries()) {
      const source = THEMES[position]!;
      expect(theme.appearance).toBe(source.appearance);
      expect(theme.tokens.addedBg).toBe(source.addedBg);
      expect(theme.tokens.fileNew).toBe(source.fileNew);
      expect(Object.values(theme.tokens).every((value) => typeof value === "string")).toBe(true);
    }
  });
});

describe("renderReviewPageDocument", () => {
  test("names the theme index and loads only hashed assets", () => {
    const html = renderReviewPageDocument("main-1.js", ["main-1.css"], "themes-1.json");

    expect(html).toContain('<meta name="hunk-theme-index" content="/review-assets/themes-1.json">');
    expect(html).toContain('<script type="module" src="/review-assets/main-1.js">');
    expect(html).not.toMatch(/<script>|<style>|style="/);
  });
});
