import { useEffect } from "react";
import type { LayoutMode } from "../../core/types";
import { resolveResponsiveLayout } from "../lib/responsive";

interface UseAppLayoutOptions {
  bodyPadding: number;
  diffMinWidth: number;
  filesMinWidth: number;
  forceSidebarOpen: boolean;
  layoutMode: LayoutMode;
  pagerMode: boolean;
  renderer: { intermediateRender: () => void };
  sidebarVisible: boolean;
  terminalHeight: number;
  terminalWidth: number;
  wrapLines: boolean;
}

/** Resolve responsive shell layout and trigger intermediate redraws when it changes. */
export function useAppLayout({
  bodyPadding,
  diffMinWidth,
  filesMinWidth,
  forceSidebarOpen,
  layoutMode,
  pagerMode,
  renderer,
  sidebarVisible,
  terminalHeight,
  terminalWidth,
  wrapLines,
}: UseAppLayoutOptions) {
  const resolvedBodyPadding = pagerMode ? 0 : bodyPadding;
  const bodyWidth = Math.max(0, terminalWidth - resolvedBodyPadding);
  const responsiveLayout = resolveResponsiveLayout(layoutMode, terminalWidth);
  const canForceShowFilesPane = bodyWidth >= filesMinWidth + 1 + diffMinWidth;
  const showFilesPane =
    !pagerMode &&
    sidebarVisible &&
    (responsiveLayout.showFilesPane || (forceSidebarOpen && canForceShowFilesPane));
  const availableCenterWidth = showFilesPane ? Math.max(0, bodyWidth - 1) : bodyWidth;
  const maxFilesPaneWidth = showFilesPane
    ? Math.max(filesMinWidth, availableCenterWidth - diffMinWidth)
    : filesMinWidth;

  useEffect(() => {
    renderer.intermediateRender();
  }, [renderer, responsiveLayout.layout, showFilesPane, terminalHeight, terminalWidth, wrapLines]);

  return {
    availableCenterWidth,
    bodyPadding: resolvedBodyPadding,
    canForceShowFilesPane,
    maxFilesPaneWidth,
    responsiveLayout,
    showFilesPane,
  };
}
