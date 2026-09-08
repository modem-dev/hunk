import { describe, expect, test } from "bun:test";
import {
  BUNDLED_SHIKI_THEME_BACKGROUNDS,
  BUNDLED_SHIKI_THEME_DIFF_COLORS,
  BUNDLED_SHIKI_THEME_IDS,
} from "./catalog";

/**
 * Table-driven checks over the generated diff-color catalog. Deliberately
 * re-derive hue and saturation locally to validate the harvester's math.
 */

/** Hue in degrees and saturation for a 6-digit hex color. */
function hueAndSaturation(hex: string) {
  const red = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const green = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const blue = Number.parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  if (delta === 0) {
    return { hue: 0, saturation: 0 };
  }
  const lightness = (max + min) / 2;
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue: number;
  if (max === red) {
    hue = 60 * (((green - blue) / delta + 6) % 6);
  } else if (max === green) {
    hue = 60 * ((blue - red) / delta + 2);
  } else {
    hue = 60 * ((red - green) / delta + 4);
  }
  return { hue, saturation };
}

const tableEntries = Object.entries(BUNDLED_SHIKI_THEME_DIFF_COLORS);

describe("BUNDLED_SHIKI_THEME_DIFF_COLORS", () => {
  test("only names bundled theme ids and lists them in catalog order", () => {
    const ids = tableEntries.map(([themeId]) => themeId);
    const bundledOrder = BUNDLED_SHIKI_THEME_IDS.filter(
      (themeId) => themeId in BUNDLED_SHIKI_THEME_DIFF_COLORS,
    );
    expect(ids).toEqual(bundledOrder);
  });

  test("stores every accent as a 6-digit lowercase hex palette token", () => {
    for (const [themeId, entry] of tableEntries) {
      for (const [slot, value] of Object.entries(entry)) {
        expect(value, `${themeId} ${slot}`).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  test("keeps every stored accent saturated — no greys, whites, or flattened composites", () => {
    for (const [themeId, entry] of tableEntries) {
      for (const [slot, value] of Object.entries(entry)) {
        const { saturation } = hueAndSaturation(value);
        expect(saturation, `${themeId} ${slot} ${value}`).toBeGreaterThan(0.1);
      }
    }
  });

  test("keeps added accents in the green/teal family", () => {
    for (const [themeId, entry] of tableEntries) {
      if (!entry.added) {
        continue;
      }
      const { hue } = hueAndSaturation(entry.added);
      expect(hue, `${themeId} added ${entry.added}`).toBeGreaterThanOrEqual(50);
      expect(hue, `${themeId} added ${entry.added}`).toBeLessThanOrEqual(200);
    }
  });

  test("keeps removed accents in the red/pink family", () => {
    for (const [themeId, entry] of tableEntries) {
      if (!entry.removed) {
        continue;
      }
      const { hue } = hueAndSaturation(entry.removed);
      expect(
        hue >= 300 || hue <= 30,
        `${themeId} removed ${entry.removed} hue ${hue.toFixed(1)}`,
      ).toBe(true);
    }
  });

  test("never reuses one accent for both added and removed", () => {
    for (const [themeId, entry] of tableEntries) {
      if (entry.added && entry.removed) {
        expect(entry.added, themeId).not.toBe(entry.removed);
      }
    }
  });

  test("covers every bundled theme with a background", () => {
    expect(Object.keys(BUNDLED_SHIKI_THEME_BACKGROUNDS).sort()).toEqual(
      [...BUNDLED_SHIKI_THEME_IDS].sort(),
    );
  });
});
