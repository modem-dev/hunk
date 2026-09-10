import type {
  ExtensionPane,
  ExtensionPanePlacement,
  ExtensionPaneSize,
} from "../extension-api/types";

const DEFAULT_VERTICAL_PANE_WIDTH = Object.freeze({ preferred: 34, min: 22 });
const DEFAULT_HORIZONTAL_PANE_HEIGHT = Object.freeze({ preferred: 8, min: 3 });

/** Report whether a pane occupies a vertical edge and is therefore width-sized. */
export function isVerticalPanePlacement(placement: ExtensionPanePlacement) {
  return placement === "left" || placement === "right";
}

/** Resolve the host default for the explicit dimension implied by placement. */
export function defaultExtensionPaneSize(placement: ExtensionPanePlacement): ExtensionPaneSize {
  return isVerticalPanePlacement(placement)
    ? DEFAULT_VERTICAL_PANE_WIDTH
    : DEFAULT_HORIZONTAL_PANE_HEIGHT;
}

/** Read the width or height request matching one pane's accepted placement. */
export function extensionPaneSize(
  pane: ExtensionPane,
  placement: ExtensionPanePlacement = pane.placement ?? "left",
): ExtensionPaneSize {
  return (
    (isVerticalPanePlacement(placement) ? pane.width : pane.height) ??
    defaultExtensionPaneSize(placement)
  );
}

/** Resolve one pane's absolute and proportional maximum against the host body axis. */
export function extensionPaneMaximumSize(size: ExtensionPaneSize, axisSize: number): number {
  const absolute = size.max ?? Number.MAX_SAFE_INTEGER;
  const proportional =
    size.maxFraction === undefined
      ? Number.MAX_SAFE_INTEGER
      : Math.floor(Math.max(0, axisSize) * size.maxFraction);
  return Math.min(absolute, proportional);
}
