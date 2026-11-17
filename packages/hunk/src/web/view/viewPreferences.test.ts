import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_AUTO_SPLIT_MIN_WIDTH } from "../../core/run/commandInputs";
import { DEFAULT_TAB_WIDTH } from "../../core/run/tabWidth";
import {
  clampSidebarWidth,
  defaultSidebarOpen,
  readWebViewOverrides,
  readWebViewPreferences,
  resolveWebLayout,
  resolveWebViewPreferences,
  storeWebViewOverrides,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  DEFAULT_WEB_VIEW_PREFERENCES,
} from "./viewPreferences";

describe("web view preferences", () => {
  // Intent: auto layout follows the terminal's threshold in monospace columns, not pixels.
  test("splits in auto layout at the terminal's column threshold", () => {
    const column = 8;
    expect(resolveWebLayout("auto", DEFAULT_AUTO_SPLIT_MIN_WIDTH * column, column)).toBe("split");
    expect(resolveWebLayout("auto", DEFAULT_AUTO_SPLIT_MIN_WIDTH * column - 1, column)).toBe(
      "unified",
    );
    expect(resolveWebLayout("unified", 10_000, column)).toBe("unified");
    expect(resolveWebLayout("split", 10, column)).toBe("split");
  });

  // Intent: `auto_split_min_width` moves the page's split threshold exactly as the terminal's.
  test("splits in auto layout at the session's configured column threshold", () => {
    const column = 8;
    expect(resolveWebLayout("auto", 100 * column, column, 100)).toBe("split");
    expect(resolveWebLayout("auto", 100 * column - 1, column, 100)).toBe("unified");
    expect(resolveWebLayout("auto", 100 * column, column)).toBe("unified");
  });

  test("hides the sidebar by default on tight viewports", () => {
    expect(defaultSidebarOpen(1440, 8)).toBe(true);
    expect(defaultSidebarOpen(800, 8)).toBe(false);
  });

  test("keeps the sidebar width in bounds", () => {
    expect(clampSidebarWidth(10)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(5_000)).toBe(SIDEBAR_MAX_WIDTH);
  });

  test("falls back to defaults when storage is unavailable", () => {
    // No `window` here, which is the blocked-storage case the page must survive.
    expect(readWebViewPreferences()).toEqual(DEFAULT_WEB_VIEW_PREFERENCES);
  });
});

const SESSION = {
  layout: "unified",
  wrapLines: true,
  lineNumbers: false,
  tabWidth: 8,
  autoSplitMinWidth: 120,
  sidebar: false,
} as const;

/** Install a `window.localStorage` for one test; `getItem`/`setItem` may be made to throw. */
function installTestStorage(initial: string | null, blocked = false) {
  const values = new Map<string, string>();
  if (initial !== null) values.set("hunk.review.view", initial);
  const storage = {
    getItem: (key: string) => {
      if (blocked) throw new Error("SecurityError");
      return values.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (blocked) throw new Error("QuotaExceededError");
      values.set(key, value);
    },
  };
  (globalThis as { window?: unknown }).window = { localStorage: storage };
  return values;
}

describe("web view overrides over session defaults", () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  test("starts from the session's defaults when this browser chose nothing", () => {
    expect(resolveWebViewPreferences({}, SESSION)).toEqual({
      ...DEFAULT_WEB_VIEW_PREFERENCES,
      layout: "unified",
      wrapLines: true,
      showLineNumbers: false,
      tabWidth: 8,
      autoSplitMinWidth: 120,
      sidebarOpen: false,
    });
    expect(resolveWebViewPreferences({}, undefined)).toEqual(DEFAULT_WEB_VIEW_PREFERENCES);
  });

  // Intent: before the shared state arrives the page starts where the terminal's built-in
  // defaults would, so the first paint does not jump when the session's values land.
  test("starts from the terminal's built-in tab width and split threshold", () => {
    expect(DEFAULT_WEB_VIEW_PREFERENCES.tabWidth).toBe(DEFAULT_TAB_WIDTH);
    expect(DEFAULT_WEB_VIEW_PREFERENCES.autoSplitMinWidth).toBe(DEFAULT_AUTO_SPLIT_MIN_WIDTH);
    expect(DEFAULT_WEB_VIEW_PREFERENCES.sidebarOpen).toBeUndefined();
  });

  // Intent: for each published option, this browser's choice beats the session's default,
  // which beats the page's own.
  test("resolves tab width, the split threshold, and the sidebar override, then session, then page", () => {
    const overridden = resolveWebViewPreferences(
      { tabWidth: 2, autoSplitMinWidth: 90, sidebarOpen: true },
      SESSION,
    );
    expect(overridden).toMatchObject({ tabWidth: 2, autoSplitMinWidth: 90, sidebarOpen: true });

    const session = resolveWebViewPreferences({}, SESSION);
    expect(session).toMatchObject({ tabWidth: 8, autoSplitMinWidth: 120, sidebarOpen: false });

    const page = resolveWebViewPreferences({}, undefined);
    expect(page).toMatchObject({
      tabWidth: DEFAULT_TAB_WIDTH,
      autoSplitMinWidth: DEFAULT_AUTO_SPLIT_MIN_WIDTH,
      sidebarOpen: undefined,
    });
  });

  test("maps the session's sidebar choice: open, closed, or left to the viewport", () => {
    expect(resolveWebViewPreferences({}, { ...SESSION, sidebar: true }).sidebarOpen).toBe(true);
    expect(resolveWebViewPreferences({}, { ...SESSION, sidebar: false }).sidebarOpen).toBe(false);
    expect(
      resolveWebViewPreferences({}, { ...SESSION, sidebar: "auto" }).sidebarOpen,
    ).toBeUndefined();
    // A stored choice still wins over a session that asked for the viewport to decide.
    expect(
      resolveWebViewPreferences({ sidebarOpen: false }, { ...SESSION, sidebar: "auto" })
        .sidebarOpen,
    ).toBe(false);
  });

  // Intent: one option the reader changed overrides only that option; the rest keep
  // following the session.
  test("overrides only the options this browser changed", () => {
    expect(resolveWebViewPreferences({ layout: "split", sidebarMode: "flat" }, SESSION)).toEqual({
      ...DEFAULT_WEB_VIEW_PREFERENCES,
      layout: "split",
      wrapLines: true,
      showLineNumbers: false,
      tabWidth: 8,
      autoSplitMinWidth: 120,
      sidebarOpen: false,
      sidebarMode: "flat",
    });
  });

  test("reads back only well-formed stored fields", () => {
    installTestStorage(
      JSON.stringify({
        layout: "diagonal",
        wrapLines: "yes",
        showLineNumbers: false,
        sidebarWidth: 9_000,
        sidebarMode: "flat",
      }),
    );

    expect(readWebViewOverrides()).toEqual({
      showLineNumbers: false,
      sidebarWidth: SIDEBAR_MAX_WIDTH,
      sidebarMode: "flat",
    });
  });

  test("reads nothing from malformed, non-object, or blocked storage", () => {
    for (const stored of ["{not json", "null", "[]", '"split"', "7"]) {
      installTestStorage(stored);
      expect(readWebViewOverrides()).toEqual({});
    }
    installTestStorage(JSON.stringify({ layout: "split" }), true);
    expect(readWebViewOverrides()).toEqual({});
    expect(readWebViewPreferences()).toEqual(DEFAULT_WEB_VIEW_PREFERENCES);
  });

  test("stores overrides for the next read and survives blocked storage", () => {
    const values = installTestStorage(null);
    storeWebViewOverrides({ wrapLines: true });
    expect(readWebViewOverrides()).toEqual({ wrapLines: true });
    expect(values.get("hunk.review.view")).toBe('{"wrapLines":true}');

    installTestStorage(null, true);
    expect(() => storeWebViewOverrides({ wrapLines: true })).not.toThrow();
  });
});
