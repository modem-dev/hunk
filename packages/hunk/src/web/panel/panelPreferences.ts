/**
 * The side panel's per-browser state: open or closed, width, and the chosen tab.
 *
 * Presentation only, like the view preferences (`../view/viewPreferences.ts`): it never reaches
 * the session. Stored in `localStorage` with every access guarded, so blocked storage costs
 * only the memory of the choice. Without a stored choice the panel opens on wide viewports and
 * stays hidden on narrow ones, where the stream needs the room.
 */

/** The tools the panel hosts, by tab id. */
export type SidePanelTab = "overview";

export const SIDE_PANEL_TABS: readonly SidePanelTab[] = ["overview"];

export interface SidePanelPreferences {
  /** Undefined means "decide from the viewport". */
  open: boolean | undefined;
  width: number;
  tab: SidePanelTab;
}

export const SIDE_PANEL_MIN_WIDTH = 260;
export const SIDE_PANEL_MAX_WIDTH = 640;
export const SIDE_PANEL_DEFAULT_WIDTH = 340;

/**
 * Below this viewport width the panel starts hidden: beside a 300 px files sidebar, a 340 px
 * panel leaves the stream about 760 px at this width, about what a unified diff with notes
 * needs; a common 1280 px laptop window keeps the stream's room.
 */
export const SIDE_PANEL_MIN_VIEWPORT = 1400;

const STORAGE_KEY = "hunk.review.panel";

/** Keep a dragged panel width inside its bounds. */
export function clampSidePanelWidth(width: number) {
  return Math.round(Math.min(SIDE_PANEL_MAX_WIDTH, Math.max(SIDE_PANEL_MIN_WIDTH, width)));
}

/** Read the stored panel state, ignoring anything malformed. */
export function readSidePanelPreferences(): SidePanelPreferences {
  let stored: Partial<Record<keyof SidePanelPreferences, unknown>> = {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as unknown;
    if (parsed && typeof parsed === "object") stored = parsed as typeof stored;
  } catch {
    // Unreadable storage is the same as none.
  }
  return {
    open: typeof stored.open === "boolean" ? stored.open : undefined,
    width:
      typeof stored.width === "number"
        ? clampSidePanelWidth(stored.width)
        : SIDE_PANEL_DEFAULT_WIDTH,
    tab: SIDE_PANEL_TABS.includes(stored.tab as SidePanelTab)
      ? (stored.tab as SidePanelTab)
      : "overview",
  };
}

/** Store the panel state; skipped silently when storage is blocked. */
export function storeSidePanelPreferences(preferences: SidePanelPreferences) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Losing the preference is the whole cost.
  }
}

/** Whether the panel is open: the stored choice, or the viewport's default. */
export function resolveSidePanelOpen(preferences: SidePanelPreferences, viewportWidth: number) {
  return preferences.open ?? viewportWidth >= SIDE_PANEL_MIN_VIEWPORT;
}
