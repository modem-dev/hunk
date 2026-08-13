import { describe, expect, test } from "bun:test";
import { contrastRatio, hexColorDistance } from "../lib/color";
import { THEMES, TRANSPARENT_BACKGROUND, withTransparentSurfaces } from "../themes";
import { cursorLineHighlightBg, lineHighlightToneBg, stackCellPalette } from "./rowStyle";

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

describe("lineHighlightToneBg", () => {
  const TONES = ["match", "current", "info", "warning", "error"] as const;

  test("clears the minimum visible distance on every line kind of every built-in theme", () => {
    for (const theme of THEMES) {
      for (const kind of ["context", "addition", "deletion"] as const) {
        const baseBg = stackCellPalette(kind, theme).contentBg;
        for (const tone of TONES) {
          const resolved = lineHighlightToneBg(tone, baseBg, theme);
          expect(resolved).toBeDefined();
          // The word-diff guarantee applied to extension marks: a mark is
          // never invisible on the background it sits on.
          expect(hexColorDistance(resolved!, baseBg)).toBeGreaterThanOrEqual(28);
        }
      }
    }
  });

  test("makes the current mark stand apart from its match siblings", () => {
    for (const theme of THEMES) {
      for (const kind of ["context", "addition", "deletion"] as const) {
        const baseBg = stackCellPalette(kind, theme).contentBg;
        const match = lineHighlightToneBg("match", baseBg, theme)!;
        const current = lineHighlightToneBg("current", baseBg, theme)!;
        expect(hexColorDistance(current, match)).toBeGreaterThan(0);
        expect(hexColorDistance(current, baseBg)).toBeGreaterThan(hexColorDistance(match, baseBg));
      }
    }
  });

  test("declines transparent surfaces instead of blending toward black", () => {
    const theme = withTransparentSurfaces(THEMES[0]!);
    const contextBg = stackCellPalette("context", theme).contentBg;
    expect(contextBg).toBe(TRANSPARENT_BACKGROUND);
    expect(lineHighlightToneBg("match", contextBg, theme)).toBeUndefined();
  });

  test("keeps code readable over every resolved tone background", () => {
    for (const theme of THEMES) {
      const baseBg = stackCellPalette("context", theme).contentBg;
      for (const tone of TONES) {
        const resolved = lineHighlightToneBg(tone, baseBg, theme);
        expect(contrastRatio(theme.text, resolved!)).toBeGreaterThan(3);
      }
    }
  });
});
