/**
 * Where a note hangs: one owner hunk plus every hunk it genuinely intersects.
 *
 * Placement and membership are different questions and are answered here together, once.
 * Ownership is recorded on the anchor rather than re-derived by containment, so a note
 * this resolver placed through its fallback is not silently dropped by a consumer that
 * re-derives placement (`docs/browser-review-seam-audit.md`, D3/B8).
 *
 * Resolution is deliberately permissive: an imported note may name a line the current
 * patch no longer shows, and losing it entirely would be worse than hanging it from the
 * nearest real hunk. Callers that must reject an unbacked target validate before
 * anchoring rather than reading a verdict out of the anchor.
 */
import { reviewHunkRange, reviewRangesOverlap, type ReviewHunkSpan } from "./geometry";
import type { ReviewLineRange, ReviewRangeAnchorV1, ReviewSide } from "./types";

export interface ReviewNoteAnchorInput {
  oldRange?: ReviewLineRange;
  newRange?: ReviewLineRange;
  preferred?: { side: ReviewSide; line: number };
  /**
   * The hunk that owns the note when no range intersects one — an expanded-gap line, or
   * a range the current patch collapsed away.
   */
  fallbackOwnerHunkIndex?: number;
}

/** Resolve one note's owner hunk and full intersection set against current hunk geometry. */
export function resolveReviewNoteAnchor(
  hunks: readonly ReviewHunkSpan[],
  { oldRange, newRange, preferred, fallbackOwnerHunkIndex }: ReviewNoteAnchorInput,
): ReviewRangeAnchorV1 {
  const intersectingHunkIndices = hunks.flatMap((hunk, index) => {
    const intersects =
      (oldRange !== undefined && reviewRangesOverlap(oldRange, reviewHunkRange(hunk, "old"))) ||
      (newRange !== undefined && reviewRangesOverlap(newRange, reviewHunkRange(hunk, "new")));
    return intersects ? [index] : [];
  });

  // The preferred line decides ownership when it lands in a hunk, so a note the reviewer
  // placed on the new side is not re-homed by an old-side range that reaches further.
  const preferredOwner =
    preferred === undefined
      ? -1
      : hunks.findIndex((hunk) => {
          const [start, end] = reviewHunkRange(hunk, preferred.side);
          return preferred.line >= start && preferred.line <= end;
        });
  const validatedFallback =
    fallbackOwnerHunkIndex !== undefined && hunks[fallbackOwnerHunkIndex] !== undefined
      ? fallbackOwnerHunkIndex
      : undefined;
  const ownerHunkIndex =
    preferredOwner >= 0
      ? preferredOwner
      : (intersectingHunkIndices[0] ?? validatedFallback ?? (hunks.length > 0 ? 0 : undefined));

  return {
    ...(oldRange ? { oldRange: [...oldRange] as ReviewLineRange } : {}),
    ...(newRange ? { newRange: [...newRange] as ReviewLineRange } : {}),
    ...(preferred ? { preferred: { ...preferred } } : {}),
    intersectingHunkIndices,
    ...(ownerHunkIndex !== undefined ? { ownerHunkIndex } : {}),
  };
}

/**
 * Anchor one note to a single line inside one hunk.
 *
 * The one place a single-line anchor is constructed, so a note written by the reviewer
 * and a note delivered by an agent hang from the same geometry. The declared hunk is the
 * fallback owner, which is what keeps a note on an expanded-gap line attached to the
 * hunk the reviewer was reading.
 */
export function reviewLineAnchor(
  hunks: readonly ReviewHunkSpan[],
  target: { hunkIndex: number; side: ReviewSide; line: number },
): ReviewRangeAnchorV1 {
  const range = [target.line, target.line] as ReviewLineRange;
  return resolveReviewNoteAnchor(hunks, {
    ...(target.side === "old" ? { oldRange: range } : { newRange: range }),
    preferred: { side: target.side, line: target.line },
    fallbackOwnerHunkIndex: target.hunkIndex,
  });
}
