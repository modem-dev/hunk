import { describe, expect, test } from "bun:test";
import { parseDiffFromFile } from "@pierre/diffs";
import type { DiffFile } from "../src/core/types";
import { buildMenuSpecs, menuBoxHeight, menuWidth, nextMenuItemIndex, type MenuEntry } from "../src/ui/components/chrome/menu";
import { buildAgentPopoverContent, resolveAgentPopoverPlacement, wrapText } from "../src/ui/lib/agentPopover";
import { buildAppMenus } from "../src/ui/lib/appMenus";
import { fitText, padText } from "../src/ui/lib/text";
import { estimateDiffBodyRows } from "../src/ui/lib/sectionHeights";
import { resizeSidebarWidth } from "../src/ui/lib/sidebar";
import { resolveTheme } from "../src/ui/themes";

function createDiffFile(): DiffFile {
  const metadata = parseDiffFromFile(
    {
      name: "example.ts",
      contents: "const alpha = 1;\nconst beta = 2;\nconst gamma = 3;\nconst stable = true;\n",
      cacheKey: "before",
    },
    {
      name: "example.ts",
      contents: "const alpha = 10;\nconst beta = 2;\nconst gamma = 30;\nconst stable = true;\n",
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

    expect(specs.map((spec) => spec.id)).toEqual(["file", "view", "navigate", "theme", "agent", "help"]);
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

  test("buildAppMenus creates checked entries from the current shell state", () => {
    const menus = buildAppMenus({
      activeThemeId: "graphite",
      focusFiles: () => {},
      focusFilter: () => {},
      layoutMode: "stack",
      moveAnnotatedFile: () => {},
      moveHunk: () => {},
      requestQuit: () => {},
      selectLayoutMode: () => {},
      selectThemeId: () => {},
      showAgentNotes: true,
      showHelp: false,
      showHunkHeaders: false,
      showLineNumbers: true,
      sidebarVisible: false,
      toggleAgentNotes: () => {},
      toggleHelp: () => {},
      toggleHunkHeaders: () => {},
      toggleLineNumbers: () => {},
      toggleLineWrap: () => {},
      toggleSidebar: () => {},
      wrapLines: true,
    });

    expect(
      menus.view
        .filter((entry): entry is Extract<MenuEntry, { kind: "item" }> => entry.kind === "item" && Boolean(entry.checked))
        .map((entry) => entry.label),
    ).toEqual([
      "Stacked view",
      "Agent notes",
      "Line numbers",
      "Line wrapping",
    ]);
    expect(
      menus.theme
        .filter((entry): entry is Extract<MenuEntry, { kind: "item" }> => entry.kind === "item")
        .map((entry) => entry.label),
    ).toEqual(["Graphite", "Midnight", "Paper", "Ember"]);
    expect(menus.theme.some((entry) => entry.kind === "item" && entry.label === "Graphite" && entry.checked)).toBe(true);
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

  test("estimateDiffBodyRows matches split and stack row counts for hidden-context diffs", async () => {
    const file = createDiffFile();

    expect(estimateDiffBodyRows(file, "split", true)).toBeGreaterThan(0);
    expect(estimateDiffBodyRows(file, "stack", true)).toBeGreaterThan(estimateDiffBodyRows(file, "split", true));
    expect(estimateDiffBodyRows(file, "split", false)).toBe(estimateDiffBodyRows(file, "split", true) - file.metadata.hunks.length);
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
