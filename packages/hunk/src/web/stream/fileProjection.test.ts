import { describe, expect, test } from "bun:test";
import { projectReviewDocument } from "../../core/review/document";
import type { ReviewSourceStatus } from "../../core/review/state";
import { createTestDiffFile } from "../../../../../test/helpers/diff-helpers";
import { reviewHunkRowFractions } from "../../core/review/geometry";
import { planReviewFileRender, reviewDrawnRows, reviewGapIdForSeparator } from "./fileProjection";

const BEFORE = Array.from({ length: 40 }, (_unused, index) => `const v${index} = ${index};`);
const AFTER = BEFORE.map((line, index) => (index === 20 ? "const v20 = 2000;" : line));

/** One file with a leading and a trailing gap. */
function createTestGapFile() {
  return projectReviewDocument(
    [
      createTestDiffFile({
        id: "gaps",
        path: "gaps.ts",
        before: `${BEFORE.join("\n")}\n`,
        after: `${AFTER.join("\n")}\n`,
        context: 2,
      }),
    ],
    { sourceLabel: "/test" },
  ).files[0]!;
}

/** Plan with the leading gap expanded and the given source status. */
function planWith(status: ReviewSourceStatus | undefined) {
  const file = createTestGapFile();
  return planReviewFileRender(file, {
    expandedGaps: [{ fileKey: file.key, gapId: "before:0", expanded: true }],
    sourceStatusByFileKey: status ? { [file.key]: status } : {},
  });
}

describe("planReviewFileRender", () => {
  test("lists every gap with its state and reserves rows without the folded lines", () => {
    const file = createTestGapFile();
    const plan = planReviewFileRender(file, { expandedGaps: [], sourceStatusByFileKey: {} });

    expect(plan.gaps.map((gap) => [gap.gapId, gap.state])).toEqual([
      ["before:0", "collapsed"],
      ["trailing:0", "collapsed"],
    ]);
    const folded = plan.gaps.reduce((rows, gap) => rows + gap.address.lineCount - 1, 0);
    expect(plan.reservedRows.split).toBe(file.splitLineCount - folded);
    expect(plan.metadata?.hunks[0]?.collapsedBefore).toBe(file.hunks[0]!.collapsedBefore);
  });

  test("reports loading, failure, and too-large from the shared source status", () => {
    expect(planWith(undefined).gaps[0]!.state).toBe("loading");
    expect(planWith({ kind: "loading" }).gaps[0]!.state).toBe("loading");
    expect(planWith({ kind: "error" }).gaps[0]!.state).toBe("error");
    expect(planWith({ kind: "error", reason: "too-large" }).gaps[0]!.state).toBe("too-large");
  });

  // Intent: Pierre skips a re-render when the cache key repeats, so a filled gap must change it.
  test("folds a loaded gap into the hunk and changes the cache key", () => {
    const collapsed = planWith({ kind: "error" });
    const expanded = planWith({ kind: "loaded", text: `${AFTER.join("\n")}\n` });

    expect(expanded.gaps[0]!.state).toBe("expanded");
    expect(expanded.metadata?.hunks[0]?.collapsedBefore).toBe(0);
    expect(expanded.metadata?.hunks[0]?.additionStart).toBe(1);
    expect(expanded.metadata?.cacheKey).not.toBe(collapsed.metadata?.cacheKey);
  });

  // Intent: an overview places hunks by the rows the stream draws; a collapsed gap draws one
  // separator row, so the hunk after it sits that much higher than the model's rows say, and
  // an expanded gap puts it back.
  test("places hunks at the rows drawn, following a gap's expansion", () => {
    const file = createTestGapFile();
    const collapsed = reviewDrawnRows(
      planReviewFileRender(file, { expandedGaps: [], sourceStatusByFileKey: {} }),
    );
    const gap = createTestGapFile().hunks[0]!.collapsedBefore;
    expect(collapsed.hunks[0]!.unifiedLineStart).toBe(file.hunks[0]!.unifiedLineStart - gap + 1);
    expect(reviewHunkRowFractions(collapsed, "unified")[0]!.start).toBeLessThan(
      reviewHunkRowFractions(file, "unified")[0]!.start,
    );

    const expanded = reviewDrawnRows(planWith({ kind: "loaded", text: `${AFTER.join("\n")}\n` }));
    expect(expanded.hunks[0]!.unifiedLineStart).toBe(file.hunks[0]!.unifiedLineStart);
  });

  test("marks an expanded gap the source cannot fill as an error", () => {
    expect(planWith({ kind: "loaded", text: "short\n" }).gaps[0]!.state).toBe("error");
  });

  test("gives a hunkless file its shared empty reason and no Pierre metadata", () => {
    const file = {
      ...createTestGapFile(),
      hunks: [],
      flags: { untracked: false, binary: true, tooLarge: false, partial: false },
    };
    const plan = planReviewFileRender(file, { expandedGaps: [], sourceStatusByFileKey: {} });

    expect(plan.emptyReason).toBe("binary");
    expect(plan.metadata).toBeUndefined();
  });

  test("maps Pierre separator indices onto core gap ids", () => {
    const file = createTestGapFile();
    expect(reviewGapIdForSeparator(file, 0)).toBe("before:0");
    expect(reviewGapIdForSeparator(file, file.hunks.length)).toBe("trailing:0");
  });
});
