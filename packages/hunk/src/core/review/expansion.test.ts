import { describe, expect, test } from "bun:test";
import { createTestReviewFile } from "../../../../../test/helpers/review-store-helpers";
import {
  parseReviewGapId,
  resolveReviewExpandedLine,
  reviewExpansionSide,
  reviewGapAddress,
  reviewGapId,
  reviewLeadingGap,
  reviewTrailingGap,
  type ReviewGapHunk,
  type ReviewGapSource,
} from "./expansion";

/** Build one hunk the way a parser reports it: line indices are `start - 1`. */
function hunk(input: {
  collapsedBefore: number;
  additionStart: number;
  additionCount: number;
  deletionStart: number;
  deletionCount: number;
}): ReviewGapHunk {
  return {
    ...input,
    additionLineIndex: input.additionStart - 1,
    deletionLineIndex: input.deletionStart - 1,
  };
}

/** Build one gap source with per-side line totals stated as counts. */
function source(hunks: ReviewGapHunk[], totals: { old: number; new: number }): ReviewGapSource {
  return {
    hunks,
    deletionLines: Array.from({ length: totals.old }, (_unused, index) => `old ${index + 1}`),
    additionLines: Array.from({ length: totals.new }, (_unused, index) => `new ${index + 1}`),
    isPartial: false,
  };
}

describe("gap ids", () => {
  test("round-trips a position and hunk index", () => {
    expect(reviewGapId("before", 3)).toBe("before:3");
    expect(parseReviewGapId("trailing:0")).toEqual({ position: "trailing", hunkIndex: 0 });
  });

  test("rejects anything that is not a gap address", () => {
    for (const id of ["", "before", "before:", "before:-1", "middle:1", "before:1:2"]) {
      expect(parseReviewGapId(id)).toBeUndefined();
    }
  });
});

describe("reviewLeadingGap", () => {
  test("ends one line before a hunk that has rows on both sides", () => {
    // @@ -6,1 +6,1 @@ with five omitted lines before it.
    const file = source(
      [
        hunk({
          collapsedBefore: 5,
          additionStart: 6,
          additionCount: 1,
          deletionStart: 6,
          deletionCount: 1,
        }),
      ],
      { old: 12, new: 12 },
    );

    expect(reviewLeadingGap(file, 0)).toEqual({
      position: "before",
      hunkIndex: 0,
      oldRange: [1, 5],
      newRange: [1, 5],
      lineCount: 5,
    });
  });

  test("ends at the positioned line on the old side of a pure insertion", () => {
    // @@ -6,0 +7,1 @@ — old lines 1-6 all precede the insertion point, so the gap ends
    // at old line 6 rather than at 5. Ending one line early is the off-by-one the
    // terminal's own copy carried (audit A1).
    const file = source(
      [
        hunk({
          collapsedBefore: 6,
          additionStart: 7,
          additionCount: 1,
          deletionStart: 6,
          deletionCount: 0,
        }),
      ],
      { old: 12, new: 13 },
    );

    expect(reviewLeadingGap(file, 0)).toEqual({
      position: "before",
      hunkIndex: 0,
      oldRange: [1, 6],
      newRange: [1, 6],
      lineCount: 6,
    });
  });

  test("ends at the positioned line on the new side of a pure deletion", () => {
    // @@ -3,1 +2,0 @@ — new line 2 is the last unchanged line before the deletion.
    const file = source(
      [
        hunk({
          collapsedBefore: 1,
          additionStart: 2,
          additionCount: 0,
          deletionStart: 3,
          deletionCount: 1,
        }),
      ],
      { old: 12, new: 11 },
    );

    expect(reviewLeadingGap(file, 0)?.newRange).toEqual([2, 2]);
    expect(reviewLeadingGap(file, 0)?.oldRange).toEqual([2, 2]);
  });

  test("has no address when the patch omitted nothing before the hunk", () => {
    const file = source(
      [
        hunk({
          collapsedBefore: 0,
          additionStart: 1,
          additionCount: 1,
          deletionStart: 1,
          deletionCount: 1,
        }),
      ],
      { old: 3, new: 3 },
    );

    expect(reviewLeadingGap(file, 0)).toBeUndefined();
  });

  test("has no address when the gap would start outside the file", () => {
    const file = source(
      [
        hunk({
          collapsedBefore: 9,
          additionStart: 3,
          additionCount: 1,
          deletionStart: 3,
          deletionCount: 1,
        }),
      ],
      { old: 12, new: 12 },
    );

    expect(reviewLeadingGap(file, 0)).toBeUndefined();
  });
});

describe("reviewTrailingGap", () => {
  test("covers what each side has left after the last hunk", () => {
    const file = source(
      [
        hunk({
          collapsedBefore: 9,
          additionStart: 10,
          additionCount: 1,
          deletionStart: 10,
          deletionCount: 1,
        }),
      ],
      { old: 12, new: 12 },
    );

    expect(reviewTrailingGap(file)).toEqual({
      position: "trailing",
      hunkIndex: 0,
      oldRange: [11, 12],
      newRange: [11, 12],
      lineCount: 2,
    });
  });

  test("has no address when the last hunk reaches the end of the file", () => {
    const file = source(
      [
        hunk({
          collapsedBefore: 11,
          additionStart: 12,
          additionCount: 1,
          deletionStart: 12,
          deletionCount: 1,
        }),
      ],
      { old: 12, new: 12 },
    );

    expect(reviewTrailingGap(file)).toBeUndefined();
  });

  test("has no address when the two sides' tails disagree", () => {
    // A last hunk with a zero-count side leaves tails of different lengths; the gap
    // renders as paired rows, so an unequal pair is no gap at all (audit A2).
    const file = source(
      [
        hunk({
          collapsedBefore: 6,
          additionStart: 7,
          additionCount: 1,
          deletionStart: 6,
          deletionCount: 0,
        }),
      ],
      { old: 12, new: 13 },
    );

    expect(reviewTrailingGap(file)).toBeUndefined();
  });

  test("has no address for a partial patch, which has no line totals", () => {
    const file = {
      ...source(
        [
          hunk({
            collapsedBefore: 9,
            additionStart: 10,
            additionCount: 1,
            deletionStart: 10,
            deletionCount: 1,
          }),
        ],
        { old: 12, new: 12 },
      ),
      isPartial: true,
    };

    expect(reviewTrailingGap(file)).toBeUndefined();
  });
});

describe("reviewGapAddress", () => {
  const file = source(
    [
      hunk({
        collapsedBefore: 2,
        additionStart: 3,
        additionCount: 1,
        deletionStart: 3,
        deletionCount: 1,
      }),
      hunk({
        collapsedBefore: 5,
        additionStart: 9,
        additionCount: 1,
        deletionStart: 9,
        deletionCount: 1,
      }),
    ],
    { old: 12, new: 12 },
  );

  test("resolves both positions by id", () => {
    expect(reviewGapAddress(file, "before:1")?.oldRange).toEqual([4, 8]);
    expect(reviewGapAddress(file, "trailing:1")?.oldRange).toEqual([10, 12]);
  });

  test("rejects a trailing id that names a hunk other than the last", () => {
    expect(reviewGapAddress(file, "trailing:0")).toBeUndefined();
  });

  test("rejects an id addressing a hunk that does not exist", () => {
    expect(reviewGapAddress(file, "before:9")).toBeUndefined();
    expect(reviewGapAddress(file, "nonsense")).toBeUndefined();
  });
});

describe("reviewExpansionSide", () => {
  test("reads a deleted file's gaps from the old side and everything else from the new", () => {
    expect(reviewExpansionSide("deleted")).toBe("old");
    for (const kind of ["change", "new", "rename-pure", "rename-changed"] as const) {
      expect(reviewExpansionSide(kind)).toBe("new");
    }
  });
});

describe("resolveReviewExpandedLine", () => {
  const file = createTestReviewFile({ key: "alpha", sourceIdentity: "src:1" });
  const claim = { gapId: "before:1", side: "new" as const, line: 5, sourceIdentity: "src:1" };

  // Intent: a line the patch never showed is addressable exactly while its gap is.
  test("accepts a line inside the gap it names", () => {
    expect(resolveReviewExpandedLine(file, claim)?.hunkIndex).toBe(1);
    // The gap covers lines 2..10 on both sides; its ends are inside it.
    expect(resolveReviewExpandedLine(file, { ...claim, line: 2 })).toBeDefined();
    expect(resolveReviewExpandedLine(file, { ...claim, line: 10 })).toBeDefined();
  });

  test("rejects a line outside the gap it names", () => {
    expect(resolveReviewExpandedLine(file, { ...claim, line: 1 })).toBeUndefined();
    expect(resolveReviewExpandedLine(file, { ...claim, line: 11 })).toBeUndefined();
  });

  test("rejects a gap the file does not have", () => {
    expect(resolveReviewExpandedLine(file, { ...claim, gapId: "before:0" })).toBeUndefined();
    expect(resolveReviewExpandedLine(file, { ...claim, gapId: "nonsense" })).toBeUndefined();
  });

  // Intent: the same gap over replaced source text is a different set of lines, so a claim
  // about the old content must not resolve against the new.
  test("rejects a claim about source the file no longer has", () => {
    expect(resolveReviewExpandedLine(file, { ...claim, sourceIdentity: "src:2" })).toBeUndefined();
    expect(
      resolveReviewExpandedLine(createTestReviewFile({ key: "alpha" }), claim),
    ).toBeUndefined();
  });
});
