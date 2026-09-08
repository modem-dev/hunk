import { HUNK_VENDOR_EXTENSION_ID } from "../../../extensionIds";
import type { ExtensionFactory } from "../../../types";
import { FlexFileSidebar } from "./FileSidebars";

/**
 * Hunk's file-navigation sidebar ships as a bundled extension.
 *
 * The component consumes the public pane props for files, selection, theme,
 * and navigation while host-owned rendering helpers provide the responsive
 * terminal presentation. This keeps the extension contract honest without
 * duplicating review semantics inside the bundled surface.
 */

/**
 * The bundled sidebar registers under Hunk's vendor id, not under `sidebar`.
 *
 * View keys are `<extensionId>:<viewId>`, and extension ids are file stems a
 * user picks, so `sidebar.ts` on disk would otherwise mint `sidebar:files` and
 * collide with this view. `hunk` is reserved at load, so this key cannot be
 * taken.
 */
export const BUNDLED_SIDEBAR_EXTENSION_ID = HUNK_VENDOR_EXTENSION_ID;
export const BUNDLED_SIDEBAR_VIEW_ID = "files";

export { FlatFileSidebar, FlexFileSidebar, TreeFileSidebar } from "./FileSidebars";

/** Register the responsive built-in file navigation pane. */
const registerBundledSidebar: ExtensionFactory = (hunk) => {
  hunk.registerPane({
    id: BUNDLED_SIDEBAR_VIEW_ID,
    title: "Files",
    placement: "left",
    width: { preferred: 34, min: 22, max: 56, fraction: 0.16 },
    defaultOpen: true,
    component: FlexFileSidebar,
  });
};

export default registerBundledSidebar;
