import type { FileDiffMetadata } from "@pierre/diffs";
import type { DiffFile, LayoutMode } from "../../core/types";

/** Count hidden unchanged lines after the final visible hunk when Pierre omits them. */
function trailingCollapsedLines(metadata: FileDiffMetadata) {
  const lastHunk = metadata.hunks.at(-1);
  if (!lastHunk || metadata.isPartial) {
    return 0;
  }

  const additionRemaining =
    metadata.additionLines.length - (lastHunk.additionLineIndex + lastHunk.additionCount);
  const deletionRemaining =
    metadata.deletionLines.length - (lastHunk.deletionLineIndex + lastHunk.deletionCount);

  if (additionRemaining !== deletionRemaining) {
    return 0;
  }

  return Math.max(additionRemaining, 0);
}

/** Count render rows for one hunk when wrapping and note cards are off. */
function estimateHunkRows(
  file: DiffFile,
  layout: Exclude<LayoutMode, "auto">,
  showHunkHeaders: boolean,
  hunkIndex: number,
) {
  const hunk = file.metadata.hunks[hunkIndex];
  if (!hunk) {
    return 0;
  }

  let rows = 0;

  if (hunk.collapsedBefore > 0) {
    rows += 1;
  }

  if (showHunkHeaders) {
    rows += 1;
  }

  for (const content of hunk.hunkContent) {
    if (content.type === "context") {
      rows += content.lines;
      continue;
    }

    rows +=
      layout === "split"
        ? Math.max(content.deletions, content.additions)
        : content.deletions + content.additions;
  }

  return rows;
}

/** Estimate the number of diff-body rows for one file when wrapping and note cards are off. */
export function estimateDiffBodyRows(
  file: DiffFile,
  layout: Exclude<LayoutMode, "auto">,
  showHunkHeaders: boolean,
) {
  if (file.metadata.hunks.length === 0) {
    return 1;
  }

  let rows = 0;

  for (const [hunkIndex] of file.metadata.hunks.entries()) {
    rows += estimateHunkRows(file, layout, showHunkHeaders, hunkIndex);
  }

  if (trailingCollapsedLines(file.metadata) > 0) {
    rows += 1;
  }

  return rows;
}

/** Estimate the body-row offset for the anchor that should represent the selected hunk. */
export function estimateHunkAnchorRow(
  file: DiffFile,
  layout: Exclude<LayoutMode, "auto">,
  showHunkHeaders: boolean,
  hunkIndex: number,
) {
  if (file.metadata.hunks.length === 0) {
    return 0;
  }

  const clampedHunkIndex = Math.max(0, Math.min(hunkIndex, file.metadata.hunks.length - 1));
  let rows = 0;

  for (let index = 0; index < clampedHunkIndex; index += 1) {
    rows += estimateHunkRows(file, layout, showHunkHeaders, index);
  }

  const selectedHunk = file.metadata.hunks[clampedHunkIndex]!;
  if (selectedHunk.collapsedBefore > 0) {
    rows += 1;
  }

  return rows;
}
