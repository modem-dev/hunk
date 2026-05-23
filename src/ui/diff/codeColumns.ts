import type { DiffFile, LayoutMode } from "../../core/types";
import { measureTextWidth } from "../lib/text";
import type { DiffRow } from "./pierre";

export const DIFF_CODE_TAB_WIDTH = 2;
export const DIFF_RAIL_PREFIX_WIDTH = 1;
export const DIFF_SPLIT_SEPARATOR_WIDTH = 1;

const maxFileCodeLineWidthCache = new WeakMap<DiffFile["metadata"], number>();

/** Expand tabs the same way the diff renderer does before measuring visible columns. */
export function expandDiffTabs(text: string) {
  return text.replaceAll("\t", " ".repeat(DIFF_CODE_TAB_WIDTH));
}

/** Measure one rendered code line after tab expansion and newline trimming. */
export function measureRenderedCodeLineWidth(line: string | undefined) {
  return measureTextWidth(expandDiffTabs((line ?? "").replace(/\n$/, "")));
}

/** Track the widest rendered code line for one file. */
export function maxFileCodeLineWidth(file: DiffFile) {
  const cachedWidth = maxFileCodeLineWidthCache.get(file.metadata);
  if (cachedWidth !== undefined) {
    return cachedWidth;
  }

  const deletionLines = file.metadata.deletionLines ?? [];
  const additionLines = file.metadata.additionLines ?? [];

  let maxWidth = 0;

  for (const line of deletionLines) {
    maxWidth = Math.max(maxWidth, measureRenderedCodeLineWidth(line));
  }

  for (const line of additionLines) {
    maxWidth = Math.max(maxWidth, measureRenderedCodeLineWidth(line));
  }

  maxFileCodeLineWidthCache.set(file.metadata, maxWidth);
  return maxWidth;
}

/** Find the widest line-number gutter needed for one file. */
export function findMaxLineNumber(file: DiffFile) {
  let highest = 0;

  for (const hunk of file.metadata.hunks) {
    highest = Math.max(
      highest,
      hunk.deletionStart + hunk.deletionCount,
      hunk.additionStart + hunk.additionCount,
    );
  }

  return Math.max(highest, 1);
}

/** Find the widest line-number gutter needed for an already-expanded row stream. */
export function findMaxLineNumberInRows(rows: Iterable<DiffRow>, fallback = 1) {
  let highest = fallback;

  for (const row of rows) {
    if (row.type === "collapsed") {
      highest = Math.max(highest, row.oldRange[1], row.newRange[1]);
      continue;
    }

    if (row.type === "split-line") {
      highest = Math.max(highest, row.left.lineNumber ?? 0, row.right.lineNumber ?? 0);
      continue;
    }

    if (row.type === "stack-line") {
      highest = Math.max(highest, row.cell.oldLineNumber ?? 0, row.cell.newLineNumber ?? 0);
    }
  }

  return Math.max(highest, 1);
}

/** Split-view panes reserve one rail column on the left and one separator column in the middle. */
export function resolveSplitPaneWidths(width: number) {
  const usableWidth = Math.max(0, width - DIFF_RAIL_PREFIX_WIDTH - DIFF_SPLIT_SEPARATOR_WIDTH);
  const leftWidth = Math.max(0, DIFF_RAIL_PREFIX_WIDTH + Math.floor(usableWidth / 2));
  const rightWidth = Math.max(
    0,
    DIFF_SPLIT_SEPARATOR_WIDTH + usableWidth - Math.floor(usableWidth / 2),
  );

  return { leftWidth, rightWidth };
}

/** Resolve the split-cell gutter and code viewport after the rail prefix. */
export function resolveSplitCellGeometry(
  width: number,
  lineNumberDigits: number,
  showLineNumbers: boolean,
  prefixWidth = DIFF_RAIL_PREFIX_WIDTH,
) {
  const availableWidth = Math.max(0, width - prefixWidth);
  const gutterWidth = Math.min(availableWidth, showLineNumbers ? lineNumberDigits + 3 : 2);

  return {
    gutterWidth,
    contentWidth: Math.max(0, availableWidth - gutterWidth),
  };
}

/** Resolve the stack-cell gutter and code viewport after the left rail prefix. */
export function resolveStackCellGeometry(
  width: number,
  lineNumberDigits: number,
  showLineNumbers: boolean,
  prefixWidth = DIFF_RAIL_PREFIX_WIDTH,
) {
  const availableWidth = Math.max(0, width - prefixWidth);
  const gutterWidth = Math.min(availableWidth, showLineNumbers ? lineNumberDigits * 2 + 5 : 2);

  return {
    gutterWidth,
    contentWidth: Math.max(0, availableWidth - gutterWidth),
  };
}

/** Clamp horizontal reveal against the narrowest code viewport in the active layout. */
export function resolveCodeViewportWidth(
  layout: Exclude<LayoutMode, "auto">,
  width: number,
  lineNumberDigits: number,
  showLineNumbers: boolean,
) {
  if (layout === "split") {
    const { leftWidth, rightWidth } = resolveSplitPaneWidths(width);
    return Math.min(
      resolveSplitCellGeometry(leftWidth, lineNumberDigits, showLineNumbers).contentWidth,
      resolveSplitCellGeometry(rightWidth, lineNumberDigits, showLineNumbers).contentWidth,
    );
  }

  return resolveStackCellGeometry(width, lineNumberDigits, showLineNumbers).contentWidth;
}
