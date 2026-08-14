import { describe, expect, test } from "bun:test";
import { mergeLineHighlightMaps } from "./merge";
import type { ValidatedLineHighlight } from "./validate";

function mark(line: number, start: number, end: number): ValidatedLineHighlight {
  return { side: "new", line, start, end, tone: "match" };
}

describe("mergeLineHighlightMaps", () => {
  test("returns either side unchanged when the other is empty, preserving identity", () => {
    const base = new Map([["file-1", [mark(1, 0, 4)]]]);
    const empty = new Map<string, readonly ValidatedLineHighlight[]>();

    expect(mergeLineHighlightMaps(base, empty)).toBe(base);
    expect(mergeLineHighlightMaps(empty, base)).toBe(base);
  });

  test("appends overlay marks after base marks so the overlay paints last", () => {
    const base = new Map([["file-1", [mark(1, 0, 4)]]]);
    const overlay = new Map([
      ["file-1", [mark(1, 2, 6)]],
      ["file-2", [mark(3, 0, 2)]],
    ]);

    const merged = mergeLineHighlightMaps(base, overlay);
    expect(merged.get("file-1")).toEqual([mark(1, 0, 4), mark(1, 2, 6)]);
    expect(merged.get("file-2")).toEqual([mark(3, 0, 2)]);
    // Neither input map is mutated by the merge.
    expect(base.get("file-1")).toHaveLength(1);
    expect(overlay.get("file-1")).toHaveLength(1);
  });
});
