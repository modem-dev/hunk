import { describe, expect, test } from "bun:test";
import { resolveTheme, TRANSPARENT_BACKGROUND, withTransparentBackground } from "./themes";

describe("themes", () => {
  test("withTransparentBackground only swaps painted background fields", () => {
    const theme = resolveTheme("graphite", null);
    const transparent = withTransparentBackground(theme);

    expect(transparent).toMatchObject({
      background: TRANSPARENT_BACKGROUND,
      panel: TRANSPARENT_BACKGROUND,
      panelAlt: TRANSPARENT_BACKGROUND,
      addedBg: TRANSPARENT_BACKGROUND,
      removedBg: TRANSPARENT_BACKGROUND,
      contextBg: TRANSPARENT_BACKGROUND,
      addedContentBg: TRANSPARENT_BACKGROUND,
      removedContentBg: TRANSPARENT_BACKGROUND,
      contextContentBg: TRANSPARENT_BACKGROUND,
      lineNumberBg: TRANSPARENT_BACKGROUND,
      selectedHunk: TRANSPARENT_BACKGROUND,
      noteBackground: TRANSPARENT_BACKGROUND,
      noteTitleBackground: TRANSPARENT_BACKGROUND,
    });
    expect(transparent.id).toBe(theme.id);
    expect(transparent.label).toBe(theme.label);
    expect(transparent.text).toBe(theme.text);
    expect(transparent.muted).toBe(theme.muted);
    expect(transparent.addedSignColor).toBe(theme.addedSignColor);
    expect(transparent.removedSignColor).toBe(theme.removedSignColor);
    expect(transparent.syntaxColors).toBe(theme.syntaxColors);
    expect(theme.background).not.toBe(TRANSPARENT_BACKGROUND);
  });
});
