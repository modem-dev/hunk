import type { FileDiffMetadata } from "@pierre/diffs";

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

/** Split normalized source into Pierre-compatible lines while retaining final newlines. */
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

    let deletionIndex = deletionStartIndex;
    let additionIndex = additionStartIndex;
    const hunkContent = hunk.hunkContent.map((content) => {
      const adjusted = {
        ...content,
        additionLineIndex: additionIndex,
        deletionLineIndex: deletionIndex,
      };

      if (content.type === "context") {
        for (let offset = 0; offset < content.lines; offset += 1) {
          valid =
            assignSourceLine(
              deletionLineMap,
              metadata.deletionLines,
              fullDeletionLines,
              content.deletionLineIndex + offset,
              deletionIndex + offset,
            ) && valid;
          valid =
            assignSourceLine(
              additionLineMap,
              metadata.additionLines,
              fullAdditionLines,
              content.additionLineIndex + offset,
              additionIndex + offset,
            ) && valid;
        }

        deletionIndex += content.lines;
        additionIndex += content.lines;
      } else {
        for (let offset = 0; offset < content.deletions; offset += 1) {
          valid =
            assignSourceLine(
              deletionLineMap,
              metadata.deletionLines,
              fullDeletionLines,
              content.deletionLineIndex + offset,
              deletionIndex + offset,
            ) && valid;
        }
        for (let offset = 0; offset < content.additions; offset += 1) {
          valid =
            assignSourceLine(
              additionLineMap,
              metadata.additionLines,
              fullAdditionLines,
              content.additionLineIndex + offset,
              additionIndex + offset,
            ) && valid;
        }

        deletionIndex += content.deletions;
        additionIndex += content.additions;
      }

      return adjusted;
    });

    if (
      deletionIndex - deletionStartIndex !== hunk.deletionCount ||
      additionIndex - additionStartIndex !== hunk.additionCount ||
      deletionIndex > fullDeletionLines.length ||
      additionIndex > fullAdditionLines.length
    ) {
      valid = false;
    }

    previousDeletionEnd = deletionIndex;
    previousAdditionEnd = additionIndex;
    finalDeletionEnd = deletionIndex;
    finalAdditionEnd = additionIndex;

    return {
      ...hunk,
      additionLineIndex: additionStartIndex,
      deletionLineIndex: deletionStartIndex,
      hunkContent,
    };
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
