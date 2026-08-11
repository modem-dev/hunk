import { reviewDigest } from "./identity";
import type {
  ReviewFileV1,
  ReviewHunkV1,
  ReviewLineRange,
  ReviewRangeAnchorV1,
  ReviewSide,
} from "./types";

export interface ReviewLineTarget {
  side: ReviewSide;
  line: number;
  /** When supplied, the canonical line must resolve to this hunk. */
  hunkIndex?: number;
}

export interface ResolvedReviewLineAddress {
  side: ReviewSide;
  line: number;
  hunkIndex: number;
  arrayIndex: number;
  contextDigest: string;
}

export interface ReviewNoteAnchorInput {
  oldRange?: ReviewLineRange;
  newRange?: ReviewLineRange;
  preferred?: { side: ReviewSide; line: number };
}

/** Return the inclusive semantic range occupied by one hunk on one side. */
export function reviewHunkRange(hunk: ReviewHunkV1, side: ReviewSide) {
  const start = side === "new" ? hunk.additionStart : hunk.deletionStart;
  const count = side === "new" ? hunk.additionCount : hunk.deletionCount;
  return [start, Math.max(start, start + Math.max(count, 1) - 1)] as const;
}

/** Map one backed absolute semantic line to its compact patch-array address. */
export function reviewLineAddress(file: ReviewFileV1, side: ReviewSide, line: number) {
  for (let hunkIndex = 0; hunkIndex < file.hunks.length; hunkIndex += 1) {
    const hunk = file.hunks[hunkIndex]!;
    const start = side === "new" ? hunk.additionStart : hunk.deletionStart;
    const count = side === "new" ? hunk.additionCount : hunk.deletionCount;
    const lineIndex = side === "new" ? hunk.additionLineIndex : hunk.deletionLineIndex;
    // Zero-count sides describe a boundary for hunk/gap geometry, not a persisted line target.
    if (count <= 0 || line < start || line >= start + count) continue;
    const arrayIndex = file.flags.partial ? lineIndex + line - start : line - 1;
    const lines = side === "new" ? file.additionLines : file.deletionLines;
    if (arrayIndex < 0 || arrayIndex >= lines.length) return undefined;
    return { hunkIndex, arrayIndex };
  }
  return undefined;
}

/** Hash a fixed hunk-local neighborhood for reload rematching. */
export function reviewLineContextDigest(file: ReviewFileV1, side: ReviewSide, line: number) {
  const address = reviewLineAddress(file, side, line);
  if (!address) return undefined;
  const hunk = file.hunks[address.hunkIndex]!;
  const lines = side === "new" ? file.additionLines : file.deletionLines;
  const lineIndex = side === "new" ? hunk.additionLineIndex : hunk.deletionLineIndex;
  const count = side === "new" ? hunk.additionCount : hunk.deletionCount;
  const offset = file.flags.partial ? address.arrayIndex - lineIndex : address.arrayIndex;
  const availableStart = file.flags.partial ? lineIndex : 0;
  const availableCount = file.flags.partial ? count : lines.length;
  const neighborhood = [-2, -1, 0, 1, 2].map((delta) => {
    const candidate = offset + delta;
    return candidate >= 0 && candidate < availableCount ? lines[availableStart + candidate] : null;
  });
  return reviewDigest(JSON.stringify(neighborhood));
}

/** Strictly resolve a persisted line target and derive all canonical evidence. */
export function resolveReviewLineAddress(
  file: ReviewFileV1,
  target: ReviewLineTarget,
): ResolvedReviewLineAddress | undefined {
  if (
    !Number.isSafeInteger(target.line) ||
    target.line <= 0 ||
    (target.hunkIndex !== undefined &&
      (!Number.isSafeInteger(target.hunkIndex) || target.hunkIndex < 0))
  ) {
    return undefined;
  }
  const address = reviewLineAddress(file, target.side, target.line);
  if (!address || (target.hunkIndex !== undefined && target.hunkIndex !== address.hunkIndex)) {
    return undefined;
  }
  const contextDigest = reviewLineContextDigest(file, target.side, target.line);
  if (!contextDigest) return undefined;
  return {
    side: target.side,
    line: target.line,
    hunkIndex: address.hunkIndex,
    arrayIndex: address.arrayIndex,
    contextDigest,
  };
}

/** Return whether two inclusive semantic ranges overlap. */
function rangesOverlap(left: ReviewLineRange, right: ReviewLineRange) {
  return left[0] <= right[1] && right[0] <= left[1];
}

/**
 * Project note membership and one placement owner from canonical hunk geometry.
 *
 * This helper is deliberately permissive: reconciliation may retain stale or unbacked ranges.
 * Strict newly persisted targets must pass `resolveReviewLineAddress` before using this projection.
 */
export function resolveReviewNoteAnchor(
  file: ReviewFileV1,
  { oldRange, newRange, preferred }: ReviewNoteAnchorInput,
): ReviewRangeAnchorV1 {
  const intersectingHunkIndices = file.hunks.flatMap((hunk, index) => {
    const intersects =
      Boolean(oldRange && rangesOverlap(oldRange, reviewHunkRange(hunk, "old"))) ||
      Boolean(newRange && rangesOverlap(newRange, reviewHunkRange(hunk, "new")));
    return intersects ? [index] : [];
  });

  // Prefer the declared side's intersecting range even when its first line is collapsed. This
  // matches imported-note placement while strict newly persisted targets remain backed above.
  const preferredRange =
    preferred?.side === "old" ? oldRange : preferred?.side === "new" ? newRange : undefined;
  const backedPreferredHunk = preferred
    ? reviewLineAddress(file, preferred.side, preferred.line)?.hunkIndex
    : undefined;
  const preferredOwner = preferred
    ? file.hunks.findIndex((hunk, index) =>
        preferredRange
          ? rangesOverlap(preferredRange, reviewHunkRange(hunk, preferred.side))
          : backedPreferredHunk === index,
      )
    : -1;
  const ownerHunkIndex =
    preferredOwner >= 0
      ? preferredOwner
      : (intersectingHunkIndices[0] ?? (file.hunks.length > 0 ? 0 : undefined));

  return {
    ...(oldRange ? { oldRange: [...oldRange] as [number, number] } : {}),
    ...(newRange ? { newRange: [...newRange] as [number, number] } : {}),
    ...(preferred ? { preferred: { ...preferred } } : {}),
    intersectingHunkIndices,
    ...(ownerHunkIndex !== undefined ? { ownerHunkIndex } : {}),
  };
}
