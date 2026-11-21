import { describe, expect, test } from "bun:test";
import { projectReviewDocument } from "../../core/review/document";
import { createTestDiffFile } from "../../../../../test/helpers/diff-helpers";
import { planReviewFileRender } from "./fileProjection";
import { reviewGapRowRange, reviewHunkAtRow, reviewHunkRowRange } from "./hunkGeometry";

const BEFORE = Array.from({ length: 40 }, (_unused, index) => `const v${index} = ${index};`);
const AFTER = BEFORE.map((line, index) =>
  index === 10 ? "const v10 = 1000;" : index === 30 ? "const v30 = 3000;" : line,
);

/** One file with two hunks, a leading gap, a gap between them, and a trailing gap. */
function createTestTwoHunkFile() {
  return projectReviewDocument(
    [
      createTestDiffFile({
        id: "two",
        path: "two.ts",
        before: `${BEFORE.join("\n")}\n`,
        after: `${AFTER.join("\n")}\n`,
        context: 2,
      }),
    ],
    { sourceLabel: "/test" },
  ).files[0]!;
}

describe("hunk row ranges", () => {
  test("reads each hunk's rows from the shared model, per layout", () => {
    const file = createTestTwoHunkFile();
    // Context 2 around line 11 and line 31: rows 8-13 hold the first hunk (unified counts
    // the changed line twice), and the second starts at line 29.
    expect(reviewHunkRowRange(file, 0, "unified")).toEqual({ start: 8, end: 14 });
    expect(reviewHunkRowRange(file, 0, "split")).toEqual({ start: 8, end: 13 });
    expect(reviewHunkRowRange(file, 1, "split")).toEqual({ start: 28, end: 33 });
    expect(reviewHunkRowRange(file, 2, "split")).toBeUndefined();
  });

  test("finds the hunk owning a row, and none for gap rows", () => {
    const file = createTestTwoHunkFile();
    expect(reviewHunkAtRow(file, "split", 8)).toBe(0);
    expect(reviewHunkAtRow(file, "split", 12)).toBe(0);
    expect(reviewHunkAtRow(file, "split", 20)).toBeUndefined();
    expect(reviewHunkAtRow(file, "split", 30)).toBe(1);
  });

  test("places an expanded gap's rows beside the hunk it abuts", () => {
    const file = createTestTwoHunkFile();
    const plan = planReviewFileRender(file, { expandedGaps: [], sourceStatusByFileKey: {} });
    const [leading, between, trailing] = plan.gaps;
    expect(reviewGapRowRange(file, leading!, "split")).toEqual({ start: 0, end: 8 });
    expect(reviewGapRowRange(file, between!, "split")).toEqual({ start: 13, end: 28 });
    expect(reviewGapRowRange(file, trailing!, "split")).toEqual({ start: 33, end: 40 });
  });
});
