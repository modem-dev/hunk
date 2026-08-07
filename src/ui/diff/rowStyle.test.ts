import { describe, expect, test } from "bun:test";
import { contrastRatio } from "../lib/color";
import { THEMES, TRANSPARENT_BACKGROUND, withTransparentSurfaces } from "../themes";
import { cursorLineHighlightBg, stackCellPalette } from "./rowStyle";

const DARK = THEMES.find((theme) => theme.id === "github-dark-dimmed")!;
const LIGHT = THEMES.find((theme) => theme.id === "github-light-default")!;

describe("cursorLineHighlightBg", () => {
  test("marks context rows on transparent surfaces", () => {
    for (const base of [DARK, LIGHT]) {
      const theme = withTransparentSurfaces(base);
      const context = stackCellPalette("context", theme);

      expect(context.contentBg).toBe(TRANSPARENT_BACKGROUND);
      expect(cursorLineHighlightBg(context.contentBg, theme)).not.toBe(TRANSPARENT_BACKGROUND);
    }
  });

  test("keeps the marked row readable on every built-in theme", () => {
    for (const base of THEMES) {
      for (const theme of [base, withTransparentSurfaces(base)]) {
        for (const kind of ["context", "addition", "deletion"] as const) {
          const marked = cursorLineHighlightBg(stackCellPalette(kind, theme).contentBg, theme);
          expect(contrastRatio(theme.text, marked)).toBeGreaterThan(3);
        }
      }
    }
  });

  test("moves added and removed rows as far as it moves context rows", () => {
    const context = stackCellPalette("context", DARK).contentBg;
    const added = stackCellPalette("addition", DARK).contentBg;

    const shift = (from: string) => {
      const to = cursorLineHighlightBg(from, DARK);
      return contrastRatio(to, from);
    };

    expect(shift(added)).toBeGreaterThan(1.2);
    expect(shift(context)).toBeGreaterThan(1.2);
  });
});
