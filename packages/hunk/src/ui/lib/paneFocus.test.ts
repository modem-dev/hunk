import { describe, expect, test } from "bun:test";
import { resolveTheme } from "../themes";
import { filesPaneFrameSides, paneFrameBorderColor, reviewPaneFrameSides } from "./paneFocus";

describe("pane frame sides", () => {
  test("omits the top edge when the menu bar is hidden", () => {
    expect(filesPaneFrameSides(true)).toEqual(["top", "left", "bottom"]);
    expect(filesPaneFrameSides(false)).toEqual(["left", "bottom"]);
    expect(reviewPaneFrameSides(true)).toEqual(["top", "right", "bottom"]);
    expect(reviewPaneFrameSides(false)).toEqual(["right", "bottom"]);
  });
});

describe("paneFrameBorderColor", () => {
  test("keeps the dim theme border on an unfocused pane", () => {
    const theme = resolveTheme("github-dark-default", null);

    expect(paneFrameBorderColor(theme, false)).toBe(theme.border);
  });

  test("uses a brighter stroke than the dim border on the focused pane", () => {
    const dark = resolveTheme("github-dark-default", null);
    const light = resolveTheme("github-light-default", null);

    expect(paneFrameBorderColor(dark, true)).not.toBe(dark.border);
    expect(paneFrameBorderColor(light, true)).not.toBe(light.border);
    expect(paneFrameBorderColor(dark, true)).not.toBe(dark.text);
  });
});
