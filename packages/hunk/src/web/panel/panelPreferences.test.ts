import { afterEach, describe, expect, test } from "bun:test";
import {
  clampSidePanelWidth,
  readSidePanelPreferences,
  resolveSidePanelOpen,
  resolveSidePanelTab,
  SIDE_PANEL_DEFAULT_WIDTH,
  SIDE_PANEL_MAX_WIDTH,
  SIDE_PANEL_MIN_WIDTH,
  storeSidePanelPreferences,
} from "./panelPreferences";

/** A minimal in-memory `localStorage` for one test. */
function installTestStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  };
  return values;
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("side panel preferences", () => {
  test("starts closed at every width, and a stored choice wins", () => {
    installTestStorage();
    const preferences = readSidePanelPreferences();

    expect(preferences).toEqual({
      open: undefined,
      width: SIDE_PANEL_DEFAULT_WIDTH,
      tab: undefined,
    });
    expect(resolveSidePanelOpen(preferences)).toBe(false);
    expect(resolveSidePanelOpen({ ...preferences, open: true })).toBe(true);
    expect(resolveSidePanelOpen({ ...preferences, open: false })).toBe(false);
  });

  test("opens on Notes when the review has notes and no tab was ever chosen", () => {
    installTestStorage();
    const preferences = readSidePanelPreferences();

    expect(resolveSidePanelTab(preferences, true)).toBe("notes");
    expect(resolveSidePanelTab(preferences, false)).toBe("overview");
    expect(resolveSidePanelTab({ ...preferences, tab: "overview" }, true)).toBe("overview");
  });

  test("round-trips through storage and ignores malformed values", () => {
    const values = installTestStorage();
    storeSidePanelPreferences({ open: true, width: 400, tab: "overview" });
    expect(readSidePanelPreferences()).toEqual({ open: true, width: 400, tab: "overview" });

    values.set("hunk.review.panel", JSON.stringify({ open: "yes", width: 5000, tab: "nope" }));
    expect(readSidePanelPreferences()).toEqual({
      open: undefined,
      width: SIDE_PANEL_MAX_WIDTH,
      tab: undefined,
    });
    values.set("hunk.review.panel", "{not json");
    expect(readSidePanelPreferences().width).toBe(SIDE_PANEL_DEFAULT_WIDTH);
  });

  test("clamps widths to the panel's bounds", () => {
    expect(clampSidePanelWidth(10)).toBe(SIDE_PANEL_MIN_WIDTH);
    expect(clampSidePanelWidth(10_000)).toBe(SIDE_PANEL_MAX_WIDTH);
    expect(clampSidePanelWidth(333.4)).toBe(333);
  });

  test("works without storage", () => {
    expect(readSidePanelPreferences().width).toBe(SIDE_PANEL_DEFAULT_WIDTH);
    expect(() =>
      storeSidePanelPreferences({ open: true, width: 300, tab: "overview" }),
    ).not.toThrow();
  });
});
