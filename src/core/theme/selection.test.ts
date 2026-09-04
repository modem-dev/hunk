import { describe, expect, test } from "bun:test";
import {
  chooseThemeSelectionId,
  isAdaptiveThemeSelection,
  readThemeSelection,
  themeSelectionsEqual,
  themeSelectionNeedsTerminalMode,
} from "./selection";

describe("readThemeSelection", () => {
  test("accepts one theme id and reports nothing for an unset or empty value", () => {
    expect(readThemeSelection("nord")).toEqual({ selection: "nord" });
    expect(readThemeSelection("auto")).toEqual({ selection: "auto" });
    expect(readThemeSelection(undefined)).toBeUndefined();
    expect(readThemeSelection("")).toBeUndefined();
  });

  test("accepts an adaptive pair with and without a fallback", () => {
    expect(readThemeSelection({ dark: "catppuccin-mocha", light: "catppuccin-latte" })).toEqual({
      selection: { dark: "catppuccin-mocha", light: "catppuccin-latte" },
    });
    expect(
      readThemeSelection({ dark: "vitesse-dark", light: "vitesse-light", fallback: "nord" }),
    ).toEqual({ selection: { dark: "vitesse-dark", light: "vitesse-light", fallback: "nord" } });
  });

  test("requires both backgrounds so neither terminal falls back to a Hunk default", () => {
    const read = readThemeSelection({ dark: "nord" });
    expect(read).toEqual({
      issue: "Expected [theme] to set both `dark` and `light` to theme ids.",
    });
  });

  test("rejects unknown keys so a typo surfaces instead of doing nothing", () => {
    const read = readThemeSelection({ dark: "nord", light: "one-light", defualt: "nord" });
    expect(read).toEqual({
      issue: "Expected [theme] to contain only dark, light, fallback. Unexpected: `defualt`.",
    });
  });

  test("rejects non-string ids and values that are neither an id nor a table", () => {
    expect(readThemeSelection({ dark: "nord", light: "one-light", fallback: 7 })).toEqual({
      issue: "Expected theme.fallback to be a theme id.",
    });
    expect(readThemeSelection(["nord"])).toEqual({
      issue: "Expected theme to be a theme id or a table of theme ids.",
    });
  });

  test("names the key path it was given so nested tables explain themselves", () => {
    expect(readThemeSelection({ dark: 1 }, "pager.theme")).toEqual({
      issue: "Expected [pager.theme] to set both `dark` and `light` to theme ids.",
    });
  });
});

describe("chooseThemeSelectionId", () => {
  const adaptive = { dark: "vitesse-dark", light: "vitesse-light" };

  test("passes a plain id through for every background", () => {
    expect(chooseThemeSelectionId("nord", "light")).toBe("nord");
    expect(chooseThemeSelectionId("nord", null)).toBe("nord");
    expect(chooseThemeSelectionId(undefined, "dark")).toBeUndefined();
  });

  test("follows the detected background across an adaptive pair", () => {
    expect(chooseThemeSelectionId(adaptive, "light")).toBe("vitesse-light");
    expect(chooseThemeSelectionId(adaptive, "dark")).toBe("vitesse-dark");
  });

  test("takes fallback when the terminal never answered, and dark when none is set", () => {
    expect(chooseThemeSelectionId({ ...adaptive, fallback: "nord" }, null)).toBe("nord");
    expect(chooseThemeSelectionId(adaptive, null)).toBe("vitesse-dark");
    expect(chooseThemeSelectionId(adaptive, undefined)).toBe("vitesse-dark");
  });
});

describe("selection predicates", () => {
  test("probes the terminal only when the answer can change the theme", () => {
    expect(themeSelectionNeedsTerminalMode("auto")).toBe(true);
    expect(themeSelectionNeedsTerminalMode({ dark: "nord", light: "one-light" })).toBe(true);
    expect(themeSelectionNeedsTerminalMode("nord")).toBe(false);
    expect(themeSelectionNeedsTerminalMode(undefined)).toBe(false);
  });

  test("narrows adaptive pairs away from ids", () => {
    expect(isAdaptiveThemeSelection({ dark: "nord", light: "one-light" })).toBe(true);
    expect(isAdaptiveThemeSelection("nord")).toBe(false);
    expect(isAdaptiveThemeSelection(undefined)).toBe(false);
  });

  test("compares pairs by value so an untouched preference never looks dirty", () => {
    expect(
      themeSelectionsEqual(
        { dark: "nord", light: "one-light" },
        { dark: "nord", light: "one-light" },
      ),
    ).toBe(true);
    expect(
      themeSelectionsEqual(
        { dark: "nord", light: "one-light" },
        { dark: "nord", light: "one-light", fallback: "nord" },
      ),
    ).toBe(false);
    expect(themeSelectionsEqual("nord", { dark: "nord", light: "one-light" })).toBe(false);
    expect(themeSelectionsEqual("nord", "nord")).toBe(true);
  });
});
