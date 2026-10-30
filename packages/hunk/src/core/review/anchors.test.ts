import { describe, expect, test } from "bun:test";
import { resolveReviewNoteAnchor, reviewGapOwnerHunkIndex, reviewLineAnchor } from "./anchors";
import type { ReviewHunkSpan } from "./geometry";

/** Three well-separated hunks, each spanning three rows on both sides. */
const hunks: ReviewHunkSpan[] = [
  { additionStart: 1, additionCount: 3, deletionStart: 1, deletionCount: 3 },
  { additionStart: 20, additionCount: 3, deletionStart: 20, deletionCount: 3 },
  { additionStart: 40, additionCount: 3, deletionStart: 40, deletionCount: 3 },
];

describe("resolveReviewNoteAnchor", () => {
  test("lists every hunk a range touches, in file order", () => {
    const anchor = resolveReviewNoteAnchor(hunks, { newRange: [2, 41] });

    expect(anchor.intersectingHunkIndices).toEqual([0, 1, 2]);
    expect(anchor.ownerHunkIndex).toBe(0);
  });

  test("lets the preferred line decide ownership over a wider range", () => {
    const anchor = resolveReviewNoteAnchor(hunks, {
      newRange: [2, 41],
      preferred: { side: "new", line: 40 },
    });

    expect(anchor.ownerHunkIndex).toBe(2);
  });

  test("owns a note by its declared fallback when nothing intersects", () => {
    // An expanded-gap line: real to the reviewer, outside every compact hunk extent.
    const anchor = resolveReviewNoteAnchor(hunks, {
      newRange: [10, 10],
      preferred: { side: "new", line: 10 },
      fallbackOwnerHunkIndex: 1,
    });

    expect(anchor.intersectingHunkIndices).toEqual([]);
    expect(anchor.ownerHunkIndex).toBe(1);
  });

  test("falls back to the first hunk when the declared fallback does not exist", () => {
    const anchor = resolveReviewNoteAnchor(hunks, {
      newRange: [10, 10],
      fallbackOwnerHunkIndex: 99,
    });

    expect(anchor.ownerHunkIndex).toBe(0);
  });

  test("owns nothing in a file with no hunks", () => {
    expect(resolveReviewNoteAnchor([], { newRange: [1, 1] })).toEqual({
      newRange: [1, 1],
      intersectingHunkIndices: [],
    });
  });

  test("copies the ranges it was given so the caller cannot mutate the anchor", () => {
    const newRange: [number, number] = [2, 2];
    const anchor = resolveReviewNoteAnchor(hunks, { newRange });
    newRange[1] = 99;

    expect(anchor.newRange).toEqual([2, 2]);
  });

  test("matches an old-side range against old-side extents only", () => {
    const anchor = resolveReviewNoteAnchor(hunks, { oldRange: [21, 21] });

    expect(anchor.intersectingHunkIndices).toEqual([1]);
  });
});

describe("reviewGapOwnerHunkIndex", () => {
  test("hands a gap line to the hunk it leads into", () => {
    expect(reviewGapOwnerHunkIndex(hunks, "new", 10)).toBe(1);
    expect(reviewGapOwnerHunkIndex(hunks, "new", 30)).toBe(2);
  });

  test("hands a line after the last hunk to that hunk's trailing gap", () => {
    expect(reviewGapOwnerHunkIndex(hunks, "new", 500)).toBe(2);
  });

  test("hands a line before the first hunk to that hunk's leading gap", () => {
    expect(
      reviewGapOwnerHunkIndex(
        [{ additionStart: 5, additionCount: 2, deletionStart: 5, deletionCount: 2 }],
        "new",
        1,
      ),
    ).toBe(0);
  });

  test("owns nothing in a file with no hunks", () => {
    expect(reviewGapOwnerHunkIndex([], "new", 1)).toBeUndefined();
  });

  test("reads the side it was asked about", () => {
    const shifted: ReviewHunkSpan[] = [
      { additionStart: 1, additionCount: 1, deletionStart: 1, deletionCount: 1 },
      { additionStart: 30, additionCount: 1, deletionStart: 10, deletionCount: 1 },
    ];

    expect(reviewGapOwnerHunkIndex(shifted, "new", 20)).toBe(1);
    expect(reviewGapOwnerHunkIndex(shifted, "old", 20)).toBe(1);
    expect(reviewGapOwnerHunkIndex(shifted, "old", 5)).toBe(1);
  });
});

describe("reviewLineAnchor", () => {
  test("anchors one line to the hunk that contains it", () => {
    expect(reviewLineAnchor(hunks, { hunkIndex: 1, side: "new", line: 21 })).toEqual({
      newRange: [21, 21],
      preferred: { side: "new", line: 21 },
      intersectingHunkIndices: [1],
      ownerHunkIndex: 1,
    });
  });

  test("keeps a note on an expanded-gap line attached to the hunk it was written at", () => {
    const anchor = reviewLineAnchor(hunks, { hunkIndex: 2, side: "new", line: 30 });

    expect(anchor.intersectingHunkIndices).toEqual([]);
    expect(anchor.ownerHunkIndex).toBe(2);
  });

  test("puts an old-side line on the old range only", () => {
    const anchor = reviewLineAnchor(hunks, { hunkIndex: 0, side: "old", line: 2 });

    expect(anchor.oldRange).toEqual([2, 2]);
    expect(anchor.newRange).toBeUndefined();
  });
});
