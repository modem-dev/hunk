import type { FileDiffMetadata } from "@pierre/diffs";
import { rebaseReviewHunk } from "../../core/review/geometry";

/** Metadata plus index maps for highlighting a partial diff against authoritative source text. */
export interface SourceBackedHighlightPlan {
  metadata: FileDiffMetadata;
  deletionLineMap: number[];
  additionLineMap: number[];
}

interface HighlightLineArrays<T> {
  deletionLines: Array<T | undefined>;
  additionLines: Array<T | undefined>;
}

/**
 * Split normalized source into Pierre-compatible lines while retaining final newlines.
 *
 * Deliberately not `normalizedReviewSourceLines`: that one addresses lines, dropping the
 * separators, while the highlighter compares these lines against the patch's own line
 * strings, which keep their trailing newline.
 */
function splitSourceLines(text: string) {
  const normalized = text.replaceAll("\r\n", "\n");
  const lines: string[] = [];
  let start = 0;

  while (start < normalized.length) {
    const newline = normalized.indexOf("\n", start);
    if (newline < 0) {
      lines.push(normalized.slice(start));
      break;
    }

    lines.push(normalized.slice(start, newline + 1));
    start = newline + 1;
  }

  return lines;
}

/** Convert a unified-diff side start into a zero-based source insertion/line index. */
function sourceStartIndex(start: number, count: number) {
  return count === 0 ? start : Math.max(start - 1, 0);
}

/** Assign one validated partial-line index to its corresponding full-source index. */
function assignSourceLine(
  map: number[],
  partialLines: string[],
  fullLines: string[],
  partialIndex: number,
  fullIndex: number,
) {
  if (
    partialIndex < 0 ||
    partialIndex >= partialLines.length ||
    fullIndex < 0 ||
    fullIndex >= fullLines.length ||
    partialLines[partialIndex] !== fullLines[fullIndex]
  ) {
    return false;
  }

  const existing = map[partialIndex];
  if (existing !== undefined && existing >= 0 && existing !== fullIndex) {
    return false;
  }

  map[partialIndex] = fullIndex;
  return true;
}

/** Return whether every partial line received an authoritative source mapping. */
function mapIsComplete(map: number[]) {
  for (let index = 0; index < map.length; index += 1) {
    if (!Number.isInteger(map[index]) || (map[index] ?? -1) < 0) {
      return false;
    }
  }

  return true;
}

/**
 * Build highlight-only full-source metadata while preserving the original partial diff's hunks.
 * Returns null when a source snapshot cannot be proven to match every visible patch line.
 */
export function createSourceBackedHighlightPlan(
  metadata: FileDiffMetadata,
  oldText: string | null,
  newText: string | null,
): SourceBackedHighlightPlan | null {
  if (!metadata.isPartial || metadata.hunks.length === 0) {
    return null;
  }

  if (
    (oldText === null && metadata.type !== "new") ||
    (newText === null && metadata.type !== "deleted")
  ) {
    return null;
  }

  const fullDeletionLines = splitSourceLines(oldText ?? "");
  const fullAdditionLines = splitSourceLines(newText ?? "");
  const deletionLineMap = Array.from({ length: metadata.deletionLines.length }, () => -1);
  const additionLineMap = Array.from({ length: metadata.additionLines.length }, () => -1);
  let previousDeletionEnd = 0;
  let previousAdditionEnd = 0;
  let finalDeletionEnd = 0;
  let finalAdditionEnd = 0;
  let valid = true;

  const hunks = metadata.hunks.map((hunk) => {
    const deletionStartIndex = sourceStartIndex(hunk.deletionStart, hunk.deletionCount);
    const additionStartIndex = sourceStartIndex(hunk.additionStart, hunk.additionCount);

    if (
      (oldText !== null && deletionStartIndex - previousDeletionEnd !== hunk.collapsedBefore) ||
      (newText !== null && additionStartIndex - previousAdditionEnd !== hunk.collapsedBefore)
    ) {
      valid = false;
    }

    // The shared rebase walks the hunk's blocks onto full-source origins; pairing each
    // rebased block with its patch-local original is what the line maps are built from.
    const rebased = rebaseReviewHunk(hunk, {
      deletionLineIndex: deletionStartIndex,
      additionLineIndex: additionStartIndex,
    });

    hunk.hunkContent.forEach((content, blockIndex) => {
      const target = rebased.hunk.hunkContent[blockIndex]!;
      const deletions = content.type === "context" ? content.lines : content.deletions;
      const additions = content.type === "context" ? content.lines : content.additions;

      for (let offset = 0; offset < deletions; offset += 1) {
        valid =
          assignSourceLine(
            deletionLineMap,
            metadata.deletionLines,
            fullDeletionLines,
            content.deletionLineIndex + offset,
            target.deletionLineIndex + offset,
          ) && valid;
      }
      for (let offset = 0; offset < additions; offset += 1) {
        valid =
          assignSourceLine(
            additionLineMap,
            metadata.additionLines,
            fullAdditionLines,
            content.additionLineIndex + offset,
            target.additionLineIndex + offset,
          ) && valid;
      }
    });

    if (
      rebased.deletionEndIndex - deletionStartIndex !== hunk.deletionCount ||
      rebased.additionEndIndex - additionStartIndex !== hunk.additionCount ||
      rebased.deletionEndIndex > fullDeletionLines.length ||
      rebased.additionEndIndex > fullAdditionLines.length
    ) {
      valid = false;
    }

    previousDeletionEnd = rebased.deletionEndIndex;
    previousAdditionEnd = rebased.additionEndIndex;
    finalDeletionEnd = rebased.deletionEndIndex;
    finalAdditionEnd = rebased.additionEndIndex;

    return rebased.hunk;
  });

  if (!valid || !mapIsComplete(deletionLineMap) || !mapIsComplete(additionLineMap)) {
    return null;
  }

  return {
    metadata: {
      ...metadata,
      isPartial: false,
      deletionLines: fullDeletionLines.slice(0, finalDeletionEnd),
      additionLines: fullAdditionLines.slice(0, finalAdditionEnd),
      hunks,
    },
    deletionLineMap,
    additionLineMap,
  };
}

/** Remap full-source highlighted lines onto the original partial metadata indexes. */
export function remapSourceBackedHighlight<T>(
  plan: SourceBackedHighlightPlan,
  highlighted: HighlightLineArrays<T>,
): HighlightLineArrays<T> {
  return {
    deletionLines: plan.deletionLineMap.map(
      (sourceIndex) => highlighted.deletionLines[sourceIndex],
    ),
    additionLines: plan.additionLineMap.map(
      (sourceIndex) => highlighted.additionLines[sourceIndex],
    ),
  };
}
