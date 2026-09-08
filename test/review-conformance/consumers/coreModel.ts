/**
 * The shared review model as its own conformance consumer.
 *
 * Registering core alongside every renderer is what makes the corpus a contract rather
 * than a description of one implementation: the hand-written expectations are checked
 * against the primitives first, so a renderer failure means the renderer diverged, not
 * that the fixture drifted.
 */
import {
  projectReviewDocument,
  reviewEmptyDiffReason,
} from "../../../packages/hunk/src/core/review/document";
import {
  reviewExpansionSide,
  reviewGapAddress,
  reviewGapId,
  reviewGapSourceForFile,
  reviewLeadingGap,
  reviewTrailingGap,
} from "../../../packages/hunk/src/core/review/expansion";
import {
  normalizedReviewSourceLines,
  reviewDefaultHunkLineTarget,
  reviewHunkRanges,
} from "../../../packages/hunk/src/core/review/geometry";
import type { ReviewFileV1 } from "../../../packages/hunk/src/core/review/types";
import type {
  ConformanceExpandedRow,
  ConformanceGap,
  ConformanceExpansion,
  ReviewGeometryConsumer,
  ReviewGeometryFixture,
} from "../types";

/** Collect one file's gaps in the order a top-to-bottom renderer meets them. */
function gapsOf(file: ReviewFileV1): ConformanceGap[] {
  const source = reviewGapSourceForFile(file);
  const gaps = file.hunks.flatMap((_hunk, index) => {
    const leading = reviewLeadingGap(source, index);
    return leading
      ? [
          {
            gapId: reviewGapId("before", index),
            oldRange: [...leading.oldRange] as [number, number],
            newRange: [...leading.newRange] as [number, number],
            lineCount: leading.lineCount,
          },
        ]
      : [];
  });
  const trailing = reviewTrailingGap(source);
  return trailing
    ? [
        ...gaps,
        {
          gapId: reviewGapId("trailing", trailing.hunkIndex),
          oldRange: [...trailing.oldRange] as [number, number],
          newRange: [...trailing.newRange] as [number, number],
          lineCount: trailing.lineCount,
        },
      ]
    : gaps;
}

/** Resolve the rows one expanded gap reveals from full source text. */
function expandedRowsOf(
  file: ReviewFileV1,
  expansion: ConformanceExpansion,
): ConformanceExpandedRow[] | undefined {
  const address = reviewGapAddress(reviewGapSourceForFile(file), expansion.gapId);
  if (!address) {
    return undefined;
  }
  const side = reviewExpansionSide(file.changeKind);
  const sourceLines = normalizedReviewSourceLines(expansion.sourceText);
  const range = side === "old" ? address.oldRange : address.newRange;
  return Array.from({ length: address.lineCount }, (_unused, offset) => ({
    oldLine: address.oldRange[0] + offset,
    newLine: address.newRange[0] + offset,
    text: sourceLines[range[0] + offset - 1] ?? "",
  }));
}

export const coreModelConsumer: ReviewGeometryConsumer = {
  name: "core review model",
  phase: "Phase 1 PR 2",
  project(fixture: ReviewGeometryFixture) {
    const document = projectReviewDocument(fixture.build());
    return {
      files: document.files.map((file, fileIndex) => {
        const expansion =
          fixture.expansion?.fileIndex === fileIndex
            ? expandedRowsOf(file, fixture.expansion)
            : undefined;
        return {
          path: file.path,
          gaps: gapsOf(file),
          hunkRanges: file.hunks.map(reviewHunkRanges),
          defaultNoteTargets: file.hunks.map(reviewDefaultHunkLineTarget),
          ...(file.hunks.length === 0
            ? {
                emptyDiffReason: reviewEmptyDiffReason({
                  changeKind: file.changeKind,
                  binary: file.flags.binary,
                  tooLarge: file.flags.tooLarge,
                }),
              }
            : {}),
          ...(expansion ? { expandedRows: expansion } : {}),
        };
      }),
    };
  },
};
