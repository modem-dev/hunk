import { describe, expect, test } from "bun:test";
import { reviewHunkIndexAtOffset, type ReviewHunkVerticalBounds } from "./viewportAnchor";

/** Look up bounds from a list, as a caller with measured hunks would. */
function boundsFromTestList(list: (ReviewHunkVerticalBounds | undefined)[]) {
  return (index: number) => list[index];
}

describe("reviewHunkIndexAtOffset", () => {
  const hunks = boundsFromTestList([
    { top: 0, height: 10 },
    { top: 20, height: 10 },
    { top: 40, height: 10 },
  ]);

  test("returns the hunk containing the offset, bottom edge inclusive of its last unit", () => {
    expect(reviewHunkIndexAtOffset(3, hunks, 5)).toBe(0);
    expect(reviewHunkIndexAtOffset(3, hunks, 29)).toBe(1);
    expect(reviewHunkIndexAtOffset(3, hunks, 40)).toBe(2);
  });

  test("returns the nearest hunk between hunks, the later one on a tie", () => {
    expect(reviewHunkIndexAtOffset(3, hunks, 11)).toBe(0);
    expect(reviewHunkIndexAtOffset(3, hunks, 18)).toBe(1);
    // 9 is the last unit of hunk 0 and 20 the first of hunk 1: 14.5 is equidistant.
    expect(reviewHunkIndexAtOffset(3, hunks, 14.5)).toBe(1);
    expect(reviewHunkIndexAtOffset(3, hunks, 500)).toBe(2);
  });

  test("skips unmeasured hunks and falls back to the first hunk", () => {
    expect(
      reviewHunkIndexAtOffset(3, boundsFromTestList([undefined, { top: 20, height: 5 }]), 0),
    ).toBe(1);
    expect(reviewHunkIndexAtOffset(3, () => undefined, 10)).toBe(0);
    expect(reviewHunkIndexAtOffset(0, hunks, 10)).toBe(0);
  });
});
