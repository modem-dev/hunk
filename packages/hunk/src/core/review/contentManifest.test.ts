import { describe, expect, test } from "bun:test";
import { createTestDiffFile, lines } from "../../../../../test/helpers/diff-helpers";
import { buildReviewContentManifest } from "./contentManifest";
import { projectReviewDocument } from "./document";

/** A twelve-line file with one changed line in the middle, parsed without context. */
function testDocument() {
  const before = Array.from({ length: 12 }, (_unused, index) => `line ${index + 1}`);
  const after = [...before];
  after[5] = "line six";
  return projectReviewDocument([
    createTestDiffFile({
      before: lines(...before),
      after: lines(...after),
      context: 0,
      id: "alpha",
      path: "alpha.ts",
    }),
  ]);
}

describe("buildReviewContentManifest", () => {
  test("is identical for two projections of the same content", () => {
    expect(buildReviewContentManifest(testDocument())).toEqual(
      buildReviewContentManifest(testDocument()),
    );
  });

  test("records the geometry a renderer would otherwise re-derive", () => {
    const file = buildReviewContentManifest(testDocument()).files[0]!;

    expect(file.expansionSide).toBe("new");
    expect(file.hunks[0]).toMatchObject({
      index: 0,
      oldRange: [6, 6],
      newRange: [6, 6],
      defaultNoteTarget: { side: "new", line: 6 },
      leadingGap: { gapId: "before:0", oldRange: [1, 5], newRange: [1, 5], lineCount: 5 },
    });
    expect(file.trailingGap).toEqual({
      gapId: "trailing:0",
      oldRange: [7, 12],
      newRange: [7, 12],
      lineCount: 6,
    });
  });

  test("omits renderer identity so two consumers can be compared at all", () => {
    const file = buildReviewContentManifest(testDocument()).files[0]!;

    expect(file).not.toHaveProperty("runtimeId");
  });

  test("explains a file that renders nothing, and stays silent about one that does not", () => {
    const empty = projectReviewDocument([
      createTestDiffFile({ before: "same\n", after: "same\n", id: "same", path: "same.ts" }),
    ]);

    expect(buildReviewContentManifest(empty).files[0]?.emptyDiffReason).toBe("no-hunks");
    expect(buildReviewContentManifest(testDocument()).files[0]?.emptyDiffReason).toBeUndefined();
  });
});
