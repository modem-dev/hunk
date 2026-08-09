import type { ReviewFileV1 } from "./types";

/** Resolve one renderer-neutral collapsed-gap address from canonical hunk content. */
export function reviewGapAddress(file: ReviewFileV1, gapId: string) {
  const match = /^(before|trailing):(\d+)$/.exec(gapId);
  if (!match) return undefined;
  const position = match[1]!;
  const hunkIndex = Number(match[2]);
  const hunk = file.hunks[hunkIndex];
  if (!hunk || !Number.isSafeInteger(hunkIndex)) return undefined;
  if (position === "before") {
    const count = hunk.collapsedBefore;
    if (count <= 0) return undefined;
    // A zero-count side addresses the insertion boundary itself, while a side with
    // changed rows starts after its leading collapsed context.
    const oldEnd = hunk.deletionStart - (hunk.deletionCount > 0 ? 1 : 0);
    const newEnd = hunk.additionStart - (hunk.additionCount > 0 ? 1 : 0);
    const oldStart = oldEnd - count + 1;
    const newStart = newEnd - count + 1;
    if (oldStart <= 0 || newStart <= 0) return undefined;
    return {
      oldRange: [oldStart, oldEnd] as const,
      newRange: [newStart, newEnd] as const,
    };
  }
  if (hunkIndex !== file.hunks.length - 1 || file.flags.partial) return undefined;
  const oldStart = hunk.deletionStart + Math.max(1, hunk.deletionCount);
  const newStart = hunk.additionStart + Math.max(1, hunk.additionCount);
  const oldCount = file.deletionLines.length - oldStart + 1;
  const newCount = file.additionLines.length - newStart + 1;
  if (oldCount <= 0 || oldCount !== newCount) return undefined;
  return {
    oldRange: [oldStart, oldStart + oldCount - 1] as const,
    newRange: [newStart, newStart + newCount - 1] as const,
  };
}
