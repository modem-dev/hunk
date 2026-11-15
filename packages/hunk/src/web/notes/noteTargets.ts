/**
 * Turns a line or line range the reader picked in the diff into a note's target.
 *
 * The reader picks lines as Pierre draws them; a note addresses the shared model: the owning
 * hunk, a `ReviewLineAddressV1` or `ReviewRangeTargetV1`, and — for a line that only exists
 * because the reader expanded a gap — the `ReviewExpandedLineClaim` core defines
 * (`core/review/expansion.ts`, audit B10), which the session checks with
 * `resolveReviewExpandedLine` before it accepts the line. Coverage is the shared
 * `reviewRangeTargetCoverageIssue`: the session accepts a range only when the patch draws every
 * line of it, and a proof only for one line, so a range reaching into expanded context becomes
 * a note on the line the reader started from.
 */
import { reviewRangeTargetCoverageIssue } from "../../core/review/geometry";
import type { ReviewExpandedLineClaim } from "../../core/review/expansion";
import type { ReviewFileV1, ReviewNoteTargetV1, ReviewSide } from "../../core/review/types";
import type { ReviewGapView } from "../stream/fileProjection";

/** Where a new note goes, as the session's `notes/add-user` takes it. */
export interface ReviewNoteTargetPick {
  hunkIndex: number;
  target: ReviewNoteTargetV1;
  expandedLineProof?: ReviewExpandedLineClaim;
  /** The line its composer hangs beside. */
  side: ReviewSide;
  line: number;
  /** True when the reader asked for a range the session cannot take and got one line. */
  narrowed?: boolean;
}

/** The hunk whose rows draw one line of one side, if any. */
function hunkDrawing(file: ReviewFileV1, side: ReviewSide, line: number) {
  return file.hunks.findIndex((hunk) =>
    side === "new"
      ? line >= hunk.additionStart && line < hunk.additionStart + hunk.additionCount
      : line >= hunk.deletionStart && line < hunk.deletionStart + hunk.deletionCount,
  );
}

/** Target one line: a hunk's own row, or an expanded gap's row with its proof. */
export function reviewNoteLineTarget(
  file: ReviewFileV1,
  gaps: readonly ReviewGapView[],
  side: ReviewSide,
  line: number,
): ReviewNoteTargetPick | undefined {
  const hunkIndex = hunkDrawing(file, side, line);
  if (hunkIndex >= 0) return { hunkIndex, target: { side, line }, side, line };
  const gap = gaps.find((candidate) => {
    if (candidate.state !== "expanded") return false;
    const [start, end] = side === "old" ? candidate.address.oldRange : candidate.address.newRange;
    return line >= start && line <= end;
  });
  if (!gap || file.sourceIdentity === undefined) return undefined;
  return {
    hunkIndex: gap.address.hunkIndex,
    target: { side, line },
    expandedLineProof: { gapId: gap.gapId, side, line, sourceIdentity: file.sourceIdentity },
    side,
    line,
  };
}

/**
 * Target the lines from `start` to `end` on one side; the card hangs beside the last.
 *
 * Narrows to the starting line when the patch does not draw the whole range.
 */
export function reviewNoteRangeTarget(
  file: ReviewFileV1,
  gaps: readonly ReviewGapView[],
  side: ReviewSide,
  start: number,
  end: number,
): ReviewNoteTargetPick | undefined {
  const [low, high] = start <= end ? [start, end] : [end, start];
  if (low === high) return reviewNoteLineTarget(file, gaps, side, low);
  const range: [number, number] = [low, high];
  const target = {
    ...(side === "old" ? { oldRange: range } : { newRange: range }),
    preferred: { side, line: high },
  };
  const hunkIndex = hunkDrawing(file, side, high);
  if (hunkIndex >= 0 && !reviewRangeTargetCoverageIssue(file.hunks, target)) {
    return { hunkIndex, target, side, line: high };
  }
  const single = reviewNoteLineTarget(file, gaps, side, start);
  return single ? { ...single, narrowed: true } : undefined;
}
