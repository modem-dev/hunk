import type { LayoutMode } from "../../core/types";

export type ResponsiveViewport = "full" | "medium" | "tight";

export interface ResponsiveLayout {
  viewport: ResponsiveViewport;
  layout: Exclude<LayoutMode, "auto">;
  showFilesPane: boolean;
}

export function resolveResponsiveViewport(
  availableWidth: number,
  filesPaneMinWidth: number,
  diffPaneMinWidth: number,
  dividerWidth: number,
): ResponsiveViewport {
  const fullWidthMin = filesPaneMinWidth + dividerWidth + diffPaneMinWidth;

  if (availableWidth >= fullWidthMin) {
    return "full";
  }

  if (availableWidth >= diffPaneMinWidth) {
    return "medium";
  }

  return "tight";
}

export function resolveResponsiveLayout(
  requestedLayout: LayoutMode,
  centerWidth: number,
  filesPaneMinWidth: number,
  diffPaneMinWidth: number,
  dividerWidth: number,
): ResponsiveLayout {
  const viewport = resolveResponsiveViewport(centerWidth, filesPaneMinWidth, diffPaneMinWidth, dividerWidth);

  if (requestedLayout === "stack") {
    return {
      viewport,
      layout: "stack",
      showFilesPane: false,
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
