import { describe, expect, test } from "bun:test";
import {
  normalizedReviewSourceLines,
  rebaseReviewHunk,
  reviewCanonicalHunkLine,
  reviewDefaultHunkLineTarget,
  reviewHunkIndexForLine,
  reviewHunkRange,
  reviewHunkRanges,
  reviewRangesOverlap,
} from "./geometry";

/** One hunk covering `count` rows from `start` on both sides. */
function span(start: number, count: number) {
  return {
    additionStart: start,
    additionCount: count,
    deletionStart: start,
    deletionCount: count,
  };
}

describe("reviewHunkRange", () => {
  test("spans every row the hunk header counts, context included", () => {
    // @@ -3,7 +3,7 @@ — one changed line inside six context lines.
    expect(reviewHunkRange(span(3, 7), "new")).toEqual([3, 9]);
    expect(reviewHunkRange(span(3, 7), "old")).toEqual([3, 9]);
  });

  test("gives a zero-count side the single line it is positioned at", () => {
    // @@ -6,0 +7,1 @@ — a pure insertion still has an old-side position.
    const insertion = {
      additionStart: 7,
      additionCount: 1,
      deletionStart: 6,
      deletionCount: 0,
    };

    expect(reviewHunkRange(insertion, "old")).toEqual([6, 6]);
    expect(reviewHunkRange(insertion, "new")).toEqual([7, 7]);
  });

  test("reports both sides together for callers that carry the pair", () => {
    expect(reviewHunkRanges(span(10, 2))).toEqual({ oldRange: [10, 11], newRange: [10, 11] });
  });
});

describe("reviewHunkIndexForLine", () => {
  const hunks = [span(1, 3), span(20, 1)];

  test("finds the hunk whose extent covers the line", () => {
    expect(reviewHunkIndexForLine(hunks, "new", 3)).toBe(0);
    expect(reviewHunkIndexForLine(hunks, "new", 20)).toBe(1);
  });

  test("reports no hunk for a line between or beyond them", () => {
    expect(reviewHunkIndexForLine(hunks, "new", 10)).toBe(-1);
    expect(reviewHunkIndexForLine(hunks, "old", 99)).toBe(-1);
  });
});

describe("reviewRangesOverlap", () => {
  test("treats touching endpoints as overlapping and gaps as not", () => {
    expect(reviewRangesOverlap([1, 3], [3, 5])).toBe(true);
    expect(reviewRangesOverlap([1, 3], [4, 5])).toBe(false);
  });
});

describe("reviewDefaultHunkLineTarget", () => {
  test("walks past leading context to the first added line", () => {
    const hunk = {
      ...span(10, 5),
      hunkContent: [
        { type: "context" as const, lines: 2 },
        { type: "change" as const, additions: 1, deletions: 1 },
        { type: "context" as const, lines: 2 },
      ],
    };

    expect(reviewDefaultHunkLineTarget(hunk)).toEqual({ side: "new", line: 12 });
  });

  test("prefers a later addition over an earlier deletion-only block", () => {
    const hunk = {
      ...span(20, 4),
      hunkContent: [
        { type: "change" as const, additions: 0, deletions: 1 },
        { type: "context" as const, lines: 2 },
        { type: "change" as const, additions: 1, deletions: 0 },
      ],
    };

    expect(reviewDefaultHunkLineTarget(hunk)).toEqual({ side: "new", line: 22 });
  });

  test("falls back to the first deleted line when nothing was added", () => {
    const hunk = {
      additionStart: 5,
      additionCount: 0,
      deletionStart: 6,
      deletionCount: 2,
      hunkContent: [
        { type: "context" as const, lines: 1 },
        { type: "change" as const, additions: 0, deletions: 1 },
      ],
    };

    expect(reviewDefaultHunkLineTarget(hunk)).toEqual({ side: "old", line: 7 });
  });

  test("falls back to the new-side start for a hunk with no changed rows", () => {
    const hunk = { ...span(4, 2), hunkContent: [{ type: "context" as const, lines: 2 }] };

    expect(reviewDefaultHunkLineTarget(hunk)).toEqual({ side: "new", line: 4 });
  });
});

describe("reviewCanonicalHunkLine", () => {
  test("takes the preferred side when it has rows", () => {
    expect(reviewCanonicalHunkLine(span(3, 7))).toEqual({ side: "new", line: 3 });
    expect(reviewCanonicalHunkLine(span(3, 7), "old")).toEqual({ side: "old", line: 3 });
  });

  // Intent: the case the browser prototype got wrong — every hunk reports a new-side
  // range, so choosing a side by "has a range" scrolls a deletion to a line that is not there.
  test("falls back to the backed side of a pure deletion", () => {
    const deletion = {
      additionStart: 5,
      additionCount: 0,
      deletionStart: 6,
      deletionCount: 1,
    };

    expect(reviewCanonicalHunkLine(deletion)).toEqual({ side: "old", line: 6 });
  });

  test("falls back to the backed side of a pure insertion asked for the old one", () => {
    const insertion = {
      additionStart: 7,
      additionCount: 1,
      deletionStart: 6,
      deletionCount: 0,
    };

    expect(reviewCanonicalHunkLine(insertion, "old")).toEqual({ side: "new", line: 7 });
  });

  test("reports nothing for a hunk with rows on neither side", () => {
    expect(reviewCanonicalHunkLine(span(1, 0))).toBeUndefined();
  });
});

describe("rebaseReviewHunk", () => {
  const hunk = {
    deletionLineIndex: 4,
    additionLineIndex: 4,
    hunkContent: [
      { type: "context" as const, lines: 2, deletionLineIndex: 4, additionLineIndex: 4 },
      {
        type: "change" as const,
        deletions: 1,
        additions: 2,
        deletionLineIndex: 6,
        additionLineIndex: 6,
      },
    ],
  };

  test("lays content out contiguously from the requested origins", () => {
    const rebased = rebaseReviewHunk(hunk, { deletionLineIndex: 0, additionLineIndex: 0 });

    expect(rebased.hunk.deletionLineIndex).toBe(0);
    expect(rebased.hunk.hunkContent.map((content) => content.deletionLineIndex)).toEqual([0, 2]);
    expect(rebased.hunk.hunkContent.map((content) => content.additionLineIndex)).toEqual([0, 2]);
  });

  test("reports one-past-the-end for each side so callers can slice and validate", () => {
    const rebased = rebaseReviewHunk(hunk, { deletionLineIndex: 10, additionLineIndex: 20 });

    expect(rebased.deletionEndIndex).toBe(13);
    expect(rebased.additionEndIndex).toBe(24);
  });

  test("leaves the source hunk untouched", () => {
    rebaseReviewHunk(hunk, { deletionLineIndex: 0, additionLineIndex: 0 });

    expect(hunk.hunkContent[0]?.deletionLineIndex).toBe(4);
  });
});

describe("normalizedReviewSourceLines", () => {
  test("addresses line N at index N-1 after dropping one trailing newline", () => {
    const lines = normalizedReviewSourceLines("one\ntwo\nthree\n");

    expect(lines).toEqual(["one", "two", "three"]);
  });

  test("collapses CRLF so no rendered row carries a carriage return", () => {
    expect(normalizedReviewSourceLines("one\r\ntwo\r\n")).toEqual(["one", "two"]);
  });

  test("keeps the last line of a source with no trailing newline", () => {
    expect(normalizedReviewSourceLines("one\ntwo")).toEqual(["one", "two"]);
  });

  test("keeps a deliberate blank final line, dropping only the terminator", () => {
    expect(normalizedReviewSourceLines("one\n\n")).toEqual(["one", ""]);
  });

  test("reports no lines for empty source rather than one phantom line", () => {
    expect(normalizedReviewSourceLines("")).toEqual([]);
    expect(normalizedReviewSourceLines("\n")).toEqual([]);
  });
});
