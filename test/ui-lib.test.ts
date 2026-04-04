import { describe, expect, test } from "bun:test";
import { parseDiffFromFile } from "@pierre/diffs";
import type { KeyEvent } from "@opentui/core";
import type { DiffFile } from "../src/core/types";
import {
  buildMenuSpecs,
  menuBoxHeight,
  menuWidth,
  nextMenuItemIndex,
  type MenuEntry,
} from "../src/ui/components/chrome/menu";
import {
  buildAgentPopoverContent,
  resolveAgentPopoverPlacement,
  wrapText,
} from "../src/ui/lib/agentPopover";
import { buildAppMenus } from "../src/ui/lib/appMenus";
import {
  isHalfPageDownKey,
  isHalfPageUpKey,
  isPageDownKey,
  isPageUpKey,
  isShiftSpacePageUpKey,
  isStepDownKey,
  isStepUpKey,
} from "../src/ui/lib/keyboard";
import { fitText, padText } from "../src/ui/lib/text";
import { computeHunkRevealScrollTop } from "../src/ui/lib/hunkScroll";
import {
  estimateDiffSectionBodyRows,
  measureDiffSectionGeometry,
} from "../src/ui/lib/diffSectionGeometry";
import { resizeSidebarWidth } from "../src/ui/lib/sidebar";
import { resolveTheme } from "../src/ui/themes";

function lines(...values: string[]) {
  return `${values.join("\n")}\n`;
}

function createKeyEvent(overrides: Partial<KeyEvent>): KeyEvent {
  return {
    ctrl: false,
    meta: false,
    name: "",
    sequence: "",
    shift: false,
    ...overrides,
  } as KeyEvent;
}

function createDiffFile(
  before = "const alpha = 1;\nconst beta = 2;\nconst gamma = 3;\nconst stable = true;\n",
  after = "const alpha = 10;\nconst beta = 2;\nconst gamma = 30;\nconst stable = true;\n",
): DiffFile {
  const metadata = parseDiffFromFile(
    {
      name: "example.ts",
      contents: before,
      cacheKey: "before",
    },
    {
      name: "example.ts",
      contents: after,
      cacheKey: "after",
    },
    { context: 0 },
    true,
  );

  return {
    id: "example",
    path: "example.ts",
    patch: "",
    language: "typescript",
    stats: { additions: 2, deletions: 2 },
    metadata,
    agent: null,
  };
}

describe("ui helpers", () => {
  test("buildMenuSpecs lays out the fixed top-level order", () => {
    const specs = buildMenuSpecs();

    expect(specs.map((spec) => spec.id)).toEqual([
      "file",
      "view",
      "navigate",
      "theme",
      "agent",
      "help",
    ]);
    expect(specs[0]).toMatchObject({ id: "file", left: 1, width: 6, label: "File" });
    expect(specs[1]?.left).toBe(specs[0]!.left + specs[0]!.width + 1);
  });

  test("nextMenuItemIndex skips separators in both directions", () => {
    const entries: MenuEntry[] = [
      { kind: "separator" },
      { kind: "item", label: "One", action: () => {} },
      { kind: "separator" },
      { kind: "item", label: "Two", action: () => {} },
    ];

    expect(nextMenuItemIndex(entries, -1, 1)).toBe(1);
    expect(nextMenuItemIndex(entries, 1, 1)).toBe(3);
    expect(nextMenuItemIndex(entries, 1, -1)).toBe(3);
    expect(nextMenuItemIndex([], 0, 1)).toBe(0);
  });

  test("menuWidth and menuBoxHeight account for checks and hints", () => {
    const entries: MenuEntry[] = [
      { kind: "item", label: "Split view", hint: "1", checked: true, action: () => {} },
      { kind: "separator" },
      { kind: "item", label: "Line numbers", hint: "l", checked: false, action: () => {} },
    ];

    expect(menuWidth(entries)).toBeGreaterThanOrEqual(18);
    expect(menuBoxHeight(entries)).toBe(5);
  });

  test("buildAppMenus creates checked entries from the current app state", () => {
    const menus = buildAppMenus({
      activeThemeId: "graphite",
      canRefreshCurrentInput: true,
      focusFilter: () => {},
      layoutMode: "stack",
      moveAnnotatedFile: () => {},
      moveAnnotatedHunk: () => {},
      moveHunk: () => {},
      refreshCurrentInput: () => {},
      requestQuit: () => {},
      selectLayoutMode: () => {},
      selectThemeId: () => {},
      showAgentNotes: true,
      showHelp: false,
      showHunkHeaders: false,
      showLineNumbers: true,
      sidebarVisible: false,
      toggleAgentNotes: () => {},
      toggleFocusArea: () => {},
      toggleHelp: () => {},
      toggleHunkHeaders: () => {},
      toggleLineNumbers: () => {},
      toggleLineWrap: () => {},
      toggleSidebar: () => {},
      wrapLines: true,
    });

    expect(
      menus.file
        .filter((entry): entry is Extract<MenuEntry, { kind: "item" }> => entry.kind === "item")
        .map((entry) => entry.label),
    ).toEqual(["Toggle files/filter focus", "Focus filter", "Reload", "Quit"]);
    expect(menus.file[0]).toMatchObject({
      kind: "item",
      label: "Toggle files/filter focus",
      hint: "Tab",
    });
    expect(
      menus.view
        .filter(
          (entry): entry is Extract<MenuEntry, { kind: "item" }> =>
            entry.kind === "item" && Boolean(entry.checked),
        )
        .map((entry) => entry.label),
    ).toEqual(["Stacked view", "Agent notes", "Line numbers", "Line wrapping"]);
    expect(
      menus.theme
        .filter((entry): entry is Extract<MenuEntry, { kind: "item" }> => entry.kind === "item")
        .map((entry) => entry.label),
    ).toEqual(["Graphite", "Midnight", "Paper", "Ember"]);
    expect(
      menus.theme.some(
        (entry) => entry.kind === "item" && entry.label === "Graphite" && entry.checked,
      ),
    ).toBe(true);
  });

  test("keyboard alias helpers normalize the shared scroll shortcut keys", () => {
    expect(isPageDownKey(createKeyEvent({ name: "pagedown" }))).toBe(true);
    expect(isPageDownKey(createKeyEvent({ name: "space" }))).toBe(true);
    expect(isPageDownKey(createKeyEvent({ name: "f" }))).toBe(true);
    expect(isPageDownKey(createKeyEvent({ sequence: "f" }))).toBe(true);
    expect(isPageUpKey(createKeyEvent({ name: "pageup" }))).toBe(true);
    expect(isPageUpKey(createKeyEvent({ name: "b" }))).toBe(true);
    expect(isPageUpKey(createKeyEvent({ sequence: "b" }))).toBe(true);
    expect(isShiftSpacePageUpKey(createKeyEvent({ name: "space", shift: true }))).toBe(true);
    expect(isHalfPageDownKey(createKeyEvent({ name: "d" }))).toBe(true);
    expect(isHalfPageUpKey(createKeyEvent({ sequence: "u" }))).toBe(true);
    expect(isStepDownKey(createKeyEvent({ name: "down" }))).toBe(true);
    expect(isStepDownKey(createKeyEvent({ sequence: "j" }))).toBe(true);
    expect(isStepUpKey(createKeyEvent({ name: "up" }))).toBe(true);
    expect(isStepUpKey(createKeyEvent({ sequence: "k" }))).toBe(true);
    expect(isPageDownKey(createKeyEvent({ name: "space", shift: true }))).toBe(false);
    expect(isPageDownKey(createKeyEvent({ name: "q" }))).toBe(false);
    expect(isShiftSpacePageUpKey(createKeyEvent({ name: "space", shift: false }))).toBe(false);
  });

  test("fitText and padText clamp using the terminal fallback marker", () => {
    expect(fitText("hello", 0)).toBe("");
    expect(fitText("hello", 1)).toBe(".");
    expect(fitText("hello", 4)).toBe("hel.");
    expect(padText("hello", 4)).toBe("hel.");
    expect(padText("ok", 4)).toBe("ok  ");
  });

  test("agent popover helpers wrap text and right-align the card within the viewport", () => {
    expect(wrapText("alpha beta gamma", 8)).toEqual(["alpha", "beta", "gamma"]);
    expect(wrapText("supercalifragilistic", 6)).toEqual(["superc", "alifra", "gilist", "ic"]);

    const content = buildAgentPopoverContent({
      summary: "Guard missing socket path",
      rationale: "Prevents noisy reconnect errors during first launch.",
      locationLabel: "startup.ts +43-44",
      noteIndex: 0,
      noteCount: 2,
      width: 34,
    });

    expect(content.title).toBe("AI note 1/2");
    expect(content.summaryLines.length).toBeGreaterThan(0);
    expect(content.rationaleLines.length).toBeGreaterThan(0);
    expect(content.height).toBe(9);

    expect(
      resolveAgentPopoverPlacement({
        anchorColumn: 12,
        anchorRowTop: 4,
        anchorRowHeight: 1,
        contentHeight: 20,
        noteWidth: 18,
        noteHeight: 7,
        viewportWidth: 60,
      }),
    ).toMatchObject({ left: 42, top: 4, side: "right" });

    expect(
      resolveAgentPopoverPlacement({
        anchorColumn: 48,
        anchorRowTop: 16,
        anchorRowHeight: 1,
        contentHeight: 20,
        noteWidth: 18,
        noteHeight: 7,
        viewportWidth: 60,
      }),
    ).toMatchObject({ left: 42, top: 13, side: "left" });
  });

  test("resizeSidebarWidth clamps drag updates into the allowed sidebar range", () => {
    expect(resizeSidebarWidth(34, 33, 60, 22, 80)).toBe(61);
    expect(resizeSidebarWidth(34, 33, 0, 22, 80)).toBe(22);
    expect(resizeSidebarWidth(34, 33, 120, 22, 80)).toBe(80);
  });

  test("estimateDiffSectionBodyRows matches split and stack row counts from the render plan", async () => {
    const file = createDiffFile();
    const theme = resolveTheme("midnight", null);

    expect(estimateDiffSectionBodyRows(file, "split", true, theme)).toBeGreaterThan(0);
    expect(estimateDiffSectionBodyRows(file, "stack", true, theme)).toBeGreaterThan(
      estimateDiffSectionBodyRows(file, "split", true, theme),
    );
    expect(estimateDiffSectionBodyRows(file, "split", false, theme)).toBe(
      estimateDiffSectionBodyRows(file, "split", true, theme) - file.metadata.hunks.length,
    );
  });

  test("measureDiffSectionGeometry tracks hidden-header anchor rows across multiple hunks", () => {
    const file = createDiffFile(
      lines(
        "const line1 = 1;",
        "const line2 = 2;",
        "const line3 = 3;",
        "const line4 = 4;",
        "const line5 = 5;",
        "const line6 = 6;",
        "const line7 = 7;",
        "const line8 = 8;",
        "const line9 = 9;",
        "const line10 = 10;",
        "const line11 = 11;",
        "const line12 = 12;",
      ),
      lines(
        "const line1 = 1;",
        "const line2 = 200;",
        "const line3 = 3;",
        "const line4 = 4;",
        "const line5 = 5;",
        "const line6 = 6;",
        "const line7 = 7;",
        "const line8 = 8;",
        "const line9 = 9;",
        "const line10 = 10;",
        "const line11 = 1100;",
        "const line12 = 12;",
      ),
    );
    const theme = resolveTheme("midnight", null);
    const metrics = measureDiffSectionGeometry(file, "split", false, theme);

    expect(metrics.bodyHeight).toBeGreaterThan(0);
    expect(metrics.hunkAnchorRows.get(0)).toBe(1);
    expect(metrics.hunkAnchorRows.get(1)).toBe(3);
    expect(metrics.hunkAnchorRows.get(1)).toBeGreaterThan(metrics.hunkAnchorRows.get(0) ?? -1);
    expect(metrics.hunkBounds.get(0)?.top).toBe(1);
    expect(metrics.hunkBounds.get(0)?.height).toBe(1);
    expect(metrics.hunkBounds.get(1)?.top).toBe(3);
    expect(metrics.hunkBounds.get(1)?.height).toBe(1);
  });

  test("measureDiffSectionGeometry includes visible inline note rows in split mode", () => {
    const file = createDiffFile();
    const theme = resolveTheme("midnight", null);
    const baseGeometry = measureDiffSectionGeometry(file, "split", true, theme);
    const noteGeometry = measureDiffSectionGeometry(
      file,
      "split",
      true,
      theme,
      [
        {
          id: "annotation:example:0",
          annotation: {
            newRange: [1, 1],
            summary: "Explain the changed line",
            rationale: "Keep the inline note height in placeholder math.",
          },
        },
      ],
      120,
    );

    expect(noteGeometry.bodyHeight).toBeGreaterThan(baseGeometry.bodyHeight);
    expect(noteGeometry.hunkAnchorRows.get(0)).toBe(baseGeometry.hunkAnchorRows.get(0));
  });

  test("computeHunkRevealScrollTop keeps a hunk fully visible when it fits", () => {
    expect(
      computeHunkRevealScrollTop({
        hunkTop: 20,
        hunkHeight: 10,
        preferredTopPadding: 4,
        viewportHeight: 12,
      }),
    ).toBe(18);
    expect(
      computeHunkRevealScrollTop({
        hunkTop: 20,
        hunkHeight: 10,
        preferredTopPadding: 4,
        viewportHeight: 16,
      }),
    ).toBe(16);
  });

  test("resolveTheme falls back by requested id and renderer mode while lazily exposing syntax styles", () => {
    const midnight = resolveTheme("midnight", null);
    const missingLight = resolveTheme("missing", "light");
    const missingDark = resolveTheme("missing", "dark");

    expect(midnight.id).toBe("midnight");
    expect(missingLight.id).toBe("paper");
    expect(missingDark.id).toBe("graphite");
    expect(resolveTheme("ember", null).syntaxStyle).toBeDefined();
  });
});
