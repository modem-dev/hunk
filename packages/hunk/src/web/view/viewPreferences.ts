/**
 * The page's per-browser view preferences: layout, wrapping, line numbers, and the sidebar.
 *
 * These are presentation and stay with this browser, as the plan classifies them (G1): they
 * never reach the session or the terminal. They persist in `localStorage` so a reload keeps
 * them, every access wrapped because storage can be missing or blocked; the page renders the
 * same without it. A choice this browser stored wins over the session's defaults
 * (`presentation.view`, the host's resolved config), which win over the page's own built-in
 * defaults; those last apply only until the shared state arrives.
 *
 * Tab width and the auto-split width have no page control, so nothing stores an override for
 * them and the session's value is what applies.
 */
import { DEFAULT_AUTO_SPLIT_MIN_WIDTH, type LayoutMode } from "../../core/run/commandInputs";
import { DEFAULT_TAB_WIDTH } from "../../core/run/tabWidth";

export interface WebViewPreferences {
  layout: LayoutMode;
  wrapLines: boolean;
  showLineNumbers: boolean;
  /** Columns per tab stop, applied as Pierre's `--diffs-tab-size`. */
  tabWidth: number;
  /** Fewest monospace columns the diff area needs for `auto` to choose split. */
  autoSplitMinWidth: number;
  sidebarOpen: boolean | undefined;
  sidebarWidth: number;
  sidebarMode: "tree" | "flat";
}

export const DEFAULT_WEB_VIEW_PREFERENCES: WebViewPreferences = {
  layout: "auto",
  wrapLines: false,
  showLineNumbers: true,
  tabWidth: DEFAULT_TAB_WIDTH,
  autoSplitMinWidth: DEFAULT_AUTO_SPLIT_MIN_WIDTH,
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
      tabWidth: DEFAULT_WEB_VIEW_PREFERENCES.tabWidth,
      autoSplitMinWidth: DEFAULT_WEB_VIEW_PREFERENCES.autoSplitMinWidth,
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

/** What this browser changed itself; every field it never touched follows the session. */
export type WebViewOverrides = Partial<WebViewPreferences>;

/** Read only the fields this browser stored, ignoring anything malformed. */
export function readWebViewOverrides(): WebViewOverrides {
  let stored: Partial<Record<keyof WebViewPreferences, unknown>>;
  try {
    stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as typeof stored;
  } catch {
    return {};
  }
  if (!stored || typeof stored !== "object") return {};
  const overrides: WebViewOverrides = {};
  if (["auto", "split", "unified"].includes(stored.layout as string)) {
    overrides.layout = stored.layout as LayoutMode;
  }
  if (typeof stored.wrapLines === "boolean") overrides.wrapLines = stored.wrapLines;
  if (typeof stored.showLineNumbers === "boolean") {
    overrides.showLineNumbers = stored.showLineNumbers;
  }
  if (typeof stored.sidebarOpen === "boolean") overrides.sidebarOpen = stored.sidebarOpen;
  if (typeof stored.sidebarWidth === "number") {
    overrides.sidebarWidth = clampSidebarWidth(stored.sidebarWidth);
  }
  if (stored.sidebarMode === "flat" || stored.sidebarMode === "tree") {
    overrides.sidebarMode = stored.sidebarMode;
  }
  return overrides;
}

/** The view options a session starts a browser from (`presentation.view`). */
export interface WebViewSessionDefaults {
  layout: LayoutMode;
  wrapLines: boolean;
  lineNumbers: boolean;
  tabWidth: number;
  autoSplitMinWidth: number;
  sidebar: boolean | "auto";
}

/**
 * Resolve the effective view: this browser's overrides win, then the session's defaults,
 * then the page's own. A session `sidebar` of `"auto"` leaves the sidebar to the viewport, as
 * the page's own default does.
 */
export function resolveWebViewPreferences(
  overrides: WebViewOverrides,
  session: WebViewSessionDefaults | undefined,
): WebViewPreferences {
  return {
    ...DEFAULT_WEB_VIEW_PREFERENCES,
    ...(session
      ? {
          layout: session.layout,
          wrapLines: session.wrapLines,
          showLineNumbers: session.lineNumbers,
          tabWidth: session.tabWidth,
          autoSplitMinWidth: session.autoSplitMinWidth,
          sidebarOpen: session.sidebar === "auto" ? undefined : session.sidebar,
        }
      : {}),
    ...overrides,
  };
}

/** Store this browser's overrides; skipped silently when storage is blocked. */
export function storeWebViewOverrides(overrides: WebViewOverrides) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // Losing the preference is the whole cost.
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
 * `autoSplitMinWidth` monospace columns (`auto_split_min_width`), unified otherwise.
 */
export function resolveWebLayout(
  layout: LayoutMode,
  diffAreaWidthPx: number,
  columnWidthPx: number,
  autoSplitMinWidth: number = DEFAULT_AUTO_SPLIT_MIN_WIDTH,
): "split" | "unified" {
  if (layout !== "auto") return layout;
  const columns = columnWidthPx > 0 ? diffAreaWidthPx / columnWidthPx : 0;
  return columns >= autoSplitMinWidth ? "split" : "unified";
}

/** Whether the sidebar starts open for a viewport, absent a stored choice. */
export function defaultSidebarOpen(viewportWidthPx: number, columnWidthPx: number) {
  return viewportWidthPx / Math.max(1, columnWidthPx) >= SIDEBAR_VIEWPORT_MIN_COLUMNS;
}
