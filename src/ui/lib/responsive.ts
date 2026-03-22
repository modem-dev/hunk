import type { LayoutMode } from "../../core/types";

export type ResponsiveViewport = "full" | "medium" | "tight";

const SPLIT_VIEWPORT_MIN_WIDTH = 160;
const FULL_VIEWPORT_MIN_WIDTH = 220;

export interface ResponsiveLayout {
  viewport: ResponsiveViewport;
  layout: Exclude<LayoutMode, "auto">;
  showFilesPane: boolean;
}

/** Bucket terminal widths into the viewport classes the shell layout cares about. */
function resolveResponsiveViewport(viewportWidth: number): ResponsiveViewport {
  if (viewportWidth >= FULL_VIEWPORT_MIN_WIDTH) {
    return "full";
  }

  if (viewportWidth >= SPLIT_VIEWPORT_MIN_WIDTH) {
    return "medium";
  }

  return "tight";
}

/** Resolve the effective layout after combining the explicit mode with viewport size. */
export function resolveResponsiveLayout(requestedLayout: LayoutMode, viewportWidth: number): ResponsiveLayout {
  const viewport = resolveResponsiveViewport(viewportWidth);

  if (requestedLayout === "split") {
    return {
      viewport,
      layout: "split",
      showFilesPane: viewport === "full",
    };
  }

  if (requestedLayout === "stack") {
    return {
      viewport,
      layout: "stack",
      showFilesPane: viewport === "full",
    };
  }

  if (viewport === "tight") {
    return {
      viewport,
      layout: "stack",
      showFilesPane: false,
    };
  }

  return {
    viewport,
    layout: "split",
    showFilesPane: viewport === "full",
  };
}
