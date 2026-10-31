import type {
  ExtensionPane,
  ExtensionPaneComponent,
  ExtensionPanePlacement,
  ExtensionPaneProps,
  ExtensionPaneSize,
  ExtensionSidebarComponent,
  ExtensionSidebarViewProps,
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

/**
 * Mount a deprecated sidebar component through the pane contract.
 *
 * The legacy props declare a mutable `files` array, so each render receives a
 * shallow copy of the frozen host list; the file views themselves stay frozen.
 * Pane-only fields (`review`, `reviewGeneration`, `placement`, `height`, and
 * `currentLine`) are deliberately not forwarded.
 */
export function adaptLegacySidebarComponent(
  component: ExtensionSidebarComponent,
): ExtensionPaneComponent {
  return (props: ExtensionPaneProps) => {
    const legacyProps: ExtensionSidebarViewProps = {
      files: [...props.files],
      selectedFileId: props.selectedFileId,
      selectedHunkIndex: props.selectedHunkIndex,
      width: props.width,
      theme: props.theme,
      keybindings: props.keybindings,
      actions: props.actions,
    };

    return component(legacyProps);
  };
}
