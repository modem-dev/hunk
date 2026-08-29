import { describe, expect, test } from "bun:test";
import { contrastRatio, hexColorDistance } from "../lib/color";
import { THEMES, TRANSPARENT_BACKGROUND, withTransparentSurfaces } from "../themes";
import { cursorLineHighlightBg, lineHighlightToneStyle, stackCellPalette } from "./rowStyle";

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

describe("lineHighlightToneStyle", () => {
  const TINTED_TONES = ["match", "info", "warning", "error"] as const;

  test("clears a strong visible distance on every line kind of every built-in theme", () => {
    for (const theme of THEMES) {
      for (const kind of ["context", "addition", "deletion"] as const) {
        const baseBg = stackCellPalette(kind, theme).contentBg;
        for (const tone of TINTED_TONES) {
          const resolved = lineHighlightToneStyle(tone, baseBg, theme);
          expect(resolved).toBeDefined();
          // The target floor is 72 — well above word diff's 28 whisper — but
          // the readability guard may bind first on a few theme/tone pairs;
          // 60 is the strongest distance every combination can guarantee
          // while the code on top stays readable.
          expect(hexColorDistance(resolved!.bg, baseBg)).toBeGreaterThanOrEqual(60);
        }
      }
    }
  });

  test("paints the current mark as reverse video, unmistakable on every theme", () => {
    for (const theme of THEMES) {
      for (const kind of ["context", "addition", "deletion"] as const) {
        const baseBg = stackCellPalette(kind, theme).contentBg;
        const match = lineHighlightToneStyle("match", baseBg, theme)!;
        const current = lineHighlightToneStyle("current", baseBg, theme)!;
        // Inversion: theme text becomes the block, theme background the glyphs.
        expect(current).toEqual({ bg: theme.text, fg: theme.background });
        // The active hit must dominate both the line and its siblings.
        expect(hexColorDistance(current.bg, baseBg)).toBeGreaterThan(
          hexColorDistance(match.bg, baseBg),
        );
        expect(contrastRatio(current.fg!, current.bg)).toBeGreaterThan(3);
      }
    }
  });

  test("paints a visible readable mark on transparent surfaces", () => {
    // Most themes render context content transparent under the transparent
    // surface option, and most search hits land on context lines — so declining
    // this case silently painted nothing in the common case.
    for (const base of THEMES) {
      const theme = withTransparentSurfaces(base);
      const contextBg = stackCellPalette("context", theme).contentBg;
      expect(contextBg).toBe(TRANSPARENT_BACKGROUND);
      const assumed = theme.appearance === "dark" ? "#000000" : "#ffffff";

      for (const tone of TINTED_TONES) {
        const resolved = lineHighlightToneStyle(tone, contextBg, theme);
        expect(resolved).toBeDefined();
        expect(resolved!.bg).not.toBe(TRANSPARENT_BACKGROUND);
        // Visible against the surface the terminal effectively shows, and still
        // readable under the code painted on top of it.
        expect(hexColorDistance(resolved!.bg, assumed)).toBeGreaterThanOrEqual(60);
        expect(contrastRatio(theme.text, resolved!.bg)).toBeGreaterThan(3);
      }
    }
  });

  test("keeps the current mark reverse video on transparent surfaces", () => {
    for (const base of THEMES) {
      const theme = withTransparentSurfaces(base);
      const current = lineHighlightToneStyle("current", TRANSPARENT_BACKGROUND, theme)!;
      expect(current.bg).toBe(theme.text);
      expect(current.fg).not.toBe(TRANSPARENT_BACKGROUND);
      expect(contrastRatio(current.fg!, current.bg)).toBeGreaterThan(3);
    }
  });

  test("keeps code readable over every resolved tinted background", () => {
    for (const theme of THEMES) {
      const baseBg = stackCellPalette("context", theme).contentBg;
      for (const tone of TINTED_TONES) {
        const resolved = lineHighlightToneStyle(tone, baseBg, theme);
        expect(contrastRatio(theme.text, resolved!.bg)).toBeGreaterThan(3);
      }
    }
  });

  test("resolves dim tone to transform foreground toward background with readable contrast", () => {
    for (const theme of THEMES) {
      for (const kind of ["context", "addition", "deletion"] as const) {
        const baseBg = stackCellPalette(kind, theme).contentBg;
        const resolved = lineHighlightToneStyle("dim", baseBg, theme);
        expect(resolved).toBeDefined();
        expect(resolved!.transformFg).toBeDefined();

        const syntaxFg = "#e06c75";
        const dimmed = resolved!.transformFg!(syntaxFg, baseBg);
        const effectiveBg =
          baseBg === TRANSPARENT_BACKGROUND
            ? theme.appearance === "dark"
              ? "#000000"
              : "#ffffff"
            : baseBg;
        expect(contrastRatio(dimmed, effectiveBg)).toBeGreaterThanOrEqual(1.6);
        // Dimmed foreground must be closer to background than the original foreground
        expect(hexColorDistance(dimmed, effectiveBg)).toBeLessThan(
          hexColorDistance(syntaxFg, effectiveBg),
        );
      }
    }
  });

  test("resolves dim tone on transparent surfaces to readable contrast", () => {
    for (const base of THEMES) {
      const theme = withTransparentSurfaces(base);
      const contextBg = stackCellPalette("context", theme).contentBg;
      expect(contextBg).toBe(TRANSPARENT_BACKGROUND);
      const assumedBg = theme.appearance === "dark" ? "#000000" : "#ffffff";

      const resolved = lineHighlightToneStyle("dim", contextBg, theme);
      expect(resolved).toBeDefined();
      expect(resolved!.transformFg).toBeDefined();

      const syntaxFg = "#e06c75";
      const dimmed = resolved!.transformFg!(syntaxFg, contextBg);
      expect(contrastRatio(dimmed, assumedBg)).toBeGreaterThanOrEqual(1.6);
      expect(hexColorDistance(dimmed, assumedBg)).toBeLessThan(
        hexColorDistance(syntaxFg, assumedBg),
      );
    }
  });
});
