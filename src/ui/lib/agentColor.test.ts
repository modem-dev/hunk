import { describe, expect, test } from "bun:test";
import {
  deriveAuthorBackground,
  deriveAuthorTitleBackground,
  resolveAuthorAccent,
} from "./agentColor";

describe("agentColor helpers", () => {
  test("resolveAuthorAccent returns null for undefined author", () => {
    const palette = ["#c6a0ff", "#7fd1ff", "#88d39b"];
    const result = resolveAuthorAccent(undefined, palette);
    expect(result).toBe(null);
  });

  test("resolveAuthorAccent returns null for empty string author", () => {
    const palette = ["#c6a0ff", "#7fd1ff", "#88d39b"];
    const result = resolveAuthorAccent("", palette);
    expect(result).toBe(null);
  });

  test("resolveAuthorAccent returns null for whitespace-only author", () => {
    const palette = ["#c6a0ff", "#7fd1ff", "#88d39b"];
    const result = resolveAuthorAccent("   ", palette);
    expect(result).toBe(null);
  });

  test("resolveAuthorAccent returns null for empty palette", () => {
    const result = resolveAuthorAccent("sonnet", []);
    expect(result).toBe(null);
  });

  test("same author and palette yield same color when called twice", () => {
    const palette = ["#c6a0ff", "#7fd1ff", "#88d39b", "#e6cf98", "#f0a0a0"];
    const author = "sonnet";
    const color1 = resolveAuthorAccent(author, palette);
    const color2 = resolveAuthorAccent(author, palette);
    expect(color1).toBe(color2);
  });

  test("different authors yield different colors with 5-color palette", () => {
    const palette = ["#c6a0ff", "#7fd1ff", "#88d39b", "#e6cf98", "#f0a0a0"];
    const color1 = resolveAuthorAccent("sonnet", palette);
    const color2 = resolveAuthorAccent("prism", palette);
    expect(color1).not.toBe(color2);
  });

  test("returned color is always a member of the supplied palette", () => {
    const palette = ["#c6a0ff", "#7fd1ff", "#88d39b", "#e6cf98", "#f0a0a0"];
    const authors = ["alice", "bob", "charlie", "david", "eve"];
    for (const author of authors) {
      const color = resolveAuthorAccent(author, palette);
      expect(color).not.toBe(null);
      if (color !== null) {
        expect(palette).toContain(color);
      }
    }
  });

  test("whitespace is trimmed from author before hashing", () => {
    const palette = ["#c6a0ff", "#7fd1ff", "#88d39b"];
    const color1 = resolveAuthorAccent("sonnet", palette);
    const color2 = resolveAuthorAccent("  sonnet  ", palette);
    expect(color1).toBe(color2);
  });

  test("deriveAuthorBackground returns null for unparseable hex", () => {
    expect(deriveAuthorBackground("not-a-color", "dark")).toBe(null);
    expect(deriveAuthorBackground("#abc", "dark")).toBe(null);
    expect(deriveAuthorBackground("#zzzzzz", "dark")).toBe(null);
  });

  test("deriveAuthorBackground is deterministic for same input", () => {
    const a = deriveAuthorBackground("#c6a0ff", "dark");
    const b = deriveAuthorBackground("#c6a0ff", "dark");
    expect(a).toBe(b);
  });

  test("deriveAuthorBackground produces dark output for dark appearance", () => {
    const result = deriveAuthorBackground("#c6a0ff", "dark");
    expect(result).not.toBe(null);
    if (result === null) return;
    const value = Number.parseInt(result.slice(1), 16);
    const r = (value >> 16) & 0xff;
    const g = (value >> 8) & 0xff;
    const b = value & 0xff;
    const lightness = (Math.max(r, g, b) + Math.min(r, g, b)) / 2 / 255;
    expect(lightness).toBeLessThan(0.25);
  });

  test("deriveAuthorBackground produces light output for light appearance", () => {
    const result = deriveAuthorBackground("#7d5bc4", "light");
    expect(result).not.toBe(null);
    if (result === null) return;
    const value = Number.parseInt(result.slice(1), 16);
    const r = (value >> 16) & 0xff;
    const g = (value >> 8) & 0xff;
    const b = value & 0xff;
    const lightness = (Math.max(r, g, b) + Math.min(r, g, b)) / 2 / 255;
    expect(lightness).toBeGreaterThan(0.85);
  });

  test("deriveAuthorBackground differs across hues", () => {
    const purple = deriveAuthorBackground("#c6a0ff", "dark");
    const blue = deriveAuthorBackground("#7fd1ff", "dark");
    const green = deriveAuthorBackground("#88d39b", "dark");
    expect(purple).not.toBe(blue);
    expect(blue).not.toBe(green);
    expect(purple).not.toBe(green);
  });

  test("deriveAuthorTitleBackground is lighter than body for dark appearance", () => {
    const body = deriveAuthorBackground("#c6a0ff", "dark");
    const title = deriveAuthorTitleBackground("#c6a0ff", "dark");
    expect(body).not.toBe(null);
    expect(title).not.toBe(null);
    if (body === null || title === null) return;
    const lightnessOf = (hex: string) => {
      const v = Number.parseInt(hex.slice(1), 16);
      const r = (v >> 16) & 0xff;
      const g = (v >> 8) & 0xff;
      const b = v & 0xff;
      return (Math.max(r, g, b) + Math.min(r, g, b)) / 2 / 255;
    };
    expect(lightnessOf(title)).toBeGreaterThan(lightnessOf(body));
  });

  test("deriveAuthorTitleBackground is darker than body for light appearance", () => {
    const body = deriveAuthorBackground("#7d5bc4", "light");
    const title = deriveAuthorTitleBackground("#7d5bc4", "light");
    expect(body).not.toBe(null);
    expect(title).not.toBe(null);
    if (body === null || title === null) return;
    const lightnessOf = (hex: string) => {
      const v = Number.parseInt(hex.slice(1), 16);
      const r = (v >> 16) & 0xff;
      const g = (v >> 8) & 0xff;
      const b = v & 0xff;
      return (Math.max(r, g, b) + Math.min(r, g, b)) / 2 / 255;
    };
    expect(lightnessOf(title)).toBeLessThan(lightnessOf(body));
  });

  test("derived background keeps WCAG contrast above 4.5 against light text", () => {
    // Dark theme body text (#f2f4f6, near white) on derived dark bg.
    const palette = ["#c6a0ff", "#7fd1ff", "#88d39b", "#e6cf98", "#f0a0a0"];
    const lightText = "#f2f4f6";
    for (const accent of palette) {
      const bg = deriveAuthorBackground(accent, "dark");
      expect(bg).not.toBe(null);
      if (bg === null) continue;
      expect(contrastRatio(lightText, bg)).toBeGreaterThan(4.5);
    }
  });

  test("derived background keeps WCAG contrast above 4.5 against dark text", () => {
    // Light theme body text (#2f2417, near black) on derived light bg.
    const palette = ["#7d5bc4", "#4a6890", "#3f8d58", "#9f6c1f", "#b4545b"];
    const darkText = "#2f2417";
    for (const accent of palette) {
      const bg = deriveAuthorBackground(accent, "light");
      expect(bg).not.toBe(null);
      if (bg === null) continue;
      expect(contrastRatio(darkText, bg)).toBeGreaterThan(4.5);
    }
  });
});

function relativeLuminance(hex: string): number {
  const v = Number.parseInt(hex.slice(1), 16);
  const r = ((v >> 16) & 0xff) / 255;
  const g = ((v >> 8) & 0xff) / 255;
  const b = (v & 0xff) / 255;
  const channel = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
