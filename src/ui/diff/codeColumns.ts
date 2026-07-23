import { DEFAULT_TAB_WIDTH, validateTabWidth } from "../../core/tabWidth";
import type { DiffFile, LayoutMode } from "../../core/types";
import { measureTextWidth } from "../lib/text";
import type { DiffRow } from "./pierre";

export const DIFF_RAIL_PREFIX_WIDTH = 1;
export const DIFF_SPLIT_SEPARATOR_WIDTH = 1;

const maxFileCodeLineWidthCache = new WeakMap<DiffFile["metadata"], Map<number, number>>();

/** Expand tabs to the next source-column stop using terminal-cell widths. */
export function expandDiffTabs(text: string, tabWidth = DEFAULT_TAB_WIDTH, initialColumn = 0) {
  if (!text.includes("\t")) {
    return text;
  }

  const resolvedTabWidth = validateTabWidth(tabWidth);
  const segments = text.split("\t");
  let column = Math.max(0, initialColumn);
  let expanded = "";

  for (const [index, segment] of segments.entries()) {
    expanded += segment;
    column += measureTextWidth(segment);

    if (index < segments.length - 1) {
      const spaces = resolvedTabWidth - (column % resolvedTabWidth);
      expanded += " ".repeat(spaces);
      column += spaces;
    }
  }

  return expanded;
}

/** Measure one rendered code line after tab expansion and newline trimming. */
export function measureRenderedCodeLineWidth(
  line: string | undefined,
  tabWidth = DEFAULT_TAB_WIDTH,
) {
  return measureTextWidth(expandDiffTabs((line ?? "").replace(/\n$/, ""), tabWidth));
}

/** Track the widest rendered code line for one file and tab width. */
export function maxFileCodeLineWidth(file: DiffFile, tabWidth = DEFAULT_TAB_WIDTH) {
  const cachedByTabWidth = maxFileCodeLineWidthCache.get(file.metadata);
  const cachedWidth = cachedByTabWidth?.get(tabWidth);
  if (cachedWidth !== undefined) {
    return cachedWidth;
  }

  const deletionLines = file.metadata.deletionLines ?? [];
  const additionLines = file.metadata.additionLines ?? [];

  let maxWidth = 0;

  for (const line of deletionLines) {
    maxWidth = Math.max(maxWidth, measureRenderedCodeLineWidth(line, tabWidth));
  }

  for (const line of additionLines) {
    maxWidth = Math.max(maxWidth, measureRenderedCodeLineWidth(line, tabWidth));
  }

  const nextCachedByTabWidth = cachedByTabWidth ?? new Map<number, number>();
  nextCachedByTabWidth.set(tabWidth, maxWidth);
  if (!cachedByTabWidth) {
    maxFileCodeLineWidthCache.set(file.metadata, nextCachedByTabWidth);
  }
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
