/**
 * The browser client's projection as a conformance consumer.
 *
 * This is the loop the Phase 5 gate is about: the same fixtures the terminal's row builder
 * answers, answered by what the browser actually draws from. Every value below is read out
 * of the render model `pierreDocument` produces — the gaps the stream draws strips for, the
 * per-hunk extents it addresses, the note target it hangs a note from, the rows an expanded
 * gap reveals — rather than by calling core a second time. A browser that re-derived any of
 * them would disagree with the terminal here rather than on a reviewer's screen
 * (`docs/browser-review-seam-audit.md`, A1–A10).
 *
 * The fixtures build parsed diff files, which is the terminal's input; the browser's input
 * is the projected document those files publish, so the adapter projects first and then
 * asks the browser's own code the questions.
 */
import { projectReviewDocument } from "../../../src/core/review/document";
import {
  buildBrowserReviewFileRenderModel,
  browserReviewExpandedGapRows,
} from "../../../src/web/browserPierreDocument";
import type { ConformanceGap, ReviewGeometryConsumer, ReviewGeometryFixture } from "../types";

/** Read the gaps the stream would draw, in the order it would draw them. */
function gapsOf(model: ReturnType<typeof buildBrowserReviewFileRenderModel>): ConformanceGap[] {
  return model.gaps.map((gap) => ({
    gapId: gap.gapId,
    oldRange: [...gap.oldRange] as [number, number],
    newRange: [...gap.newRange] as [number, number],
    lineCount: gap.lineCount,
  }));
}

export const browserReviewProjectionConsumer: ReviewGeometryConsumer = {
  name: "browser review projection",
  phase: "Phase 5 PR 1",
  project(fixture: ReviewGeometryFixture) {
    const document = projectReviewDocument(fixture.build());
    return {
      files: document.files.map((file, fileIndex) => {
        const model = buildBrowserReviewFileRenderModel(file);
        const expansion =
          fixture.expansion?.fileIndex === fileIndex ? fixture.expansion : undefined;
        return {
          path: model.path,
          gaps: gapsOf(model),
          hunkRanges: model.hunks.map((hunk) => ({
            oldRange: [...hunk.oldRange] as [number, number],
            newRange: [...hunk.newRange] as [number, number],
          })),
          defaultNoteTargets: model.hunks.map((hunk) => hunk.noteTarget),
          ...(model.emptyDiffReason ? { emptyDiffReason: model.emptyDiffReason } : {}),
          ...(expansion
            ? {
                expandedRows:
                  browserReviewExpandedGapRows(file, expansion.gapId, expansion.sourceText) ?? [],
              }
            : {}),
        };
      }),
    };
  },
};
