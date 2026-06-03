import { describe, expect, test } from "bun:test";
import { blendHex, hexColorDistance } from "./lib/color";
import { CATPPUCCIN_PALETTES, resolveTheme } from "./themes";

describe("themes", () => {
  test("resolves all Catppuccin flavors by theme id", () => {
    const latte = resolveTheme("catppuccin-latte", null);
    const frappe = resolveTheme("catppuccin-frappe", null);
    const macchiato = resolveTheme("catppuccin-macchiato", null);
    const mocha = resolveTheme("catppuccin-mocha", null);

    expect(latte.id).toBe("catppuccin-latte");
    expect(latte.label).toBe("Catppuccin Latte");
    expect(latte.appearance).toBe("light");
    expect(frappe.id).toBe("catppuccin-frappe");
    expect(frappe.label).toBe("Catppuccin Frappé");
    expect(frappe.appearance).toBe("dark");
    expect(macchiato.id).toBe("catppuccin-macchiato");
    expect(macchiato.label).toBe("Catppuccin Macchiato");
    expect(macchiato.appearance).toBe("dark");
    expect(mocha.id).toBe("catppuccin-mocha");
    expect(mocha.label).toBe("Catppuccin Mocha");
    expect(mocha.appearance).toBe("dark");
  });

  test("keeps official Catppuccin sentinel colors in source", () => {
    expect(CATPPUCCIN_PALETTES.latte.base).toBe("#eff1f5");
    expect(CATPPUCCIN_PALETTES.latte.mauve).toBe("#8839ef");
    expect(CATPPUCCIN_PALETTES.latte.green).toBe("#40a02b");
    expect(CATPPUCCIN_PALETTES.latte.red).toBe("#d20f39");
    expect(CATPPUCCIN_PALETTES.frappe.base).toBe("#303446");
    expect(CATPPUCCIN_PALETTES.frappe.mauve).toBe("#ca9ee6");
    expect(CATPPUCCIN_PALETTES.frappe.green).toBe("#a6d189");
    expect(CATPPUCCIN_PALETTES.frappe.red).toBe("#e78284");
    expect(CATPPUCCIN_PALETTES.macchiato.base).toBe("#24273a");
    expect(CATPPUCCIN_PALETTES.macchiato.mauve).toBe("#c6a0f6");
    expect(CATPPUCCIN_PALETTES.macchiato.green).toBe("#a6da95");
    expect(CATPPUCCIN_PALETTES.macchiato.red).toBe("#ed8796");
    expect(CATPPUCCIN_PALETTES.mocha.base).toBe("#1e1e2e");
    expect(CATPPUCCIN_PALETTES.mocha.mauve).toBe("#cba6f7");
    expect(CATPPUCCIN_PALETTES.mocha.green).toBe("#a6e3a1");
    expect(CATPPUCCIN_PALETTES.mocha.red).toBe("#f38ba8");
  });

  test("derives Catppuccin diff backgrounds from official semantic tokens", () => {
    const latte = resolveTheme("catppuccin-latte", null);
    const mocha = resolveTheme("catppuccin-mocha", null);

    expect(latte.addedBg).toBe(blendHex(CATPPUCCIN_PALETTES.latte.green, latte.contextBg, 0.15));
    expect(latte.removedBg).toBe(blendHex(CATPPUCCIN_PALETTES.latte.red, latte.contextBg, 0.15));
    expect(latte.addedContentBg).toBe(
      blendHex(CATPPUCCIN_PALETTES.latte.green, latte.contextBg, 0.25),
    );
    expect(latte.removedContentBg).toBe(
      blendHex(CATPPUCCIN_PALETTES.latte.red, latte.contextBg, 0.25),
    );
    expect(mocha.addedBg).toBe(blendHex(CATPPUCCIN_PALETTES.mocha.green, mocha.contextBg, 0.15));
    expect(mocha.removedBg).toBe(blendHex(CATPPUCCIN_PALETTES.mocha.red, mocha.contextBg, 0.15));
    expect(mocha.addedContentBg).toBe(
      blendHex(CATPPUCCIN_PALETTES.mocha.green, mocha.contextBg, 0.25),
    );
    expect(mocha.removedContentBg).toBe(
      blendHex(CATPPUCCIN_PALETTES.mocha.red, mocha.contextBg, 0.25),
    );
  });

  test("keeps Catppuccin add and remove rows semantically distinct", () => {
    for (const theme of [
      resolveTheme("catppuccin-latte", null),
      resolveTheme("catppuccin-frappe", null),
      resolveTheme("catppuccin-macchiato", null),
      resolveTheme("catppuccin-mocha", null),
    ]) {
      expect(theme.addedBg).not.toBe(theme.removedBg);
      expect(hexColorDistance(theme.addedBg, theme.contextBg)).toBeGreaterThan(0);
      expect(hexColorDistance(theme.removedBg, theme.contextBg)).toBeGreaterThan(0);
      expect(hexColorDistance(theme.addedContentBg, theme.contextBg)).toBeGreaterThan(
        hexColorDistance(theme.addedBg, theme.contextBg),
      );
      expect(hexColorDistance(theme.removedContentBg, theme.contextBg)).toBeGreaterThan(
        hexColorDistance(theme.removedBg, theme.contextBg),
      );
    }
  });

  test("maps Catppuccin syntax roles to documented editor tokens", () => {
    const latte = resolveTheme("catppuccin-latte", null);
    const mocha = resolveTheme("catppuccin-mocha", null);

    expect(latte.syntaxColors).toMatchObject({
      keyword: CATPPUCCIN_PALETTES.latte.mauve,
      string: CATPPUCCIN_PALETTES.latte.green,
      comment: CATPPUCCIN_PALETTES.latte.overlay2,
      number: CATPPUCCIN_PALETTES.latte.peach,
      function: CATPPUCCIN_PALETTES.latte.blue,
      property: CATPPUCCIN_PALETTES.latte.blue,
      type: CATPPUCCIN_PALETTES.latte.yellow,
      punctuation: CATPPUCCIN_PALETTES.latte.overlay2,
    });
    expect(mocha.syntaxColors).toMatchObject({
      keyword: CATPPUCCIN_PALETTES.mocha.mauve,
      string: CATPPUCCIN_PALETTES.mocha.green,
      comment: CATPPUCCIN_PALETTES.mocha.overlay2,
      number: CATPPUCCIN_PALETTES.mocha.peach,
      function: CATPPUCCIN_PALETTES.mocha.blue,
      property: CATPPUCCIN_PALETTES.mocha.blue,
      type: CATPPUCCIN_PALETTES.mocha.yellow,
      punctuation: CATPPUCCIN_PALETTES.mocha.overlay2,
    });
  });

  test("resolves Zenburn by theme id with its tuned dark palette", () => {
    const zenburn = resolveTheme("zenburn", null);

    expect(zenburn.id).toBe("zenburn");
    expect(zenburn.label).toBe("Zenburn");
    expect(zenburn.appearance).toBe("dark");
    expect(zenburn.background).toBe("#3f3f3f");
    expect(zenburn.text).toBe("#dcdccc");
    expect(zenburn.syntaxColors).toMatchObject({
      keyword: "#f0dfaf",
      string: "#dca3a3",
      comment: "#60b48a",
      function: "#94bff3",
      type: "#94bff3",
    });
  });
});
