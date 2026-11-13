import { describe, expect, test } from "bun:test";
import { DEFAULT_AUTO_SPLIT_MIN_WIDTH } from "../../core/run/commandInputs";
import {
  clampSidebarWidth,
  defaultSidebarOpen,
  readWebViewPreferences,
  resolveWebLayout,
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
