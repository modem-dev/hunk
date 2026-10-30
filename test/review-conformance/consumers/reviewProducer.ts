/**
 * The producer runtime as a conformance consumer.
 *
 * It reaches the same answers by a different route than core does: geometry is read back
 * out of the published content manifest rather than by calling the primitives, and the
 * rows an expanded gap reveals come from the address the `expansion/toggle` intent
 * resolved. A producer that published a manifest disagreeing with the model, or an intent
 * that addressed a different span than the manifest advertises, fails here.
 *
 * Each fixture is also self-checked at the boundary the producer actually serves: every
 * canonical file it would hand out is compared against the manifest entry for it (D4).
 */
import { ReviewProducer } from "../../../packages/hunk/src/app/review/producer";
import { assertCanonicalFileMatchesManifest } from "../../../packages/hunk/src/core/review/canonicalFile";
import type {
  ReviewContentManifestFile,
  ReviewContentManifestGap,
} from "../../../packages/hunk/src/core/review/contentManifest";
import {
  ReviewIntentPlanningError,
  type ReviewExpansionToggledOutcome,
} from "../../../packages/hunk/src/core/review/intents";
import { normalizedReviewSourceLines } from "../../../packages/hunk/src/core/review/geometry";
import { createReviewStore } from "../../../packages/hunk/src/core/review/store";
import type {
  ConformanceExpandedRow,
  ConformanceGap,
  ReviewGeometryConsumer,
  ReviewGeometryFixture,
} from "../types";

/** Report one manifest gap in the shape the corpus states gaps in. */
function toConformanceGap(gap: ReviewContentManifestGap): ConformanceGap {
  return {
    gapId: gap.gapId,
    oldRange: [...gap.oldRange] as [number, number],
    newRange: [...gap.newRange] as [number, number],
    lineCount: gap.lineCount,
  };
}

/** Collect one file's gaps from the manifest, in the order a renderer meets them. */
function gapsOf(file: ReviewContentManifestFile): ConformanceGap[] {
  const leading = file.hunks.flatMap((hunk) =>
    hunk.leadingGap ? [toConformanceGap(hunk.leadingGap)] : [],
  );
  return file.trailingGap ? [...leading, toConformanceGap(file.trailingGap)] : leading;
}

/** Resolve the rows one gap reveals from the address the expansion intent settled on. */
function expandedRowsOf(
  outcome: ReviewExpansionToggledOutcome,
  sourceText: string,
): ConformanceExpandedRow[] {
  const sourceLines = normalizedReviewSourceLines(sourceText);
  const range = outcome.side === "old" ? outcome.oldRange : outcome.newRange;
  return Array.from({ length: outcome.lineCount }, (_unused, offset) => ({
    oldLine: outcome.oldRange[0] + offset,
    newLine: outcome.newRange[0] + offset,
    text: sourceLines[range[0] + offset - 1] ?? "",
  }));
}

export const reviewProducerConsumer: ReviewGeometryConsumer = {
  name: "review producer",
  phase: "Phase 2",
  project(fixture: ReviewGeometryFixture) {
    const files = fixture.build();
    const producer = new ReviewProducer(
      { files, sourceLabel: "conformance" },
      {
        producerId: "conformance",
      },
    );
    const publication = producer.getPublication();
    producer.attachStore(createReviewStore(publication.document));

    return {
      files: publication.manifest.files.map((file, fileIndex) => {
        // The producer serves this file as a canonical resource; publishing one that
        // disagreed with the manifest is a failure of the fixture's own generation.
        assertCanonicalFileMatchesManifest(publication.document.files[fileIndex]!, file);

        const expansion =
          fixture.expansion?.fileIndex === fileIndex ? fixture.expansion : undefined;
        let expandedRows: ConformanceExpandedRow[] | undefined;
        if (expansion) {
          try {
            const outcome = producer.applyIntent({
              type: "expansion/toggle",
              fileKey: file.key,
              gapId: expansion.gapId,
            });
            expandedRows = expandedRowsOf(outcome, expansion.sourceText);
          } catch (error) {
            // A gap the file does not have reveals nothing, which is the same answer the
            // model gives; anything else is a real failure.
            if (!(error instanceof ReviewIntentPlanningError)) {
              throw error;
            }
          }
        }

        return {
          path: file.path,
          gaps: gapsOf(file),
          hunkRanges: file.hunks.map((hunk) => ({
            oldRange: [...hunk.oldRange] as [number, number],
            newRange: [...hunk.newRange] as [number, number],
          })),
          defaultNoteTargets: file.hunks.map((hunk) => hunk.defaultNoteTarget),
          ...(file.emptyDiffReason ? { emptyDiffReason: file.emptyDiffReason } : {}),
          ...(expandedRows ? { expandedRows } : {}),
        };
      }),
    };
  },
};
