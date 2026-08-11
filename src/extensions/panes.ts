import type { ExtensionPanePlacement, ExtensionPaneThickness } from "../extension-api/types";

const DEFAULT_SIDE_PANE_THICKNESS = Object.freeze({ preferred: 34, min: 22 });
const DEFAULT_VERTICAL_PANE_THICKNESS = Object.freeze({ preferred: 8, min: 3 });

/** Resolve the host default on the axis implied by a pane's placement. */
export function defaultExtensionPaneThickness(
  placement: ExtensionPanePlacement,
): ExtensionPaneThickness {
  return placement === "left" || placement === "right"
    ? DEFAULT_SIDE_PANE_THICKNESS
    : DEFAULT_VERTICAL_PANE_THICKNESS;
}
