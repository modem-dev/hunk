import { describe, expect, test } from "bun:test";
import type { Hunk } from "@pierre/diffs";
import { formatHunkHeader } from "./hunkHeader";

/**
 * Minimal synthesized Hunk that forces the fallback branch of
 * `formatHunkHeader` (no parsed `hunkSpecs`). Only the numeric header fields
 * the fallback reads are populated; the rest are stubbed to satisfy the type.
 */
function fallbackHunk(overrides: Partial<Hunk> = {}): Hunk {
  return {
    collapsedBefore: 0,
    additionStart: 0,
    additionCount: 0,
    additionLines: 0,
    additionLineIndex: 0,
    deletionStart: 0,
    deletionCount: 0,
    deletionLines: 0,
    deletionLineIndex: 0,
    hunkContent: [],
    splitLineStart: 0,
    splitLineCount: 0,
    unifiedLineStart: 0,
    unifiedLineCount: 0,
    ...overrides,
  } as unknown as Hunk;
}

describe("formatHunkHeader", () => {
  test("fallback uses the per-side line count (context + changes) for the @@ ranges", () => {
    // A context-bearing hunk where git renders  @@ -10,4 +10,4 @@:
    //   old side = lines 10, 11 (context) + 12 (removed) + 13 (context) = 4
    //   new side = lines 10, 11 (context) + 13 (context) + 14 (added)   = 4
    // `*Count` is the header count (context + changes); `*Lines` is only the
    // changed `+`/`-` lines (1 each here), so they diverge — exactly the shape
    // that used to emit a malformed `@@ -10,1 +10,1 @@`.
    const hunk = fallbackHunk({
      deletionStart: 10,
      deletionCount: 4,
      deletionLines: 1,
      additionStart: 10,
      additionCount: 4,
      additionLines: 1,
    });

    const header = formatHunkHeader(hunk);

    expect(header).toBe("@@ -10,4 +10,4 @@");
    expect(header).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/);
  });

  test("fallback renders a new-file (pure-addition) hunk with a 0,0 old range", () => {
    const hunk = fallbackHunk({
      deletionStart: 0,
      deletionCount: 0,
      deletionLines: 0,
      additionStart: 1,
      additionCount: 3,
      additionLines: 3,
    });

    expect(formatHunkHeader(hunk)).toBe("@@ -0,0 +1,3 @@");
  });

  test("fallback appends hunkContext after the @@ markers when present", () => {
    const hunk = fallbackHunk({
      deletionStart: 1,
      deletionCount: 1,
      additionStart: 1,
      additionCount: 1,
      hunkContext: "function name()",
    });

    expect(formatHunkHeader(hunk)).toBe("@@ -1,1 +1,1 @@ function name()");
  });
});
