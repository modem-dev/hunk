import type { FileDiffMetadata } from "@pierre/diffs";

interface HighlightLineArrays<T> {
  deletionLines: Array<T | undefined>;
  additionLines: Array<T | undefined>;
}

/**
 * Reuse addition-side patch context on both sides when no authoritative source plan exists.
 *
 * Patch fragments cannot prove the independent lexical states before a visible hunk. Sharing the
 * addition-side result preserves the terminal's established rendering policy and lets HAST callers
 * reuse one flattened span result for identical context.
 */
export function aliasContextHighlightLines<T>(
  metadata: FileDiffMetadata,
  highlighted: HighlightLineArrays<T>,
) {
  for (const hunk of metadata.hunks) {
    let deletionLineIndex = hunk.deletionLineIndex;
    let additionLineIndex = hunk.additionLineIndex;

    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let offset = 0; offset < content.lines; offset += 1) {
          const sharedLine =
            highlighted.additionLines[additionLineIndex + offset] ??
            highlighted.deletionLines[deletionLineIndex + offset];

          if (!sharedLine) {
            continue;
          }

          highlighted.deletionLines[deletionLineIndex + offset] = sharedLine;
          highlighted.additionLines[additionLineIndex + offset] = sharedLine;
        }

        deletionLineIndex += content.lines;
        additionLineIndex += content.lines;
        continue;
      }

      deletionLineIndex += content.deletions;
      additionLineIndex += content.additions;
    }
  }

  return highlighted;
}
