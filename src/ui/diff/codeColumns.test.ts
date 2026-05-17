import { describe, expect, test } from "bun:test";
import type { DiffFile } from "../../core/types";
import { maxFileCodeLineWidth, measureRenderedCodeLineWidth } from "./codeColumns";

/** Generate a large diff metadata fixture without checking a huge file into the repo. */
function createLargeLineFixture(lineCount: number, widestLine: string): DiffFile {
  const additionLines = Array.from({ length: lineCount }, (_, index) =>
    index === lineCount - 1 ? widestLine : "x",
  );

  return {
    agent: null,
    id: "large-untracked",
    metadata: {
      additionLines,
      deletionLines: [],
      hunks: [],
    } as unknown as DiffFile["metadata"],
    patch: "",
    path: "large-untracked.txt",
    stats: { additions: lineCount, deletions: 0 },
  };
}

describe("code column measurement", () => {
  test("measures large generated fixtures without overflowing the call stack", () => {
    const file = createLargeLineFixture(100_000, "the widest generated line");

    expect(maxFileCodeLineWidth(file)).toBe("the widest generated line".length);
  });

  test("counts CJK characters as two display columns each (GH-324)", () => {
    // "console.log('你好世界')" — 15 ASCII cols + 4 CJK graphemes (8 cols) = 23 cols.
    expect(measureRenderedCodeLineWidth("console.log('你好世界')")).toBe(23);
  });

  test("CJK-only lines drive max width by display columns, not code units", () => {
    const cjkLine = "你好世界";
    const asciiLine = "abcde";
    const file: DiffFile = {
      agent: null,
      id: "cjk-fixture",
      metadata: {
        additionLines: [cjkLine],
        deletionLines: [asciiLine],
        hunks: [],
      } as unknown as DiffFile["metadata"],
      patch: "",
      path: "cjk.txt",
      stats: { additions: 1, deletions: 1 },
    };

    // 4 CJK chars = 8 columns, which is wider than the 5-col ASCII line.
    expect(maxFileCodeLineWidth(file)).toBe(8);
  });
});
