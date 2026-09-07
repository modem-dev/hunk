import { describe, expect, test } from "bun:test";
import { resolveTheme } from "../themes";
import {
  interactiveLogUsesColor,
  monochromeLogTheme,
  resolveInteractiveLogPalette,
} from "./colorPolicy";

describe("interactive log color policy", () => {
  test("honors explicit color precedence and terminal conventions", () => {
    expect(interactiveLogUsesColor("always", { NO_COLOR: "", TERM: "dumb" })).toBe(true);
    expect(interactiveLogUsesColor("never", {})).toBe(false);
    expect(interactiveLogUsesColor("auto", { NO_COLOR: "" })).toBe(false);
    expect(interactiveLogUsesColor("auto", { TERM: "dumb" })).toBe(false);
    expect(interactiveLogUsesColor("auto", { TERM: "xterm-256color" })).toBe(true);
  });

  test("maps history roles onto the active semantic theme", () => {
    const selected = resolveTheme("github-dark-default", null);
    const palette = resolveInteractiveLogPalette(selected);
    expect(palette).toEqual({
      timeline: selected.noteBorder,
      dayHeading: selected.fileRenamed,
      author: selected.addedSignColor,
      separator: selected.lineNumberFg,
      relativeTime: selected.muted,
      decoration: selected.addedSignColor,
      commitId: selected.accent,
      copyAction: selected.lineNumberFg,
      graphLanes: [
        selected.accent,
        selected.addedSignColor,
        selected.removedSignColor,
        selected.fileRenamed,
        selected.noteBorder,
      ],
    });
    expect(palette.decoration).not.toBe(palette.commitId);
    expect(new Set(Object.values(palette).flat()).size).toBeGreaterThanOrEqual(5);
  });

  test("does not expose selected theme colors when color is disabled", () => {
    const selected = resolveTheme("github-dark-default", null);
    const neutral = monochromeLogTheme(selected, "dark");
    const palette = resolveInteractiveLogPalette(neutral);
    expect(neutral.id).toBe("terminal-monochrome");
    expect(neutral.background).toBe("#000000");
    expect(neutral.selectedHunk).toBe("#404040");
    expect(new Set(Object.values(palette).flat())).toEqual(new Set(["#ffffff"]));
    expect(new Set(Object.values(neutral.syntaxColors))).toEqual(new Set(["#ffffff"]));
    expect(neutral.syntaxScopeOverrides).toBeUndefined();
  });
});
