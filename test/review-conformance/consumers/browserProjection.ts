/**
 * The browser client's file projection as a geometry consumer.
 *
 * Every value is read back out of what the page would hand Pierre and draw around it —
 * the gaps its separators offer, the reason a file shows a placeholder, and, for the
 * fixture's expanded gap, the rows the Pierre metadata now contains with their line labels —
 * rather than by calling the shared primitives again. A browser projection that re-derived
 * a gap range or folded an expansion in at the wrong lines disagrees here.
 *
 * A whole-hunk note's landing line is read from the page's note placement: an agent comment
 * addressed to each hunk is added through the real `ReviewSessionHost`, and the page's
 * `planReviewFileNotes` says which drawn line its card hangs beside.
 */
import { ReviewSessionHost } from "../../../packages/hunk/src/app/review/reviewSessionHost";
import { projectReviewDocument } from "../../../packages/hunk/src/core/review/document";
import { reviewExpansionSide } from "../../../packages/hunk/src/core/review/expansion";
import { reviewHunkRanges } from "../../../packages/hunk/src/core/review/geometry";
import { planReviewFileNotes } from "../../../packages/hunk/src/web/notes/noteProjection";
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

/**
 * Where the page hangs a note addressed to each whole hunk, per file.
 *
 * One agent comment per hunk goes through the host exactly as `hunk session comment add
 * --hunk` would, and each file's cards are planned over its drawn hunks.
 */
function wholeHunkNoteLandings(fixture: ReviewGeometryFixture) {
  const files = fixture.build();
  const host = new ReviewSessionHost({ files, sourceLabel: "/conformance", now: () => 1 });
  host.setShowAgentNotes(true);
  return host.getDocument().files.map((file, fileIndex) => {
    const diffFile = files[fileIndex]!;
    return file.hunks.map((_hunk, hunkIndex) => {
      const commentId = `conformance:${fileIndex}:${hunkIndex}`;
      host.addLiveComment({ filePath: diffFile.path, hunkIndex, summary: "whole hunk" }, commentId);
      const state = host.getSnapshot();
      const group = planReviewFileNotes({
        file: { key: file.key, hunks: file.hunks },
        state,
        sidecar: [],
      }).find((candidate) => candidate.cards.some((card) => card.id === commentId));
      return group ? { side: group.side, line: group.line } : { side: "new" as const, line: 0 };
    });
  });
}

export const browserProjectionConsumer: ReviewGeometryConsumer = {
  name: "browser file projection",
  phase: "M4",
  project(fixture: ReviewGeometryFixture) {
    const document = projectReviewDocument(fixture.build(), { sourceLabel: "/conformance" });
    const landings = wholeHunkNoteLandings(fixture);
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
          defaultNoteTargets: landings[fileIndex] ?? [],
          ...(plan.emptyReason ? { emptyDiffReason: plan.emptyReason } : {}),
          ...(expansion ? { expandedRows: expandedRowsOf(file, plan, expansion.gapId) } : {}),
        };
      }),
    };
  },
};
