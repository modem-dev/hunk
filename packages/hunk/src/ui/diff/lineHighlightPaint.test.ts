import { describe, expect, test } from "bun:test";
import { createTestDiffFile, lines } from "../../../../../test/helpers/diff-helpers";
import { DEFAULT_TAB_WIDTH } from "../../core/run/tabWidth";
import type { ValidatedLineHighlight } from "../highlights/validate";
import { measureTextWidth } from "../lib/text";
import { expandDiffTabs } from "./codeColumns";
import {
  applyLineHighlightsToSpans,
  buildLineHighlightPaintIndex,
  lineHighlightPaintKey,
} from "./lineHighlightPaint";
import type { RenderSpan } from "./diffRows";

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

  test("preserves semantic input order when ranges start out of order", () => {
    const file = createTestDiffFile({
      before: lines("none"),
      after: lines("abcdefghij"),
    });

    const index = buildLineHighlightPaintIndex({
      file,
      marks: [mark("new", 1, 6, 8, "info"), mark("new", 1, 1, 3)],
    });

    expect(index?.get(lineHighlightPaintKey("new", 1))).toEqual([
      { startCol: 6, endCol: 8, tone: "info" },
      { startCol: 1, endCol: 3, tone: "match" },
    ]);
  });

  test("preserves interleaved old/new mark order on one mirrored context line", () => {
    const file = createTestDiffFile({
      before: lines("shared line", "old only"),
      after: lines("shared line", "new only"),
      context: 1,
    });

    const index = buildLineHighlightPaintIndex({
      file,
      marks: [
        mark("old", 1, 7, 11, "dim"),
        mark("new", 1, 0, 6, "info"),
        mark("old", 1, 3, 9, "current"),
      ],
    });

    const ranges = index?.get(lineHighlightPaintKey("new", 1));
    expect(ranges).toEqual([
      { startCol: 7, endCol: 11, tone: "dim" },
      { startCol: 0, endCol: 6, tone: "info" },
      { startCol: 3, endCol: 9, tone: "current" },
    ]);
    expect(index?.get(lineHighlightPaintKey("old", 1))).toBe(ranges!);
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

  test("defers foreground transforms until the final background is known", () => {
    const spans: RenderSpan[] = [
      { text: "const ", fg: "#c678dd" },
      { text: "alpha", fg: "#e5c07b" },
      { text: " = 10;", fg: "#abb2bf" },
    ];
    const transformFg = (fg: string | undefined, bg: string | undefined) =>
      `${fg ?? "default"}:${bg ?? "none"}`;

    const painted = applyLineHighlightsToSpans(
      spans,
      [{ startCol: 0, endCol: 17, tone: "dim" }],
      () => ({ transformFg }),
    );

    expect(painted).toEqual([
      { text: "const ", fg: "#c678dd", transformFg },
      { text: "alpha", fg: "#e5c07b", transformFg },
      { text: " = 10;", fg: "#abb2bf", transformFg },
    ]);
    expect(painted.map((span) => span.transformFg?.(span.fg, "#101010"))).toEqual([
      "#c678dd:#101010",
      "#e5c07b:#101010",
      "#abb2bf:#101010",
    ]);
  });

  test("preserves word-diff backgrounds for deferred dim transforms", () => {
    const spans: RenderSpan[] = [
      { text: "alpha", fg: "#c678dd", bg: "#204020" },
      { text: "beta", fg: "#e5c07b" },
    ];
    const transformFg = (fg: string | undefined, bg: string | undefined) =>
      `${fg ?? ""}:${bg ?? "none"}`;

    const painted = applyLineHighlightsToSpans(
      spans,
      [{ startCol: 0, endCol: 9, tone: "dim" }],
      () => ({ transformFg }),
    );

    expect(painted).toEqual([
      { text: "alpha", fg: "#c678dd", bg: "#204020", transformFg },
      { text: "beta", fg: "#e5c07b", transformFg },
    ]);
  });

  test("keeps a later current overlay above an earlier dim range", () => {
    const file = createTestDiffFile({
      before: lines("none"),
      after: lines("abcdefghijklmnopq"),
      context: 0,
    });
    const ranges = buildLineHighlightPaintIndex({
      file,
      marks: [mark("new", 1, 6, 17, "dim"), mark("new", 1, 0, 11, "current")],
    })?.get(lineHighlightPaintKey("new", 1));
    const transformFg = () => "#dimmed";

    const painted = applyLineHighlightsToSpans(
      [{ text: "abcdefghijklmnopq", fg: "#ffffff" }],
      ranges ?? [],
      (tone) => (tone === "dim" ? { transformFg } : { bg: "#eeeeee", fg: "#111111" }),
    );

    expect(painted).toEqual([
      { text: "abcdefghijk", fg: "#111111", bg: "#eeeeee" },
      { text: "lmnopq", fg: "#ffffff", transformFg },
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

  test("resolves a dense overlapping range set once per line, not once per piece", () => {
    // 10,000 overlapping ranges on one wide-glyph line: painting used to cost
    // work proportional to ranges × spans × pieces, which measured ~750ms for
    // this row. The bound is loose enough to survive a slow CI box and tight
    // enough that only near-linear resolution can meet it.
    const text = "\u65E5".repeat(5_000);
    const spans: RenderSpan[] = [{ text, fg: "#ffffff" }];
    const width = measureTextWidth(text);
    const ranges = Array.from({ length: 10_000 }, (_, index) => {
      const startCol = (index * 7_919) % (width - 12);
      return { startCol, endCol: startCol + 1 + (index % 11), tone: "match" as const };
    });

    const started = performance.now();
    const painted = applyLineHighlightsToSpans(spans, ranges, resolveBg);
    const elapsed = performance.now() - started;

    expect(painted.map((span) => span.text).join("")).toBe(text);
    expect(elapsed).toBeLessThan(150);
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

describe("paint geometry neutrality", () => {
  // The one contract everything upstream relies on: applying highlights can
  // recolor spans but never change the rendered width of a line. A column cut
  // landing *inside* a wide glyph would slice it into a dropped half and a pad
  // space, silently costing the row one column — so this pins the composed
  // guarantee that `markToColRange`'s cluster snapping only ever produces cuts
  // on glyph boundaries, exhaustively over hostile offsets on hostile text.
  const HOSTILE_LINES = [
    // CJK identifiers and full-width punctuation around ASCII.
    "const \u540D\u524D = '\u65E5\u672C\u8A9E\u30C6\u30AD\u30B9\u30C8'; // \u{1F389} emoji",
    // Combining accent, ZWJ emoji sequence, surrogate pairs.
    "e\u0301combining + \u{1F469}\u200D\u{1F4BB} zwj \u{1F44D}",
    // Tabs interleaved with wide glyphs so expansion shifts columns too.
    "\tif (\u5024 === \u771F) {\treturn \u7D50\u679C;\t}",
  ] as const;

  test("arbitrary column cuts never change rendered width at the paint layer", () => {
    // Direct contract on `applyLineHighlightsToSpans` with RAW column ranges,
    // including cuts landing inside wide glyphs — the guard must snap them
    // away rather than slicing a glyph into a dropped half and a pad space.
    for (const line of HOSTILE_LINES) {
      const text = expandDiffTabs(line, DEFAULT_TAB_WIDTH);
      const spans: RenderSpan[] = [{ text, fg: "#ffffff" }];
      const width = measureTextWidth(text);

      for (let startCol = 0; startCol < width; startCol += 1) {
        for (let endCol = startCol + 1; endCol <= width; endCol += 1) {
          const painted = applyLineHighlightsToSpans(
            spans,
            [{ startCol, endCol, tone: "match" }],
            (tone) => ({ bg: `bg-${tone}` }),
          );
          const paintedText = painted.map((span) => span.text).join("");
          if (measureTextWidth(paintedText) !== width) {
            throw new Error(
              `width ${width} -> ${measureTextWidth(paintedText)} at cols [${startCol}, ${endCol})`,
            );
          }
          expect(paintedText).toBe(text);
        }
      }
    }
  });

  test("marks never change a line's rendered width, at every offset pair", () => {
    for (const [lineIndex, line] of HOSTILE_LINES.entries()) {
      const file = createTestDiffFile({
        before: lines("placeholder"),
        after: lines(line),
        id: `hostile-${lineIndex}`,
        path: `hostile-${lineIndex}.ts`,
      });
      const spans: RenderSpan[] = [
        { text: expandDiffTabs(line, DEFAULT_TAB_WIDTH), fg: "#ffffff" },
      ];
      const originalWidth = measureTextWidth(spans[0]!.text);

      // Every [start, end) code-unit pair, including mid-surrogate, mid-ZWJ,
      // and mid-combining offsets an extension could plausibly emit.
      for (let start = 0; start < line.length; start += 1) {
        for (let end = start + 1; end <= line.length; end += 1) {
          const index = buildLineHighlightPaintIndex({
            file,
            marks: [mark("new", 1, start, end)],
          });
          const ranges = index?.get(lineHighlightPaintKey("new", 1));
          if (!ranges) continue;

          const painted = applyLineHighlightsToSpans(spans, ranges, (tone) => ({
            bg: `bg-${tone}`,
          }));
          const paintedWidth = measureTextWidth(painted.map((span) => span.text).join(""));
          if (paintedWidth !== originalWidth) {
            throw new Error(
              `width ${originalWidth} -> ${paintedWidth} for offsets [${start}, ${end}) on line ${lineIndex}`,
            );
          }
          // Text content itself must also survive byte-for-byte.
          expect(painted.map((span) => span.text).join("")).toBe(spans[0]!.text);
        }
      }
    }
  });
});
