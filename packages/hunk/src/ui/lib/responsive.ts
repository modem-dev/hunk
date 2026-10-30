import { DEFAULT_AUTO_SPLIT_MIN_WIDTH, type LayoutMode } from "../../core/run/commandInputs";

export type ResponsiveViewport = "full" | "medium" | "tight";

const SIDEBAR_VIEWPORT_MIN_WIDTH = 160;
const FULL_VIEWPORT_MIN_WIDTH = 220;

/** Bucket terminal widths independently of the space remaining for diffs. */
export function resolveResponsiveViewport(viewportWidth: number): ResponsiveViewport {
  if (viewportWidth >= FULL_VIEWPORT_MIN_WIDTH) {
    return "full";
  }

  if (viewportWidth >= SIDEBAR_VIEWPORT_MIN_WIDTH) {
    return "medium";
  }

  return "tight";
}

/** Choose auto layout from available diff columns after side panes and outer padding. */
export function resolveResponsiveLayout(
  requestedLayout: LayoutMode,
  diffContentWidth: number,
  autoSplitMinWidth = DEFAULT_AUTO_SPLIT_MIN_WIDTH,
): Exclude<LayoutMode, "auto"> {
  if (requestedLayout !== "auto") {
    return requestedLayout;
  }

  return diffContentWidth >= autoSplitMinWidth ? "split" : "unified";
}
