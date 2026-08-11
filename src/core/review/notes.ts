import type { Hunk } from "@pierre/diffs";
import type { AgentAnnotation, DiffFile, ReviewNoteSource } from "../types";
import { hunkLineRange } from "../liveComments";
import { reviewDigest } from "./identity";
import type {
  ReviewLineAddressV1,
  ReviewNoteOriginV1,
  ReviewNoteV1,
  ReviewRangeAnchorV1,
} from "./types";

/** Range-less notes belong to the first hunk and render at its first code row. */
export const RANGELESS_NOTE_OWNERSHIP_POLICY = "first-hunk" as const;

/** Ranged notes outside visible hunks use the same first-row fallback as the terminal renderer. */
export const UNMATCHED_RANGED_NOTE_OWNERSHIP_POLICY = "first-hunk-fallback" as const;

export interface AnnotationAnchor {
  side: "old" | "new";
  lineNumber: number;
}

export interface ProjectReviewNoteOptions {
  annotation: AgentAnnotation;
  /** Preallocated id when projecting a file-wide note list. */
  projectedId?: string;
  fileKey: string;
  hunks: readonly Hunk[];
  origin: ReviewNoteOriginV1;
  editable?: boolean;
}

/** Resolve the user-facing source for one inline note annotation. */
export function reviewNoteSource(annotation: AgentAnnotation): ReviewNoteSource {
  if (annotation.source === "user") return "user";
  if (annotation.source === "mcp" || annotation.source === "agent") return "agent";
  return "ai";
}

/** Return whether a note remains visible when the AI note layer is hidden. */
export function alwaysShowReviewNote(annotation: AgentAnnotation) {
  return reviewNoteSource(annotation) === "user";
}

/** Check whether two inclusive line ranges overlap. */
export function reviewRangesOverlap(
  rangeA: readonly [number, number],
  rangeB: readonly [number, number],
) {
  return rangeA[0] <= rangeB[1] && rangeB[0] <= rangeA[1];
}

/** Resolve the primary source-side anchor, preferring the current file side. */
export function annotationAnchor(annotation: AgentAnnotation): AnnotationAnchor | null {
  if (annotation.newRange) {
    return { side: "new", lineNumber: annotation.newRange[0] };
  }
  if (annotation.oldRange) {
    return { side: "old", lineNumber: annotation.oldRange[0] };
  }
  return null;
}

/** Check whether an annotation's declared ranges intersect one hunk. */
export function annotationIntersectsHunk(annotation: AgentAnnotation, hunk: Hunk) {
  const range = hunkLineRange(hunk);
  return Boolean(
    (annotation.newRange && reviewRangesOverlap(annotation.newRange, range.newRange)) ||
    (annotation.oldRange && reviewRangesOverlap(annotation.oldRange, range.oldRange)),
  );
}

/** Return every hunk whose visible old or new range intersects an annotation. */
export function annotationIntersectingHunkIndices(
  annotation: AgentAnnotation,
  hunks: readonly Hunk[],
) {
  if (!annotation.oldRange && !annotation.newRange) return [];

  return hunks.flatMap((hunk, index) =>
    annotationIntersectsHunk(annotation, hunk) ? [index] : [],
  );
}

/**
 * Resolve the one owner used for terminal placement.
 *
 * Dual-range notes prefer the first hunk intersecting their new-side range even when
 * its start is collapsed and the old range intersects another hunk. Range-less and
 * unmatched ranged notes fall back to the first hunk,
 * matching terminal placement at the first visible code row.
 */
export function annotationOwnerHunkIndex(
  annotation: AgentAnnotation,
  hunks: readonly Hunk[],
  intersectingHunkIndices = annotationIntersectingHunkIndices(annotation, hunks),
) {
  const preferred = annotationAnchor(annotation);
  if (preferred) {
    const preferredAnnotationRange =
      preferred.side === "new" ? annotation.newRange : annotation.oldRange;
    const preferredIndex = hunks.findIndex((hunk) => {
      const range = hunkLineRange(hunk);
      const sideRange = preferred.side === "new" ? range.newRange : range.oldRange;
      return preferredAnnotationRange
        ? reviewRangesOverlap(preferredAnnotationRange, sideRange)
        : preferred.lineNumber >= sideRange[0] && preferred.lineNumber <= sideRange[1];
    });
    if (preferredIndex >= 0) return preferredIndex;
  }
  return intersectingHunkIndices[0] ?? (hunks.length > 0 ? 0 : undefined);
}

/** Return intersection memberships, or the single fallback owner when there are none. */
export function annotationVisibleHunkIndices(annotation: AgentAnnotation, hunks: readonly Hunk[]) {
  const intersecting = annotationIntersectingHunkIndices(annotation, hunks);
  if (intersecting.length > 0) return intersecting;
  const owner = annotationOwnerHunkIndex(annotation, hunks, intersecting);
  return owner === undefined ? [] : [owner];
}

/** Return annotations visible for one hunk through intersection or fallback membership. */
export function getAnnotationsVisibleInHunk(file: DiffFile | undefined, hunk: Hunk | undefined) {
  if (!file?.agent || !hunk) return [];
  const hunkIndex = file.metadata.hunks.indexOf(hunk);
  return file.agent.annotations.filter((annotation) =>
    annotationVisibleHunkIndices(annotation, file.metadata.hunks).includes(hunkIndex),
  );
}

/** Return one placement owner per annotation, including explicit fallback owners. */
export function getAnnotationOwnerHunkIndices(file: DiffFile | undefined) {
  const owners = new Set<number>();
  if (!file?.agent) return owners;

  for (const annotation of file.agent.annotations) {
    const owner = annotationOwnerHunkIndex(annotation, file.metadata.hunks);
    if (owner !== undefined) owners.add(owner);
  }
  return owners;
}

/** Return every genuinely intersected hunk used by annotated-note navigation. */
export function getAnnotationIntersectingHunkIndices(file: DiffFile | undefined) {
  const intersections = new Set<number>();
  if (!file?.agent) return intersections;

  for (const annotation of file.agent.annotations) {
    for (const hunkIndex of annotationIntersectingHunkIndices(annotation, file.metadata.hunks)) {
      intersections.add(hunkIndex);
    }
  }
  return intersections;
}

/** Build a stable fallback id when an annotation does not provide one. */
export function stableReviewNoteId(
  annotation: AgentAnnotation,
  fileKey: string,
  origin: ReviewNoteOriginV1,
  duplicateIndex = 0,
) {
  const semanticBody = JSON.stringify({
    oldRange: annotation.oldRange,
    newRange: annotation.newRange,
    summary: annotation.summary,
    rationale: annotation.rationale,
    markup: annotation.markup,
    title: annotation.title,
    author: annotation.author,
    createdAt: annotation.createdAt,
  });
  const baseId = annotation.id ?? `note:${reviewDigest(`${fileKey}\0${origin}\0${semanticBody}`)}`;
  return duplicateIndex === 0 ? baseId : `${baseId}:${duplicateIndex}`;
}

/** Project an annotation into the complete renderer-neutral note DTO. */
export function projectReviewNote({
  annotation,
  projectedId,
  fileKey,
  hunks,
  origin,
  editable = origin === "user",
}: ProjectReviewNoteOptions): ReviewNoteV1 {
  const intersectingHunkIndices = annotationIntersectingHunkIndices(annotation, hunks);
  const ownerHunkIndex = annotationOwnerHunkIndex(annotation, hunks, intersectingHunkIndices);
  const preferred = annotationAnchor(annotation);
  const anchor: ReviewRangeAnchorV1 = {
    ...(annotation.oldRange ? { oldRange: [...annotation.oldRange] as [number, number] } : {}),
    ...(annotation.newRange ? { newRange: [...annotation.newRange] as [number, number] } : {}),
    ...(preferred
      ? {
          preferred: {
            side: preferred.side,
            line: preferred.lineNumber,
          } satisfies ReviewLineAddressV1,
        }
      : {}),
    intersectingHunkIndices,
    ...(ownerHunkIndex !== undefined ? { ownerHunkIndex } : {}),
  };

  return {
    id: projectedId ?? stableReviewNoteId(annotation, fileKey, origin),
    source: reviewNoteSource(annotation),
    origin,
    ...(annotation.source ? { originalSource: annotation.source } : {}),
    fileKey,
    anchor,
    summary: annotation.summary,
    ...(annotation.rationale !== undefined ? { rationale: annotation.rationale } : {}),
    ...(annotation.markup !== undefined ? { markup: annotation.markup } : {}),
    ...(annotation.title !== undefined ? { title: annotation.title } : {}),
    ...(annotation.author !== undefined ? { author: annotation.author } : {}),
    ...(annotation.createdAt !== undefined ? { createdAt: annotation.createdAt } : {}),
    ...(annotation.updatedAt !== undefined ? { updatedAt: annotation.updatedAt } : {}),
    editable: annotation.editable ?? editable,
    ...(annotation.tags ? { tags: [...annotation.tags] } : {}),
    ...(annotation.confidence ? { confidence: annotation.confidence } : {}),
  };
}
