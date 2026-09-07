import type { AppTheme } from "../themes";
import { blendHex } from "./color";

/** Files-pane rectangle, sharing its inner edge with the pane divider. */
export function filesPaneFrameSides(includeTop: boolean): Array<"top" | "left" | "bottom"> {
  return includeTop ? ["top", "left", "bottom"] : ["left", "bottom"];
}

/** Review-pane rectangle, sharing its inner edge with the pane divider. */
export function reviewPaneFrameSides(includeTop: boolean): Array<"top" | "right" | "bottom"> {
  return includeTop ? ["top", "right", "bottom"] : ["right", "bottom"];
}

/**
 * Border color for a pane frame.
 *
 * When more than one pane is visible, the focused pane and the shared divider
 * use a brighter stroke; the other pane keeps the dim theme border.
 */
export function paneFrameBorderColor(theme: AppTheme, focused: boolean): string {
  if (!focused) {
    return theme.border;
  }

  return blendHex(theme.text, theme.background, theme.appearance === "light" ? 0.42 : 0.5);
}
