/**
 * The side panel's per-browser state: open or closed, width, and the chosen tab.
 *
 * Presentation only, like the view preferences (`../view/viewPreferences.ts`): it never reaches
 * the session. Stored in `localStorage` with every access guarded, so blocked storage costs
 * only the memory of the choice. Without a stored choice the panel stays closed at every width:
 * the summary strip above the review says what the Overview would, and the panel opens when
 * the reader asks for it.
 */

/** The tools the panel hosts, by tab id. */
export type SidePanelTab = "overview" | "notes";

export const SIDE_PANEL_TABS: readonly SidePanelTab[] = ["overview", "notes"];

export interface SidePanelPreferences {
  /** Undefined means the reader never chose, which is closed. */
  open: boolean | undefined;
  width: number;
  /** Undefined until the reader picks a tab; the page then opens on the tab that fits. */
  tab: SidePanelTab | undefined;
}

export const SIDE_PANEL_MIN_WIDTH = 260;
export const SIDE_PANEL_MAX_WIDTH = 640;
export const SIDE_PANEL_DEFAULT_WIDTH = 340;

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
      : undefined,
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

/** Whether the panel is open: the stored choice, or closed when there is none. */
export function resolveSidePanelOpen(preferences: SidePanelPreferences) {
  return preferences.open ?? false;
}

/**
 * The tab the panel shows: the reader's choice, else Notes when the review has notes to read,
 * else Overview.
 */
export function resolveSidePanelTab(
  preferences: SidePanelPreferences,
  hasNotes: boolean,
): SidePanelTab {
  return preferences.tab ?? (hasNotes ? "notes" : "overview");
}
