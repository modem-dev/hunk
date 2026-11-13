/**
 * The browser client's file projection as a geometry consumer.
 *
 * Every value is read back out of what the page would hand Pierre and draw around it —
 * the gaps its separators offer, the reason a file shows a placeholder, and, for the
 * fixture's expanded gap, the rows the Pierre metadata now contains with their line labels —
 * rather than by calling the shared primitives again. A browser projection that re-derived
 * a gap range or folded an expansion in at the wrong lines disagrees here.
 */
import { projectReviewDocument } from "../../../packages/hunk/src/core/review/document";
import { reviewExpansionSide } from "../../../packages/hunk/src/core/review/expansion";
import {
  reviewDefaultHunkLineTarget,
  reviewHunkRanges,
} from "../../../packages/hunk/src/core/review/geometry";
import type { ReviewFileV1 } from "../../../packages/hunk/src/core/review/types";
import { planReviewFileRender } from "../../../packages/hunk/src/web/stream/fileProjection";
import type {
  ConformanceExpandedRow,
  ReviewGeometryConsumer,
  ReviewGeometryFixture,
} from "../types";

/** Read the rows the expanded gap contributes to the metadata Pierre receives. */
function expandedRowsOf(
  file: ReviewFileV1,
  plan: ReturnType<typeof planReviewFileRender>,
  gapId: string,
): ConformanceExpandedRow[] {
  const gap = plan.gaps.find((candidate) => candidate.gapId === gapId);
  const metadata = plan.metadata;
  if (!gap || gap.state !== "expanded" || !metadata) return [];
  const leading = gap.address.position === "before";
  const hunk = metadata.hunks[gap.address.hunkIndex]!;
  const block = leading ? hunk.hunkContent[0] : hunk.hunkContent.at(-1);
  if (!block || block.type !== "context") return [];
  const lines =
    reviewExpansionSide(file.changeKind) === "old"
      ? metadata.deletionLines
      : metadata.additionLines;
  const index =
    reviewExpansionSide(file.changeKind) === "old"
      ? block.deletionLineIndex
      : block.additionLineIndex;
  // Line labels are where the block sits in its hunk: a leading block starts the hunk, a
  // trailing one ends it.
  const oldStart = leading
    ? hunk.deletionStart
    : hunk.deletionStart + hunk.deletionCount - block.lines;
  const newStart = leading
    ? hunk.additionStart
    : hunk.additionStart + hunk.additionCount - block.lines;
  return Array.from({ length: block.lines }, (_unused, offset) => ({
    oldLine: oldStart + offset,
    newLine: newStart + offset,
    // Parsed lines keep their terminators; a row's text is the line without it.
    text: (lines[index + offset] ?? "").replace(/\r?\n$/u, ""),
  }));
}

export const browserProjectionConsumer: ReviewGeometryConsumer = {
  name: "browser file projection",
  phase: "M4",
  project(fixture: ReviewGeometryFixture) {
    const document = projectReviewDocument(fixture.build(), { sourceLabel: "/conformance" });
    return {
      files: document.files.map((file, fileIndex) => {
        const expansion =
          fixture.expansion?.fileIndex === fileIndex ? fixture.expansion : undefined;
        const plan = planReviewFileRender(file, {
          expandedGaps: expansion
            ? [{ fileKey: file.key, gapId: expansion.gapId, expanded: true }]
            : [],
          sourceStatusByFileKey: expansion
            ? { [file.key]: { kind: "loaded", text: expansion.sourceText } }
            : {},
        });
        return {
          path: file.path,
          gaps: plan.gaps.map((gap) => ({
            gapId: gap.gapId,
            oldRange: [...gap.address.oldRange] as [number, number],
            newRange: [...gap.address.newRange] as [number, number],
            lineCount: gap.address.lineCount,
          })),
          hunkRanges: file.hunks.map((hunk) => {
            const ranges = reviewHunkRanges(hunk);
            return {
              oldRange: [...ranges.oldRange] as [number, number],
              newRange: [...ranges.newRange] as [number, number],
            };
          }),
          defaultNoteTargets: file.hunks.map((hunk) => reviewDefaultHunkLineTarget(hunk)),
          ...(plan.emptyReason ? { emptyDiffReason: plan.emptyReason } : {}),
          ...(expansion ? { expandedRows: expandedRowsOf(file, plan, expansion.gapId) } : {}),
        };
      }),
    };
  },
};
