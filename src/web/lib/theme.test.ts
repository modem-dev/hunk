import { describe, expect, test } from "bun:test";
import { HUNK_WEB_THEMES, hunkThemeCssVariables } from "./theme";

describe("Hunk web themes", () => {
  test("maps light and dark palettes consistently across Diffs, Trees, and chrome", () => {
    expect(HUNK_WEB_THEMES.dark.diffs).toBe("pierre-dark");
    expect(HUNK_WEB_THEMES.light.diffs).toBe("pierre-light");
    expect(HUNK_WEB_THEMES.dark.colors.background).not.toBe(
      HUNK_WEB_THEMES.light.colors.background,
    );
    expect(hunkThemeCssVariables(HUNK_WEB_THEMES.light)).toMatchObject({
      colorScheme: "light",
      "--hunk-bg": HUNK_WEB_THEMES.light.colors.background,
      "--hunk-panel": HUNK_WEB_THEMES.light.colors["sideBar.background"],
    });
  });
});
