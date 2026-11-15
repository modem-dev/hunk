/**
 * The page's per-browser view preferences: layout, wrapping, line numbers, and the sidebar.
 *
 * These are presentation and stay with this browser, as the plan classifies them (G1): they
 * never reach the session or the terminal. They persist in `localStorage` so a reload keeps
 * them, every access wrapped because storage can be missing or blocked; the page renders the
 * same without it. The host's own defaults replace the built-in ones here once the shared
 * state route carries them.
 */
import { DEFAULT_AUTO_SPLIT_MIN_WIDTH, type LayoutMode } from "../../core/run/commandInputs";

export interface WebViewPreferences {
  layout: LayoutMode;
  wrapLines: boolean;
  showLineNumbers: boolean;
  sidebarOpen: boolean | undefined;
  sidebarWidth: number;
  sidebarMode: "tree" | "flat";
}

export const DEFAULT_WEB_VIEW_PREFERENCES: WebViewPreferences = {
  layout: "auto",
  wrapLines: false,
  showLineNumbers: true,
  // Undefined means "decide from the viewport", as the terminal does when it is tight.
  sidebarOpen: undefined,
  sidebarWidth: 300,
  sidebarMode: "tree",
};

export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 640;

/** Below this many monospace columns the sidebar starts hidden, as the terminal's `tight`. */
export const SIDEBAR_VIEWPORT_MIN_COLUMNS = 160;

const STORAGE_KEY = "hunk.review.view";

/** Read stored preferences over the defaults, ignoring anything malformed. */
export function readWebViewPreferences(): WebViewPreferences {
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<
      Record<keyof WebViewPreferences, unknown>
    >;
    return {
      layout: ["auto", "split", "unified"].includes(stored.layout as string)
        ? (stored.layout as LayoutMode)
        : DEFAULT_WEB_VIEW_PREFERENCES.layout,
      wrapLines:
        typeof stored.wrapLines === "boolean"
          ? stored.wrapLines
          : DEFAULT_WEB_VIEW_PREFERENCES.wrapLines,
      showLineNumbers:
        typeof stored.showLineNumbers === "boolean"
          ? stored.showLineNumbers
          : DEFAULT_WEB_VIEW_PREFERENCES.showLineNumbers,
      sidebarOpen: typeof stored.sidebarOpen === "boolean" ? stored.sidebarOpen : undefined,
      sidebarWidth:
        typeof stored.sidebarWidth === "number"
          ? clampSidebarWidth(stored.sidebarWidth)
          : DEFAULT_WEB_VIEW_PREFERENCES.sidebarWidth,
      sidebarMode: stored.sidebarMode === "flat" ? "flat" : "tree",
    };
  } catch {
    return DEFAULT_WEB_VIEW_PREFERENCES;
  }
}

/** Store preferences for this browser; skipped silently when storage is blocked. */
export function storeWebViewPreferences(preferences: WebViewPreferences) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Losing the preference is the whole cost.
  }
}

/** Keep a dragged sidebar width inside its bounds. */
export function clampSidebarWidth(width: number) {
  return Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width)));
}

/**
 * Resolve `auto` the way the terminal does: split when the diff area has room for
 * `DEFAULT_AUTO_SPLIT_MIN_WIDTH` monospace columns, unified otherwise.
 */
export function resolveWebLayout(
  layout: LayoutMode,
  diffAreaWidthPx: number,
  columnWidthPx: number,
): "split" | "unified" {
  if (layout !== "auto") return layout;
  const columns = columnWidthPx > 0 ? diffAreaWidthPx / columnWidthPx : 0;
  return columns >= DEFAULT_AUTO_SPLIT_MIN_WIDTH ? "split" : "unified";
}

/** Whether the sidebar starts open for a viewport, absent a stored choice. */
export function defaultSidebarOpen(viewportWidthPx: number, columnWidthPx: number) {
  return viewportWidthPx / Math.max(1, columnWidthPx) >= SIDEBAR_VIEWPORT_MIN_COLUMNS;
}
