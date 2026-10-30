import { describe, expect, test } from "bun:test";
import { DEFAULT_DARK_THEME_ID, resolveTheme } from "../../themes";
import { resolveStmlColor } from "./colors";

const theme = resolveTheme(DEFAULT_DARK_THEME_ID, null);

describe("resolveStmlColor", () => {
  test("maps semantic tokens and aliases through the active theme", () => {
    expect(resolveStmlColor("accent", theme)).toBe(theme.accent);
    expect(resolveStmlColor("info", theme)).toBe(theme.accentMuted);
    expect(resolveStmlColor("success", theme)).toBe(theme.addedSignColor);
    expect(resolveStmlColor("danger", theme)).toBe(theme.removedSignColor);
    expect(resolveStmlColor("error", theme)).toBe(theme.removedSignColor);
    expect(resolveStmlColor("warning", theme)).toBe(theme.fileModified);
    expect(resolveStmlColor("muted", theme)).toBe(theme.muted);
    expect(resolveStmlColor("subtle", theme)).toBe(theme.panelAlt);
    expect(resolveStmlColor("heading", theme)).toBe(theme.text);
    expect(resolveStmlColor("text", theme)).toBe(theme.text);
    expect(resolveStmlColor("panel", theme)).toBe(theme.panel);
    expect(resolveStmlColor("bg", theme)).toBe(theme.panel);
    expect(resolveStmlColor("note-border", theme)).toBe(theme.noteBorder);
    expect(resolveStmlColor("badge-text", theme)).toBe(theme.background);
  });

  test("accepts explicit and named colors and rejects unknown values", () => {
    expect(resolveStmlColor(" #Aa11CC ", theme)).toBe("#aa11cc");
    expect(resolveStmlColor("red", theme)).toBe("#e05252");
    expect(resolveStmlColor("unknown", theme)).toBeNull();
    expect(resolveStmlColor("__proto__", theme)).toBeNull();
    expect(resolveStmlColor("constructor", theme)).toBeNull();
    expect(resolveStmlColor(undefined, theme)).toBeNull();
  });
});
