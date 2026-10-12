import { DEFAULT_AUTO_WIDTH_THRESHOLD, type LayoutMode } from "../../core/run/commandInputs";

export type ResponsiveViewport = "full" | "medium" | "tight";

const SIDEBAR_VIEWPORT_MIN_WIDTH = 160;
const FULL_VIEWPORT_MIN_WIDTH = 220;

export interface ResponsiveLayout {
  viewport: ResponsiveViewport;
  layout: Exclude<LayoutMode, "auto">;
  showSidebar: boolean;
}

/** Bucket terminal widths into the viewport classes the app layout cares about. */
function resolveResponsiveViewport(viewportWidth: number): ResponsiveViewport {
  if (viewportWidth >= FULL_VIEWPORT_MIN_WIDTH) {
    return "full";
  }

  if (viewportWidth >= SIDEBAR_VIEWPORT_MIN_WIDTH) {
    return "medium";
  }

  return "tight";
}

/** Resolve the effective layout after combining the explicit mode with viewport size. */
export function resolveResponsiveLayout(
  requestedLayout: LayoutMode,
  viewportWidth: number,
  autoWidthThreshold = DEFAULT_AUTO_WIDTH_THRESHOLD,
): ResponsiveLayout {
  const viewport = resolveResponsiveViewport(viewportWidth);

  if (requestedLayout === "split") {
    return {
      viewport,
      layout: "split",
      showSidebar: viewport !== "tight",
    };
  }

  if (requestedLayout === "unified") {
    return {
      viewport,
      layout: "unified",
      showSidebar: viewport !== "tight",
    };
  }

  return {
    viewport,
    layout: viewportWidth >= autoWidthThreshold ? "split" : "unified",
    showSidebar: viewport !== "tight",
  };
}
