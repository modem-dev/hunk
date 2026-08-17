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
 * File membership is broader than hunk membership: a file carrying review context but no
 * note inside any hunk is still a stop on the annotated-file tour.
 */
import { reviewHunkRanges, reviewRangesOverlap, type ReviewHunkSpan } from "./geometry";
import type { ReviewAnnotationIndex } from "./navigation";
import type { AgentAnnotation } from "../../extension-api/types";
import type { DiffFile } from "../changeset/model";

/** Whether one annotation lands inside a hunk's visible span on either side. */
export function reviewAnnotationOverlapsHunk(annotation: AgentAnnotation, hunk: ReviewHunkSpan) {
  const ranges = reviewHunkRanges(hunk);
  return (
    (annotation.newRange !== undefined &&
      reviewRangesOverlap(annotation.newRange, ranges.newRange)) ||
    (annotation.oldRange !== undefined && reviewRangesOverlap(annotation.oldRange, ranges.oldRange))
  );
}

/** Which of one file's hunks carry at least one annotation. */
export function reviewAnnotatedHunkIndices(file: DiffFile | undefined): ReadonlySet<number> {
  const annotated = new Set<number>();
  const annotations = file?.agent?.annotations;
  if (!annotations) {
    return annotated;
  }
  file!.metadata.hunks.forEach((hunk, index) => {
    if (annotations.some((annotation) => reviewAnnotationOverlapsHunk(annotation, hunk))) {
      annotated.add(index);
    }
  });
  return annotated;
}

/** Index the annotated files and hunks of one review, keyed by semantic file key. */
export function buildReviewAnnotationIndex(
  files: readonly DiffFile[],
  keyByFileId: ReadonlyMap<string, string>,
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
    const annotatedHunks = reviewAnnotatedHunkIndices(file);
    if (annotatedHunks.size > 0) {
      annotatedHunkIndicesByFileKey.set(fileKey, annotatedHunks);
    }
  }

  return { annotatedHunkIndicesByFileKey, annotatedFileKeys };
}
