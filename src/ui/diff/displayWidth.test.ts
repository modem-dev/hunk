import { describe, expect, test } from "bun:test";
import { displayWidth, sliceByDisplayWidth, wrapByDisplayWidth } from "./displayWidth";

describe("displayWidth()", () => {
  test("ASCII chars are 1 column each", () => {
    expect(displayWidth("hello")).toBe(5);
  });

  test("CJK chars are 2 columns each", () => {
    expect(displayWidth("你好")).toBe(4);
    expect(displayWidth("日本語")).toBe(6);
    expect(displayWidth("한국어")).toBe(6);
  });

  test("mixed CJK + ASCII reports the actual cell footprint", () => {
    // Same string the bug report would render side-by-side.
    expect(displayWidth("a你b好c")).toBe(7);
  });

  test("fullwidth punctuation counts as 2 columns", () => {
    expect(displayWidth("！？")).toBe(4);
  });
});

describe("sliceByDisplayWidth()", () => {
  test("non-positive width returns empty slice", () => {
    const slice = sliceByDisplayWidth("hello", 0, 0);
    expect(slice).toEqual({ text: "", consumedColumns: 0, leadingSkip: 0, trailingDropped: 0 });
  });

  test("ASCII slice matches code-unit slice exactly", () => {
    const slice = sliceByDisplayWidth("hello world", 0, 5);
    expect(slice.text).toBe("hello");
    expect(slice.consumedColumns).toBe(5);
  });

  test("CJK slice keeps whole graphemes inside the window", () => {
    const slice = sliceByDisplayWidth("你好世界", 0, 4);
    expect(slice.text).toBe("你好");
    expect(slice.consumedColumns).toBe(4);
    expect(slice.trailingDropped).toBe(0);
  });

  test("CJK slice drops a wide grapheme that would overflow the right edge", () => {
    // Window width 3, but "你" is 2 cols and the next char "好" would overflow.
    const slice = sliceByDisplayWidth("你好", 0, 3);
    expect(slice.text).toBe("你");
    expect(slice.consumedColumns).toBe(2);
    expect(slice.trailingDropped).toBe(1);
  });

  test("scrolling offset of full width skips the left grapheme cleanly", () => {
    const slice = sliceByDisplayWidth("你好", 2, 2);
    expect(slice.text).toBe("好");
    expect(slice.consumedColumns).toBe(2);
    expect(slice.leadingSkip).toBe(2);
  });

  test("scrolling offset that straddles a wide grapheme drops it and reports the boundary", () => {
    // Scroll position 1 lands mid-"你"; we drop "你" and align to col 1,
    // so caller can pad one space before "好".
    const slice = sliceByDisplayWidth("你好", 1, 4);
    expect(slice.text).toBe("好");
    expect(slice.consumedColumns).toBe(2);
    expect(slice.leadingSkip).toBe(1);
  });

  test("mixed ASCII + CJK keeps both together when they fit", () => {
    const slice = sliceByDisplayWidth("ab你好cd", 0, 6);
    expect(slice.text).toBe("ab你好");
    expect(slice.consumedColumns).toBe(6);
  });
});

describe("wrapByDisplayWidth()", () => {
  test("empty input yields one empty row", () => {
    expect(wrapByDisplayWidth("", 10)).toEqual([{ text: "", columns: 0 }]);
  });

  test("non-positive width returns a single empty row", () => {
    expect(wrapByDisplayWidth("hello", 0)).toEqual([{ text: "", columns: 0 }]);
  });

  test("wraps ASCII at exact code-unit boundaries", () => {
    expect(wrapByDisplayWidth("abcdef", 3)).toEqual([
      { text: "abc", columns: 3 },
      { text: "def", columns: 3 },
    ]);
  });

  test("breaks before a wide grapheme rather than splitting it", () => {
    // Width 3, "你" (2 cols) would overflow after "ab" (2 cols).
    expect(wrapByDisplayWidth("ab你好", 3)).toEqual([
      { text: "ab", columns: 2 },
      { text: "你", columns: 2 },
      { text: "好", columns: 2 },
    ]);
  });

  test("wraps pure CJK so every row's display columns stay <= width", () => {
    const rows = wrapByDisplayWidth("你好世界", 4);
    expect(rows).toEqual([
      { text: "你好", columns: 4 },
      { text: "世界", columns: 4 },
    ]);
  });

  test("places a too-wide grapheme alone on its own row instead of dropping it", () => {
    // width=1 can't fit any 2-col grapheme cleanly; matches the prior
    // code-unit behavior of letting it render past the cell.
    const rows = wrapByDisplayWidth("你好", 1);
    expect(rows.map((r) => r.text)).toEqual(["你", "好"]);
  });
});
