import { describe, expect, test } from "bun:test";
import { projectReviewDocument } from "../../core/review/document";
import { createTestDiffFile } from "../../../../../test/helpers/diff-helpers";
import { planReviewFileRender } from "../stream/fileProjection";
import { reviewNoteLineTarget, reviewNoteRangeTarget } from "./noteTargets";

const BEFORE = Array.from({ length: 40 }, (_unused, index) => `const v${index} = ${index};`);
const AFTER = BEFORE.map((line, index) => (index === 20 ? "const v20 = 2000;" : line));

/** One file whose single hunk draws new lines 19–23, with its leading gap expanded or not. */
function createTestTargetFile(expanded: boolean) {
  const file = projectReviewDocument(
    [
      createTestDiffFile({
        id: "targets",
        path: "targets.ts",
        before: `${BEFORE.join("\n")}\n`,
        after: `${AFTER.join("\n")}\n`,
        context: 2,
      }),
    ],
    { sourceLabel: "/test" },
  ).files[0]!;
  const plan = planReviewFileRender(file, {
    expandedGaps: expanded ? [{ fileKey: file.key, gapId: "before:0", expanded: true }] : [],
    sourceStatusByFileKey: expanded
      ? { [file.key]: { kind: "loaded", text: `${AFTER.join("\n")}\n` } }
      : {},
  });
  // A proof names the source the gap was expanded from; patch-only fixtures carry none.
  return { file: { ...file, sourceIdentity: "source:targets" }, gaps: plan.gaps };
}

describe("reviewNoteLineTarget", () => {
  test("targets a line the hunk draws with no proof", () => {
    const { file, gaps } = createTestTargetFile(false);
    expect(reviewNoteLineTarget(file, gaps, "new", 21)).toEqual({
      hunkIndex: 0,
      target: { side: "new", line: 21 },
      side: "new",
      line: 21,
    });
  });

  test("proves a line only an expanded gap drew, and refuses one still collapsed", () => {
    const collapsed = createTestTargetFile(false);
    expect(reviewNoteLineTarget(collapsed.file, collapsed.gaps, "new", 3)).toBeUndefined();

    const { file, gaps } = createTestTargetFile(true);
    const pick = reviewNoteLineTarget(file, gaps, "new", 3);
    expect(pick?.target).toEqual({ side: "new", line: 3 });
    expect(pick?.expandedLineProof).toEqual({
      gapId: "before:0",
      side: "new",
      line: 3,
      sourceIdentity: "source:targets",
    });
  });

  test("refuses an expanded line when the file names no source", () => {
    const { file, gaps } = createTestTargetFile(true);
    const { sourceIdentity: _unused, ...withoutSource } = file;
    expect(reviewNoteLineTarget(withoutSource, gaps, "new", 3)).toBeUndefined();
  });
});

describe("reviewNoteRangeTarget", () => {
  test("targets a range the hunk draws, hanging the card at its last line", () => {
    const { file, gaps } = createTestTargetFile(false);
    const pick = reviewNoteRangeTarget(file, gaps, "new", 22, 20);
    expect(pick).toEqual({
      hunkIndex: 0,
      target: { newRange: [20, 22], preferred: { side: "new", line: 22 } },
      side: "new",
      line: 22,
    });
  });

  // Intent: the session attests one expanded line per proof, so a range into expanded context
  // becomes a note on the line the reader started from rather than a refused save.
  test("narrows a range reaching into expanded context to its starting line", () => {
    const { file, gaps } = createTestTargetFile(true);
    const pick = reviewNoteRangeTarget(file, gaps, "new", 17, 20);
    expect(pick?.narrowed).toBe(true);
    expect(pick?.target).toEqual({ side: "new", line: 17 });
    expect(pick?.expandedLineProof?.line).toBe(17);
  });
});
