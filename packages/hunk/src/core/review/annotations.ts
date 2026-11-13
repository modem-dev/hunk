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
import type { ReviewAnnotationIndex, ReviewThreadCursor } from "./navigation";
import { reviewNoteAnchorLine, reviewNoteOwnerHunkIndex, reviewNoteVisibleByPolicy } from "./state";
import type { AgentAnnotation } from "../../extension-api/types";
import type { DiffFile } from "../changeset/model";
import type { ReviewNoteSource } from "../run/commandInputs";
import type { ReviewLineAddressV1, ReviewRangeAnchorV1 } from "./types";

/** Resolve the normalized source for one annotation from its raw producer label. */
export function reviewNoteSource(annotation: AgentAnnotation): ReviewNoteSource {
  if (annotation.source === "user") {
    return "user";
  }

  if (annotation.source === "mcp" || annotation.source === "agent") {
    return "agent";
  }

  return "ai";
}

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

/**
 * Name one sidecar annotation as a navigable thread.
 *
 * Built from the semantic file key and the annotation's own id, or its position in the
 * file's sidecar list when it has none, so the id never carries a renderer's runtime file id.
 */
export function reviewSidecarThreadId(fileKey: string, annotation: AgentAnnotation, index: number) {
  return annotation.id
    ? `sidecar:${fileKey}:id:${annotation.id}`
    : `sidecar:${fileKey}:at:${index}`;
}

/** One visible file as thread navigation reads it, in review-stream order. */
export interface ReviewThreadSourceFile {
  fileKey: string;
  hunks: readonly ReviewHunkSpan[];
  /** Visible hunk positions; omitted means every hunk is visible. */
  hunkIndexes?: readonly number[];
  /** The changeset's sidecar annotations, before any stored note is merged beside them. */
  sidecar?: readonly AgentAnnotation[];
}

/** One stored thread root, already resolved to the hunk and line its card hangs from. */
export interface ReviewStoredThreadRoot {
  fileKey: string;
  hunkIndex: number;
  line: ReviewLineAddressV1;
  noteId: string;
}

/**
 * List every navigable comment thread in review-stream order.
 *
 * A thread is one visible stored-note root or one sidecar annotation; replies are never
 * separate stops. Order follows exact-note navigation — file, owner hunk, anchor line — with
 * stored roots before sidecar annotations on the same line and arrival order breaking ties.
 * Threads in hidden files or hunks, and sidecar annotations the agent-note layer hides, are
 * left out. Stored roots arrive already filtered by that layer.
 */
export function buildReviewThreadCursors({
  files,
  storedRoots,
  showAgentNotes,
}: {
  files: readonly ReviewThreadSourceFile[];
  storedRoots: readonly ReviewStoredThreadRoot[];
  showAgentNotes: boolean;
}): ReviewThreadCursor[] {
  const fileOrder = new Map(files.map((file, index) => [file.fileKey, index] as const));
  const visibleHunks = new Map(
    files.map((file) => [file.fileKey, file.hunkIndexes ? new Set(file.hunkIndexes) : null]),
  );
  const isVisible = (fileKey: string, hunkIndex: number) => {
    if (!visibleHunks.has(fileKey)) return false;
    const hunks = visibleHunks.get(fileKey);
    return hunks ? hunks.has(hunkIndex) : true;
  };

  const cursors: ReviewThreadCursor[] = storedRoots
    .filter((root) => isVisible(root.fileKey, root.hunkIndex))
    .map((root) => ({
      fileKey: root.fileKey,
      hunkIndex: root.hunkIndex,
      line: root.line,
      threadId: root.noteId,
      kind: "stored",
    }));

  for (const file of files) {
    if (file.hunks.length === 0) continue;

    (file.sidecar ?? []).forEach((annotation, index) => {
      if (!reviewNoteVisibleByPolicy({ source: reviewNoteSource(annotation) }, showAgentNotes)) {
        return;
      }

      const anchored = { anchor: reviewAnnotationAnchor(file.hunks, annotation) };
      const hunkIndex = reviewNoteOwnerHunkIndex(anchored);
      if (!isVisible(file.fileKey, hunkIndex)) return;

      cursors.push({
        fileKey: file.fileKey,
        hunkIndex,
        line: reviewNoteAnchorLine(anchored),
        threadId: reviewSidecarThreadId(file.fileKey, annotation, index),
        kind: "sidecar",
      });
    });
  }

  const kindRank = (cursor: ReviewThreadCursor) => (cursor.kind === "stored" ? 0 : 1);
  return cursors
    .map((cursor, arrival) => ({ cursor, arrival }))
    .sort(
      (left, right) =>
        (fileOrder.get(left.cursor.fileKey) ?? 0) - (fileOrder.get(right.cursor.fileKey) ?? 0) ||
        left.cursor.hunkIndex - right.cursor.hunkIndex ||
        left.cursor.line.line - right.cursor.line.line ||
        kindRank(left.cursor) - kindRank(right.cursor) ||
        left.arrival - right.arrival,
    )
    .map(({ cursor }) => cursor);
}
