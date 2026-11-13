/**
 * Whether this browser shows the minimap, as the reader last chose with
 * `hunk.web.toggleMinimap`. On by default; storage is guarded, so a blocked store only loses
 * the choice.
 */

const STORAGE_KEY = "hunk.review.minimap";

/** Read the stored choice; on unless this browser turned it off. */
export function readMinimapEnabled() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

/** Store the choice. */
export function storeMinimapEnabled(enabled: boolean) {
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    // Losing the preference is the whole cost.
  }
}
