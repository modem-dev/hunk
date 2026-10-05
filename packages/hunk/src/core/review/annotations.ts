/**
 * Which files and hunks a review's notes reach.
 *
 * Annotated navigation — "next hunk that has something to say about it" — plans over this
 * index, and core cannot compute it: notes arrive from sources the semantic document does
 * not carry (a sidecar loaded with the changeset, live agent comments, the reviewer's own
 * notes), and only the consumer that merged them onto the diff model knows the full set.
 * It is therefore a caller-supplied fact (`ReviewIntentFacts.annotations`), but the
 * *derivation* is shared, so the terminal and the producer hand the planner the same
 * answer instead of two that agree by coincidence.
 *
 * A hunk counts as annotated when a note intersects it or resolves to it as its owner,
 * matching the hunk where drawing places that note. File membership is broader still: a
 * file carrying review context without annotations remains on the annotated-file tour.
 */
import { reviewGapOwnerHunkIndex, resolveReviewNoteAnchor } from "./anchors";
import { reviewHunkRanges, reviewRangesOverlap, type ReviewHunkSpan } from "./geometry";
import type { ReviewAnnotationIndex } from "./navigation";
import type { AgentAnnotation } from "../../extension-api/types";
import type { DiffFile } from "../changeset/model";
import type { ReviewLineAddressV1, ReviewRangeAnchorV1 } from "./types";

/** Whether one annotation lands inside a hunk's visible span on either side. */
export function reviewAnnotationOverlapsHunk(annotation: AgentAnnotation, hunk: ReviewHunkSpan) {
  const ranges = reviewHunkRanges(hunk);
  return (
    (annotation.newRange !== undefined &&
      reviewRangesOverlap(annotation.newRange, ranges.newRange)) ||
    (annotation.oldRange !== undefined && reviewRangesOverlap(annotation.oldRange, ranges.oldRange))
  );
}

/** A note target declared by the surface that knows where the note was written. */
export interface ReviewAnnotationTarget extends ReviewLineAddressV1 {
  hunkIndex: number;
}

/** Resolve one annotation with the same preferred line and owner used by drawing. */
export function reviewAnnotationAnchor(
  hunks: readonly ReviewHunkSpan[],
  annotation: AgentAnnotation,
  target?: ReviewAnnotationTarget,
): ReviewRangeAnchorV1 {
  const preferred: ReviewLineAddressV1 | undefined = target
    ? { side: target.side, line: target.line }
    : annotation.newRange
      ? { side: "new", line: annotation.newRange[0] }
      : annotation.oldRange
        ? { side: "old", line: annotation.oldRange[0] }
        : undefined;
  const fallbackOwnerHunkIndex =
    target?.hunkIndex ??
    (preferred ? reviewGapOwnerHunkIndex(hunks, preferred.side, preferred.line) : undefined);

  return resolveReviewNoteAnchor(hunks, {
    ...(annotation.oldRange ? { oldRange: annotation.oldRange } : {}),
    ...(annotation.newRange ? { newRange: annotation.newRange } : {}),
    ...(preferred ? { preferred } : {}),
    ...(fallbackOwnerHunkIndex !== undefined ? { fallbackOwnerHunkIndex } : {}),
  });
}

/** Mark every intersecting hunk and resolved owner, using any declared surface target. */
export function reviewAnnotatedHunkIndices(
  file: DiffFile | undefined,
  declaredTarget?: (annotation: AgentAnnotation) => ReviewAnnotationTarget | undefined,
): ReadonlySet<number> {
  const annotated = new Set<number>();
  const annotations = file?.agent?.annotations;
  const hunks = file?.metadata.hunks;
  if (!annotations || !hunks) {
    return annotated;
  }

  for (const annotation of annotations) {
    const anchor = reviewAnnotationAnchor(hunks, annotation, declaredTarget?.(annotation));
    for (const hunkIndex of anchor.intersectingHunkIndices) {
      annotated.add(hunkIndex);
    }
    if (anchor.ownerHunkIndex !== undefined) {
      annotated.add(anchor.ownerHunkIndex);
    }
  }
  return annotated;
}

/**
 * Index annotated files and drawing-owned hunks, keyed by semantic file key.
 *
 * The optional target callback supplies stored-note placement; without it, geometry alone
 * determines the owner, as it does for sidecar annotations.
 */
export function buildReviewAnnotationIndex(
  files: readonly DiffFile[],
  keyByFileId: ReadonlyMap<string, string>,
  declaredTarget?: (annotation: AgentAnnotation) => ReviewAnnotationTarget | undefined,
): ReviewAnnotationIndex {
  const annotatedHunkIndicesByFileKey = new Map<string, ReadonlySet<number>>();
  const annotatedFileKeys = new Set<string>();

  for (const file of files) {
    const fileKey = keyByFileId.get(file.id);
    if (!fileKey) {
      continue;
    }
    if (file.agent) {
      annotatedFileKeys.add(fileKey);
    }
    const annotatedHunks = reviewAnnotatedHunkIndices(file, declaredTarget);
    if (annotatedHunks.size > 0) {
      annotatedHunkIndicesByFileKey.set(fileKey, annotatedHunks);
    }
  }

  return { annotatedHunkIndicesByFileKey, annotatedFileKeys };
}
