import { describe, expect, test } from "bun:test";
import { parseDiffFromFile } from "@pierre/diffs";
import type { KeyEvent } from "@opentui/core";
import stringWidth from "string-width";
import type { DiffFile } from "../../core/changeset/model";
import {
  buildMenuSpecs,
  menuBarTitleWidth,
  menuBoxHeight,
  menuWidth,
  nextMenuItemIndex,
  responsiveMenuSpecs,
  type MenuEntry,
} from "../components/chrome/menu";
import { createVisibleAgentNote } from "./agentAnnotations";
import { buildAgentPopoverContent, resolveAgentPopoverPlacement } from "./agentPopover";
import { isEscapeKey, isSaveDraftNoteKey } from "./keyboard";
import {
  BoundedClusterWidthCache,
  CLUSTER_WIDTH_CACHE_MAX_ENTRIES,
  CLUSTER_WIDTH_CACHE_MAX_KEY_CODE_UNITS,
  cellRangeToCharRange,
  fitText,
  measureClusterWidth,
  measureTextWidth,
  padText,
  sliceTextByWidth,
  wrapText,
  wrapTextByWidth,
} from "./text";
import { computeHunkRevealScrollTop } from "./hunkScroll";
import {
  estimateDiffSectionBodyRows,
  measureDiffSectionGeometry,
} from "../diff/diffSectionGeometry";
import { resizeSidebarWidth } from "./sidebar";
import { resolveTheme } from "../themes";
import { createTestCustomThemes } from "../../../test/helpers/theme-helpers";

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
  test("buildMenuSpecs lays out the menus a session has", () => {
    const item: MenuEntry = { kind: "item", label: "One", action: () => {} };
    const specs = buildMenuSpecs({
      file: [item],
      view: [item],
      navigate: [item],
      agent: [item],
      help: [item],
    });

    expect(specs.map((spec) => spec.id)).toEqual(["file", "view", "navigate", "agent", "help"]);
    expect(specs).toMatchObject([
      { id: "file", left: 1, width: 6, label: "File" },
      { id: "view", left: 7, width: 6, label: "View" },
      { id: "navigate", left: 13, width: 10, label: "Navigate" },
      { id: "agent", left: 23, width: 7, label: "Agent" },
      { id: "help", left: 30, width: 6, label: "Help" },
    ]);
  });

  test("buildMenuSpecs seats an Extensions menu before Help and skips it when empty", () => {
    const item: MenuEntry = { kind: "item", label: "One", action: () => {} };
    const base = { file: [item], view: [item], navigate: [item], agent: [item], help: [item] };

    expect(buildMenuSpecs({ ...base, extensions: [item] })).toMatchObject([
      { id: "file", left: 1 },
      { id: "view", left: 7 },
      { id: "navigate", left: 13 },
      { id: "agent", left: 23 },
      { id: "extensions", left: 30, width: 12, label: "Extensions" },
      { id: "help", left: 42, width: 6, label: "Help" },
    ]);
    // An id with no entries takes neither a slot nor a label on the bar.
    expect(buildMenuSpecs({ ...base, extensions: [] }).map((spec) => spec.id)).toEqual([
      "file",
      "view",
      "navigate",
      "agent",
      "help",
    ]);
  });

  test("nextMenuItemIndex skips separators and disabled items in both directions", () => {
    const entries: MenuEntry[] = [
      { kind: "separator" },
      { kind: "item", label: "One", action: () => {} },
      { kind: "item", label: "Unavailable", disabled: true, action: () => {} },
      { kind: "item", label: "Two", action: () => {} },
    ];

    expect(nextMenuItemIndex(entries, -1, 1)).toBe(1);
    expect(nextMenuItemIndex(entries, 1, 1)).toBe(3);
    expect(nextMenuItemIndex(entries, 1, -1)).toBe(3);
    expect(nextMenuItemIndex([], 0, 1)).toBe(0);
  });

  test("menuWidth and menuBoxHeight account for checks and hints", () => {
    const entries: MenuEntry[] = [
      {
        kind: "item",
        label: "Split view",
        hint: "1",
        checked: true,
        action: () => {},
      },
      { kind: "separator" },
      {
        kind: "item",
        label: "Line numbers",
        hint: "l",
        checked: false,
        action: () => {},
      },
    ];

    expect(menuWidth(entries)).toBeGreaterThanOrEqual(18);
    expect(menuBoxHeight(entries)).toBe(5);
  });

  test("menuWidth measures terminal cells, so wide characters are not clipped", () => {
    const ascii: MenuEntry[] = [{ kind: "item", label: "12345678901234567890", action: () => {} }];
    // Same count of user-visible characters, but CJK renders two cells each.
    const wide: MenuEntry[] = [
      { kind: "item", label: "拡張機能のコマンドを実行します", action: () => {} },
    ];

    expect(menuWidth(wide)).toBe(menuWidth(ascii) + 10);
  });

  test("responsive menus keep hidden commands reachable behind a visible overflow", () => {
    const item: MenuEntry = { kind: "item", label: "One", action: () => {} };
    const specs = buildMenuSpecs({
      file: [item],
      view: [item],
      navigate: [item],
      commit: [item],
      help: [item],
    });
    const layout = responsiveMenuSpecs(specs, 20);
    expect(layout.visible.map((spec) => spec.id)).toEqual(["file", "view"]);
    expect(layout.hidden.map((spec) => spec.id)).toEqual(["navigate", "commit", "help"]);
    expect(layout.overflowLeft).toBe(13);
  });

  test("menuBarTitleWidth cedes title space to the menus the bar shows", () => {
    const item: MenuEntry = { kind: "item", label: "One", action: () => {} };
    const base = { file: [item], view: [item], navigate: [item], agent: [item], help: [item] };
    const withoutExtensions = buildMenuSpecs(base);
    const withExtensions = buildMenuSpecs({ ...base, extensions: [item] });

    // Parity with the bar before the Extensions menu existed: five menus over
    // 35 columns left 39 title cells at 80 columns wide.
    expect(menuBarTitleWidth(withoutExtensions, 80)).toBe(39);
    // The Extensions menu's 12 columns come out of the title, not the row.
    expect(menuBarTitleWidth(withExtensions, 80)).toBe(27);
    const menusWidth = withExtensions.reduce((total, spec) => total + spec.width, 0);
    expect(menusWidth + menuBarTitleWidth(withExtensions, 80)).toBeLessThanOrEqual(80 - 3);
    // A terminal narrower than the menus still never yields a negative width.
    expect(menuBarTitleWidth(withExtensions, 40)).toBe(0);
  });

  test("escape aliases normalize across terminal input paths", () => {
    expect(isEscapeKey(createKeyEvent({ name: "escape" }))).toBe(true);
    expect(isEscapeKey(createKeyEvent({ name: "esc" }))).toBe(true);
    expect(isEscapeKey(createKeyEvent({ name: "q" }))).toBe(false);
  });

  test("save-draft-note shortcut matches Ctrl-S across raw, CSI-u, and tmux encodings", () => {
    const CTRL_S = "\u0013";
    const CTRL_S_CSI_U = "\u001b[115;5u";

    // Modifier-flagged Ctrl-S from terminals that report ctrl + the letter.
    expect(isSaveDraftNoteKey(createKeyEvent({ ctrl: true, name: "s" }))).toBe(true);
    expect(isSaveDraftNoteKey(createKeyEvent({ ctrl: true, sequence: "s" }))).toBe(true);
    // Raw control byte with no modifier flag set (sequence or raw channel).
    expect(isSaveDraftNoteKey(createKeyEvent({ sequence: CTRL_S }))).toBe(true);
    expect(isSaveDraftNoteKey(createKeyEvent({ raw: CTRL_S }))).toBe(true);
    // Kitty/CSI-u encoding on either channel.
    expect(isSaveDraftNoteKey(createKeyEvent({ sequence: CTRL_S_CSI_U }))).toBe(true);
    expect(isSaveDraftNoteKey(createKeyEvent({ raw: CTRL_S_CSI_U }))).toBe(true);
    // Unmodified s and other ctrl chords must not save.
    expect(isSaveDraftNoteKey(createKeyEvent({ name: "s" }))).toBe(false);
    expect(isSaveDraftNoteKey(createKeyEvent({ ctrl: true, name: "x" }))).toBe(false);
  });

  test("fitText and padText clamp using the terminal fallback marker", () => {
    expect(fitText("hello", 0)).toBe("");
    expect(fitText("hello", 1)).toBe(".");
    expect(fitText("hello", 4)).toBe("hel.");
    expect(padText("hello", 4)).toBe("hel.");
    expect(padText("ok", 4)).toBe("ok  ");
  });

  test("text helpers measure and slice wide characters by terminal cells", () => {
    expect(measureTextWidth("日本語")).toBe(6);
    expect(sliceTextByWidth("a日本b", 1, 4)).toEqual({ text: "日本", width: 4 });
    expect(sliceTextByWidth("a日本b", 2, 4)).toEqual({ text: " 本b", width: 4 });
    expect(sliceTextByWidth("日本b", 3, 3)).toEqual({ text: " b", width: 2 });
    expect(sliceTextByWidth("日", 1, 1)).toEqual({ text: " ", width: 1 });
    expect(sliceTextByWidth("👍🏽x", 0, 2)).toEqual({ text: "👍🏽", width: 2 });
    expect(sliceTextByWidth("🧑‍💻x", 1, 1)).toEqual({ text: " ", width: 1 });
    expect(sliceTextByWidth("e\u0301x", 0, 1)).toEqual({ text: "e\u0301", width: 1 });
    expect(sliceTextByWidth("♥️x", 0, 2)).toEqual({ text: "♥️", width: 2 });
    expect(fitText("日本語", 5)).toBe("日本.");
    expect(measureTextWidth(padText("日本", 6))).toBe(6);
  });

  test("wrapTextByWidth traverses wide graphemes once while honoring remaining line cells", () => {
    expect(wrapTextByWidth("a日本b", 4)).toEqual([
      { text: "a日", width: 3, startsNewLine: false },
      { text: "本b", width: 3, startsNewLine: true },
    ]);
    expect(wrapTextByWidth("abcdef", 4, 2)).toEqual([
      { text: "ab", width: 2, startsNewLine: false },
      { text: "cdef", width: 4, startsNewLine: true },
    ]);
    expect(wrapTextByWidth("e\u0301x", 1)).toEqual([
      { text: "e\u0301", width: 1, startsNewLine: false },
      { text: "x", width: 1, startsNewLine: true },
    ]);
    expect(sliceTextByWidth("🇯🇵", 0, 1)).toEqual({ text: "", width: 0 });
    expect(wrapTextByWidth("🇯🇵", 1)).toEqual([]);
    expect(sliceTextByWidth("\u0d4eകx", 0, 1)).toEqual({ text: "\u0d4eക", width: 1 });
    expect(wrapTextByWidth("\u0d4eകx", 1)).toEqual([
      { text: "\u0d4eക", width: 1, startsNewLine: false },
      { text: "x", width: 1, startsNewLine: true },
    ]);
    for (const cluster of ["กำ", "ກຳ", "ｶﾞ", "ｶﾟ"]) {
      const width = stringWidth(cluster);
      expect(measureTextWidth(cluster)).toBe(width);
      expect(sliceTextByWidth(cluster, 0, width)).toEqual({ text: cluster, width });
      expect(wrapTextByWidth(cluster, width)).toEqual([
        { text: cluster, width, startsNewLine: false },
      ]);
    }
  });

  test("cellRangeToCharRange maps inclusive cell ranges onto code-unit slice bounds", () => {
    // ASCII: cells and code units are identical, and out-of-range cells clamp to the text.
    expect(cellRangeToCharRange("hello", 1, 3)).toEqual({ startIndex: 1, endIndex: 4 });
    expect(cellRangeToCharRange("hello", 0, 99)).toEqual({ startIndex: 0, endIndex: 5 });

    // "a日本b" layout: a=cell 0, 日=cells 1-2, 本=cells 3-4, b=cell 5.
    expect(cellRangeToCharRange("a日本b", 1, 2)).toEqual({ startIndex: 1, endIndex: 2 });
    expect(cellRangeToCharRange("a日本b", 3, 5)).toEqual({ startIndex: 2, endIndex: 4 });
    expect(cellRangeToCharRange("a日本b", 6, 9)).toEqual({ startIndex: 4, endIndex: 4 });

    // Clusters partially covered by the cell range are included in full on both edges.
    expect(cellRangeToCharRange("a日本b", 2, 3)).toEqual({ startIndex: 1, endIndex: 3 });

    // Surrogate-pair emoji (👍 = two code units, two cells) never split mid-pair.
    expect(cellRangeToCharRange("👍a", 1, 2)).toEqual({ startIndex: 0, endIndex: 3 });
    expect(cellRangeToCharRange("👍a", 2, 2)).toEqual({ startIndex: 2, endIndex: 3 });

    // ZWJ emoji sequences stay one cluster (🧑‍💻 = five code units, two cells).
    expect(cellRangeToCharRange("🧑‍💻x", 1, 1)).toEqual({ startIndex: 0, endIndex: 5 });
    expect(cellRangeToCharRange("🧑‍💻x", 2, 2)).toEqual({ startIndex: 5, endIndex: 6 });

    // Zero-width characters at the range start are kept so invisible characters round-trip,
    // while zero-width characters strictly before the range stay excluded.
    expect(cellRangeToCharRange("\u200bab", 0, 0)).toEqual({ startIndex: 0, endIndex: 2 });
    expect(cellRangeToCharRange("\u200bab", 1, 1)).toEqual({ startIndex: 2, endIndex: 3 });
  });

  test("cluster width measurement matches string-width across terminal text shapes", () => {
    const clusters = [
      "",
      "\0",
      "\u200b",
      "\u0301",
      "\ud800",
      "─",
      "·",
      "日",
      "👍",
      "e\u0301",
      "1\u20e3",
      "🧑‍💻",
      "\u1100\u1161\u11a8",
    ];

    for (const cluster of clusters) {
      expect(measureClusterWidth(cluster)).toBe(stringWidth(cluster));
    }

    const complexLines = [
      "日本語 scalar text 👍 🚀",
      "🧑‍💻 👩‍🔬 terminal tools",
      "👍🏽 emoji modifier",
      "1️⃣ keycap sequence",
      "♥️ variation selector",
      "🇯🇵 regional indicators",
      "e\u0301 a\u0308 combining text",
      "\u1100\u1161\u11a8 Hangul Jamo",
    ];
    for (const line of complexLines) {
      expect(measureTextWidth(line)).toBe(stringWidth(line));
    }
  });

  test("bounded cluster cache evicts FIFO entries and rejects oversized keys", () => {
    const cache = new BoundedClusterWidthCache(
      CLUSTER_WIDTH_CACHE_MAX_ENTRIES,
      CLUSTER_WIDTH_CACHE_MAX_KEY_CODE_UNITS,
    );
    for (let index = 0; index < CLUSTER_WIDTH_CACHE_MAX_ENTRIES; index += 1) {
      cache.set(`cluster-${index}`, index);
    }

    // Reads do not change FIFO order, so the oldest entry is still evicted.
    expect(cache.get("cluster-0")).toBe(0);
    cache.set("cluster-new", CLUSTER_WIDTH_CACHE_MAX_ENTRIES);
    expect(cache.size).toBe(CLUSTER_WIDTH_CACHE_MAX_ENTRIES);
    expect(cache.get("cluster-0")).toBeUndefined();
    expect(cache.get("cluster-new")).toBe(CLUSTER_WIDTH_CACHE_MAX_ENTRIES);

    const oversizedKey = "x".repeat(CLUSTER_WIDTH_CACHE_MAX_KEY_CODE_UNITS + 1);
    cache.set(oversizedKey, 999);
    expect(cache.size).toBe(CLUSTER_WIDTH_CACHE_MAX_ENTRIES);
    expect(cache.get(oversizedKey)).toBeUndefined();
    expect(cache.get("cluster-1")).toBe(1);
  });

  test("complex cluster widths stay exact across bounded-cache churn", () => {
    const clusters = Array.from(
      { length: 300 },
      (_, index) =>
        `${String.fromCodePoint(0x61 + (index % 26))}${String.fromCodePoint(
          0x300 + (index % 112),
        )}${String.fromCodePoint(0x300 + (Math.floor(index / 112) % 112))}`,
    );

    for (const cluster of clusters) {
      expect(measureTextWidth(cluster)).toBe(stringWidth(cluster));
    }

    // An oversized combining cluster stays exact without becoming a retained cache key.
    const oversizedCluster = `a${"\u0301".repeat(64)}`;
    expect(measureTextWidth(oversizedCluster)).toBe(stringWidth(oversizedCluster));
    expect(measureTextWidth(clusters[0]!)).toBe(stringWidth(clusters[0]!));
  });

  test("repeated single-character runs use the fast width path without losing correctness", () => {
    // Chrome glyph separators: single-cell non-ASCII characters repeated to fill a row.
    expect(measureTextWidth("─".repeat(240))).toBe(240);
    expect(fitText("─".repeat(240), 240)).toBe("─".repeat(240));
    expect(fitText("─".repeat(300), 240)).toBe(`${"─".repeat(239)}.`);

    // A repeated wide (CJK) character must still count two cells per character.
    expect(measureTextWidth("好".repeat(120))).toBe(240);
    expect(fitText("好".repeat(4), 6)).toBe("好好.");

    // Surrogate-pair runs (emoji) skip the fast path and stay correct via string-width.
    expect(measureTextWidth("👍".repeat(3))).toBe(6);

    // Zero-width and composition-sensitive repeated scalars defer to whole grapheme measurement.
    expect(measureTextWidth("\u0301".repeat(4))).toBe(0);
    expect(measureTextWidth("e\u0301")).toBe(1);
    for (const scalar of ["\u0d4e", "ำ", "ຳ"]) {
      expect(measureTextWidth(scalar.repeat(2))).toBe(stringWidth(scalar.repeat(2)));
    }
  });

  test("agent popover helpers wrap text and right-align the card within the viewport", () => {
    expect(wrapText("alpha beta gamma", 8)).toEqual(["alpha", "beta", "gamma"]);
    expect(wrapText("supercalifragilistic", 6)).toEqual(["superc", "alifra", "gilist", "ic"]);

    // Wide text wraps by terminal cells, not UTF-16 code units, so CJK lines
    // never overflow the box and get clipped by fitText/padText downstream.
    expect(wrapText("こんにちは世界", 8)).toEqual(["こんにち", "は世界"]);
    expect(wrapText("これは全角文字の長い注釈です", 10)).toEqual([
      "これは全角",
      "文字の長い",
      "注釈です",
    ]);
    expect(wrapText("fix 説明が長い日本語のまま続く", 10)).toEqual([
      "fix",
      "説明が長い",
      "日本語のま",
      "ま続く",
    ]);

    // Emoji clusters (surrogate pairs) are never split into lone surrogates.
    expect(wrapText("🎉🎉🎉", 4)).toEqual(["🎉🎉", "🎉"]);

    // Odd width: a 2-cell character cannot straddle the boundary, so each
    // line carries one character even though a cell stays unused.
    expect(wrapText("日本語", 3)).toEqual(["日", "本", "語"]);

    // Multiple ASCII words still pack into one line when they fit.
    expect(wrapText("ab cd", 5)).toEqual(["ab cd"]);

    // Width narrower than one cluster keeps the text for fitText to clamp
    // at render time instead of silently dropping it.
    expect(wrapText("日日", 1)).toEqual(["日日"]);

    // ZWJ emoji clusters stay whole when hard-splitting.
    expect(wrapText("🧑‍💻🧑‍💻", 2)).toEqual(["🧑‍💻", "🧑‍💻"]);

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
    const theme = resolveTheme("github-dark-default", null);

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
    const theme = resolveTheme("github-dark-default", null);
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
    const theme = resolveTheme("github-dark-default", null);
    const baseGeometry = measureDiffSectionGeometry(file, "split", true, theme);
    const noteGeometry = measureDiffSectionGeometry(
      file,
      "split",
      true,
      theme,
      [
        createVisibleAgentNote(file.metadata.hunks, {
          id: "annotation:example:0",
          annotation: {
            newRange: [1, 1],
            summary: "Explain the changed line",
            rationale: "Keep the inline note height in placeholder math.",
          },
        }),
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

  test("resolveTheme falls back to GitHub defaults while exposing semantic syntax colors", () => {
    const dracula = resolveTheme("dracula", null);
    const missingLight = resolveTheme("missing", "light");
    const missingDark = resolveTheme("missing", "dark");
    const autoLight = resolveTheme("auto", "light");
    const autoDark = resolveTheme("auto", "dark");
    const custom = resolveTheme(
      "custom",
      null,
      createTestCustomThemes({
        base: "github-light-default",
        label: "My Theme",
        accent: "#7755aa",
        syntaxScopes: {
          "keyword.control": "#123456",
        },
      }),
    );
    const missingCustom = resolveTheme("custom", null);

    expect(dracula.id).toBe("dracula");
    expect(missingLight.id).toBe("github-light-default");
    expect(missingDark.id).toBe("github-dark-default");
    expect(autoLight.id).toBe("github-light-default");
    expect(autoDark.id).toBe("github-dark-default");
    expect(custom.id).toBe("custom");
    expect(custom.label).toBe("My Theme");
    expect(custom.appearance).toBe("light");
    expect(custom.accent).toBe("#7755aa");
    expect(custom.syntaxScopeOverrides).toEqual({ "keyword.control": "#123456" });
    expect(missingCustom.id).toBe("github-dark-default");
    expect(custom.syntaxColors.default).toBe("#1f2328");
  });
});
