import { describe, expect, test } from "bun:test";
import { createTestDiffFile, lines } from "../../../test/helpers/diff-helpers";
import type { ValidatedLineHighlight } from "../highlights/validate";
import {
  applyLineHighlightsToSpans,
  buildLineHighlightPaintIndex,
  lineHighlightPaintKey,
} from "./lineHighlightPaint";
import type { RenderSpan } from "./pierre";

/** Shorthand for one validated mark. */
function mark(
  side: "old" | "new",
  line: number,
  start: number,
  end: number,
  tone: ValidatedLineHighlight["tone"] = "match",
): ValidatedLineHighlight {
  return { side, line, start, end, tone };
}

describe("buildLineHighlightPaintIndex", () => {
  test("maps addition and deletion offsets to columns on their own sides", () => {
    const file = createTestDiffFile({
      before: lines("const alpha = 1;"),
      after: lines("const alpha = 10;"),
    });

    const index = buildLineHighlightPaintIndex({
      file,
      marks: [mark("new", 1, 6, 11), mark("old", 1, 14, 15, "error")],
    });

    expect(index?.get(lineHighlightPaintKey("new", 1))).toEqual([
      { startCol: 6, endCol: 11, tone: "match" },
    ]);
    expect(index?.get(lineHighlightPaintKey("old", 1))).toEqual([
      { startCol: 14, endCol: 15, tone: "error" },
    ]);
  });

  test("mirrors a context-line mark onto both side keys with one shared range list", () => {
    const file = createTestDiffFile({
      before: lines("shared line", "old only"),
      after: lines("shared line", "new only"),
      context: 1,
    });

    const index = buildLineHighlightPaintIndex({
      file,
      marks: [mark("new", 1, 0, 6)],
    });

    const newRanges = index?.get(lineHighlightPaintKey("new", 1));
    const oldRanges = index?.get(lineHighlightPaintKey("old", 1));
    expect(newRanges).toEqual([{ startCol: 0, endCol: 6, tone: "match" }]);
    // The same physical line renders on both split halves; identity equality
    // keeps stack view from double-counting the mirrored entry.
    expect(oldRanges).toBe(newRanges!);
  });

  test("expands tabs when converting offsets to columns", () => {
    const file = createTestDiffFile({
      before: lines("none"),
      after: lines("\tfoo = 1;"),
      context: 0,
    });

    const index = buildLineHighlightPaintIndex({
      file,
      marks: [mark("new", 1, 1, 4)],
      tabWidth: 4,
    });

    // The tab consumes columns 0-3, so "foo" starts at column 4.
    expect(index?.get(lineHighlightPaintKey("new", 1))).toEqual([
      { startCol: 4, endCol: 7, tone: "match" },
    ]);
  });

  test("widens a mid-surrogate offset to the whole glyph", () => {
    const file = createTestDiffFile({
      before: lines("none"),
      after: lines('x = "\u{1F44D}ok";'),
    });

    // "\u{1F44D}" occupies code units 5-6; starting inside it snaps down to 5.
    const index = buildLineHighlightPaintIndex({
      file,
      marks: [mark("new", 1, 6, 9)],
    });

    // Columns: `x = "` is 5 cells, the emoji is 2 cells wide, then "ok".
    expect(index?.get(lineHighlightPaintKey("new", 1))).toEqual([
      { startCol: 5, endCol: 9, tone: "match" },
    ]);
  });

  test("drops marks on lines the patch does not carry", () => {
    const file = createTestDiffFile({
      before: lines("const alpha = 1;"),
      after: lines("const alpha = 10;"),
    });

    const index = buildLineHighlightPaintIndex({
      file,
      marks: [mark("new", 99, 0, 4)],
    });

    expect(index).toBeUndefined();
  });

  test("resolves collapsed-gap lines through loaded source, keyed under both sides", () => {
    const after = lines("line one", "line two", "line three", "line four", "changed");
    const file = createTestDiffFile({
      before: lines("line one", "line two", "line three", "line four", "original"),
      after,
      context: 0,
    });
    // The single hunk sits at line 5, so lines 1-4 are a leading collapsed gap.
    expect(file.metadata.hunks[0]?.collapsedBefore).toBeGreaterThan(0);

    const withoutSource = buildLineHighlightPaintIndex({
      file,
      marks: [mark("new", 2, 5, 8)],
    });
    expect(withoutSource).toBeUndefined();

    const index = buildLineHighlightPaintIndex({
      file,
      marks: [mark("new", 2, 5, 8)],
      sourceText: after,
    });
    expect(index?.get(lineHighlightPaintKey("new", 2))).toEqual([
      { startCol: 5, endCol: 8, tone: "match" },
    ]);
    // Gap rows render the same physical line under both numbers, like context rows.
    expect(index?.get(lineHighlightPaintKey("old", 2))).toBe(
      index!.get(lineHighlightPaintKey("new", 2))!,
    );
  });

  test("sorts ranges by start column for deterministic painting", () => {
    const file = createTestDiffFile({
      before: lines("none"),
      after: lines("abcdefghij"),
    });

    const index = buildLineHighlightPaintIndex({
      file,
      marks: [mark("new", 1, 6, 8, "info"), mark("new", 1, 1, 3)],
    });

    expect(index?.get(lineHighlightPaintKey("new", 1))).toEqual([
      { startCol: 1, endCol: 3, tone: "match" },
      { startCol: 6, endCol: 8, tone: "info" },
    ]);
  });

  test("returns undefined for no marks", () => {
    const file = createTestDiffFile();
    expect(buildLineHighlightPaintIndex({ file, marks: [] })).toBeUndefined();
  });
});

describe("applyLineHighlightsToSpans", () => {
  const resolveBg = (tone: string) => ({ bg: `bg-${tone}` });

  test("splits one span at range boundaries and repaints only the marked run", () => {
    const spans: RenderSpan[] = [{ text: "const alpha = 10;", fg: "#ffffff" }];

    const painted = applyLineHighlightsToSpans(
      spans,
      [{ startCol: 6, endCol: 11, tone: "match" }],
      resolveBg,
    );

    expect(painted).toEqual([
      { text: "const ", fg: "#ffffff" },
      { text: "alpha", fg: "#ffffff", bg: "bg-match" },
      { text: " = 10;", fg: "#ffffff" },
    ]);
  });

  test("never mutates the shared input spans", () => {
    const spans: RenderSpan[] = [{ text: "const alpha = 10;" }];
    const before = JSON.stringify(spans);

    applyLineHighlightsToSpans(spans, [{ startCol: 0, endCol: 5, tone: "match" }], resolveBg);

    expect(JSON.stringify(spans)).toBe(before);
  });

  test("paints across span boundaries while preserving each span's own colors", () => {
    const spans: RenderSpan[] = [
      { text: "const ", fg: "#111111" },
      { text: "alpha", fg: "#222222" },
      { text: " = 10;", fg: "#333333" },
    ];

    const painted = applyLineHighlightsToSpans(
      spans,
      [{ startCol: 3, endCol: 8, tone: "info" }],
      resolveBg,
    );

    expect(painted).toEqual([
      { text: "con", fg: "#111111" },
      { text: "st ", fg: "#111111", bg: "bg-info" },
      { text: "al", fg: "#222222", bg: "bg-info" },
      { text: "pha", fg: "#222222" },
      { text: " = 10;", fg: "#333333" },
    ]);
  });

  test("overrides a word-diff emphasis background inside the marked range only", () => {
    const spans: RenderSpan[] = [
      { text: "alpha", bg: "#204020" },
      { text: "beta", bg: "#204020" },
    ];

    const painted = applyLineHighlightsToSpans(
      spans,
      [{ startCol: 5, endCol: 9, tone: "match" }],
      resolveBg,
    );

    expect(painted).toEqual([
      { text: "alpha", bg: "#204020" },
      { text: "beta", bg: "bg-match" },
    ]);
  });

  test("applies a foreground too when the tone style inverts", () => {
    const spans: RenderSpan[] = [{ text: "const alpha = 10;", fg: "#ffffff" }];

    const painted = applyLineHighlightsToSpans(
      spans,
      [{ startCol: 6, endCol: 11, tone: "current" }],
      () => ({ bg: "#eeeeee", fg: "#111111" }),
    );

    expect(painted).toEqual([
      { text: "const ", fg: "#ffffff" },
      { text: "alpha", fg: "#111111", bg: "#eeeeee" },
      { text: " = 10;", fg: "#ffffff" },
    ]);
  });

  test("resolves overlaps with the later range winning", () => {
    const spans: RenderSpan[] = [{ text: "abcdefghij" }];

    const painted = applyLineHighlightsToSpans(
      spans,
      [
        { startCol: 0, endCol: 6, tone: "match" },
        { startCol: 4, endCol: 8, tone: "current" },
      ],
      resolveBg,
    );

    expect(painted).toEqual([
      { text: "abcd", bg: "bg-match" },
      { text: "efgh", bg: "bg-current" },
      { text: "ij" },
    ]);
  });

  test("keeps the original background where the resolver declines a tone", () => {
    const spans: RenderSpan[] = [{ text: "abcdef", bg: "#101010" }];

    const painted = applyLineHighlightsToSpans(
      spans,
      [{ startCol: 0, endCol: 3, tone: "match" }],
      () => undefined,
    );

    expect(painted).toEqual([{ text: "abcdef", bg: "#101010" }]);
  });

  test("preserves zero-width spans and wide glyph boundaries", () => {
    const spans: RenderSpan[] = [{ text: "" }, { text: "x = \u{1F44D}ok" }];

    const painted = applyLineHighlightsToSpans(
      spans,
      // The emoji occupies columns 4-5; the range covers it exactly.
      [{ startCol: 4, endCol: 6, tone: "match" }],
      resolveBg,
    );

    expect(painted).toEqual([
      { text: "x = " },
      { text: "\u{1F44D}", bg: "bg-match" },
      { text: "ok" },
    ]);
  });
});
