import type { DiffFile } from "../../../core/changeset/model";
import type { LayoutMode } from "../../../core/run/commandInputs";
import { resolveSplitPaneWidths } from "../../diff/codeColumns";
import { planCodeRowLayout } from "../../diff/codeRowLayout";
import {
  renderCodeOnlyPlannedRowText,
  renderDecoratedPlannedRowText,
} from "../../diff/plannedRowText";
import {
  type DiffSectionGeometry,
  type DiffSectionRowBounds,
} from "../../diff/diffSectionGeometry";
import type { CopySelectedRowRange } from "../../lib/diffSpatial";
import type { FileSectionLayout } from "../../lib/fileSectionLayout";
import { fileHeaderStats, fitFileHeaderLabel } from "../../lib/fileHeader";
import { cellRangeToCharRange, measureTextWidth, sliceTextByWidth } from "../../lib/text";
import type { LineCursor } from "../../lib/lineCursors";
import { contextLineStableKeySides, type PlannedReviewRow } from "../../diff/reviewRenderPlan";

export type CopySelectionPoint =
  | {
      kind: "review-row";
      column: number;
      visualRow: number;
    }
  | {
      kind: "pinned-header";
      column: number;
      fileId: string;
      nextVisualRow: number;
    };

// In split layout the drag is anchored to one side of the diff (left = old / A, right = new / B)
// based on the anchor column. In stack layout there is only one column, so side is undefined.
export type CopySelectionSide = "left" | "right";

export interface CopySelectionDrag {
  anchor: CopySelectionPoint;
  focus: CopySelectionPoint;
  moved: boolean;
  /** Double/triple-click expansion always copies, even when its range is within click slop. */
  expanded?: boolean;
}

export interface CopySelectionContext {
  codeHorizontalOffset: number;
  copyDecorations: boolean;
  files: DiffFile[];
  fileSectionLayouts: FileSectionLayout[];
  headerLabelWidth: number;
  headerStatsWidth: number;
  layout: Exclude<LayoutMode, "auto">;
  pinnedHeaderFile?: DiffFile | null;
  reserveAddNoteColumn: boolean;
  sectionGeometry: DiffSectionGeometry[];
  showHunkHeaders: boolean;
  showLineNumbers: boolean;
  width: number;
  wrapLines: boolean;
}

/** Resolve which split side a column belongs to in split layout. */
export function resolveCopySelectionSide(
  column: number,
  layout: Exclude<LayoutMode, "auto">,
  width: number,
): CopySelectionSide | undefined {
  if (layout !== "split") {
    return undefined;
  }
  const { leftWidth } = resolveSplitPaneWidths(width);
  return column < leftWidth ? "left" : "right";
}

/** Clamp one terminal column into the rendered diff body. */
export function clampCopyColumn(column: number, width: number) {
  return Math.min(Math.max(0, column), Math.max(0, width - 1));
}

/** Return whether one row bounds entry owns the requested file-local visual row. */
function rowBoundsContainsVisualRow(bounds: DiffSectionRowBounds, visualRow: number) {
  return bounds.height > 0 && visualRow >= bounds.top && visualRow < bounds.top + bounds.height;
}

// Pinned-header points sort to (nextVisualRow - 1) so they slot right above the first visible
// body row, matching what the user sees at the top of the pane.
function copySelectionSortRow(point: CopySelectionPoint) {
  return point.kind === "pinned-header" ? point.nextVisualRow - 1 : point.visualRow;
}

/** Return the selected body row range, excluding any standalone pinned header row. */
function copySelectionBodyRange(start: CopySelectionPoint, end: CopySelectionPoint) {
  const startRow = start.kind === "pinned-header" ? start.nextVisualRow : start.visualRow;
  const endRow = end.kind === "pinned-header" ? end.nextVisualRow - 1 : end.visualRow;

  return { startRow, endRow };
}

/** Resolve the keyboard line cursor addressed by one un-dragged review-row click. */
export function findLineCursorForClick({
  cursors,
  fileSectionLayouts,
  point,
  sectionGeometry,
  side,
}: {
  cursors: LineCursor[];
  fileSectionLayouts: FileSectionLayout[];
  point: CopySelectionPoint;
  sectionGeometry: DiffSectionGeometry[];
  side?: CopySelectionSide;
}) {
  if (point.kind !== "review-row") {
    return null;
  }

  for (const section of fileSectionLayouts) {
    if (point.visualRow < section.bodyTop || point.visualRow >= section.sectionBottom) {
      continue;
    }

    const geometry = sectionGeometry[section.sectionIndex];
    if (!geometry) {
      return null;
    }

    const bodyRow = point.visualRow - section.bodyTop;
    const bounds = geometry.rowBounds.find((candidate) =>
      rowBoundsContainsVisualRow(candidate, bodyRow),
    );
    if (!bounds) {
      return null;
    }

    const stableKeys = new Set([bounds.stableKey, ...bounds.stableKeys]);
    const rowCursors = cursors.filter(
      (cursor) => cursor.fileId === section.fileId && stableKeys.has(cursor.stableKey),
    );
    if (side === undefined) {
      return rowCursors[0] ?? null;
    }

    const targetSide = side === "left" ? "old" : "new";
    return (
      rowCursors.find((cursor) => cursor.target.side === targetSide) ??
      (contextLineStableKeySides(bounds.stableKey) ? (rowCursors[0] ?? null) : null)
    );
  }

  return null;
}

const COPY_SELECTION_CLICK_SLOP_CELLS = 1;

/** Treat one-cell pointer jitter as a click while preserving deliberate and expanded drags. */
export function copySelectionDragIsClick(drag: CopySelectionDrag) {
  if (drag.expanded) {
    return false;
  }
  if (!drag.moved) {
    return true;
  }
  if (drag.anchor.kind !== drag.focus.kind) {
    return false;
  }

  const columnDelta = Math.abs(drag.anchor.column - drag.focus.column);
  if (columnDelta > COPY_SELECTION_CLICK_SLOP_CELLS) {
    return false;
  }

  if (drag.anchor.kind === "pinned-header" && drag.focus.kind === "pinned-header") {
    return (
      drag.anchor.fileId === drag.focus.fileId &&
      Math.abs(drag.anchor.nextVisualRow - drag.focus.nextVisualRow) <=
        COPY_SELECTION_CLICK_SLOP_CELLS
    );
  }

  return (
    drag.anchor.kind === "review-row" &&
    drag.focus.kind === "review-row" &&
    Math.abs(drag.anchor.visualRow - drag.focus.visualRow) <= COPY_SELECTION_CLICK_SLOP_CELLS
  );
}

/** Return whether two points represent the same selectable terminal cell. */
export function copySelectionPointsEqual(left: CopySelectionPoint, right: CopySelectionPoint) {
  if (left.kind !== right.kind || left.column !== right.column) {
    return false;
  }

  if (left.kind === "pinned-header" && right.kind === "pinned-header") {
    return left.fileId === right.fileId && left.nextVisualRow === right.nextVisualRow;
  }

  return (
    left.kind === "review-row" && right.kind === "review-row" && left.visualRow === right.visualRow
  );
}

/** Return whether two points are on the same selectable terminal row. */
export function copySelectionPointsShareRow(left: CopySelectionPoint, right: CopySelectionPoint) {
  if (left.kind !== right.kind) {
    return false;
  }

  if (left.kind === "pinned-header" && right.kind === "pinned-header") {
    return left.fileId === right.fileId && left.nextVisualRow === right.nextVisualRow;
  }

  return (
    left.kind === "review-row" && right.kind === "review-row" && left.visualRow === right.visualRow
  );
}

/** Order two selection points by terminal row first, then column. */
export function normalizeCopySelectionRange(anchor: CopySelectionPoint, focus: CopySelectionPoint) {
  const anchorRow = copySelectionSortRow(anchor);
  const focusRow = copySelectionSortRow(focus);

  if (anchorRow < focusRow || (anchorRow === focusRow && anchor.column <= focus.column)) {
    return { start: anchor, end: focus };
  }

  return { start: focus, end: anchor };
}

/** Trim padding introduced only to fill fixed terminal cells. */
function trimCopiedLine(line: string) {
  return line.replace(/[ \t]+$/g, "");
}

/** Slice one rendered line by an inclusive terminal-cell range (see cellRangeToCharRange). */
function sliceLineByCells(line: string, startCell: number, endCell: number) {
  const { startIndex, endIndex } = cellRangeToCharRange(line, startCell, endCell);
  return line.slice(startIndex, endIndex);
}

interface CopyVisualLine {
  visualRow: number;
  text: string;
  /** Global terminal column where the locally rendered text starts. */
  globalColumnOffset: number;
  /** Decorated output preserves blank visual lines; code-only output omits them. */
  retainEmpty: boolean;
}

/** Clip one rendered visual line to the selected terminal cells. */
function clipSelectedVisualLine(
  line: CopyVisualLine,
  start: CopySelectionPoint,
  end: CopySelectionPoint,
) {
  const startRow = copySelectionSortRow(start);
  const endRow = copySelectionSortRow(end);
  if (line.visualRow < startRow || line.visualRow > endRow) {
    return null;
  }

  const startColumn =
    line.visualRow === startRow ? Math.max(0, start.column - line.globalColumnOffset) : 0;
  const endColumn =
    line.visualRow === endRow
      ? Math.max(0, end.column - line.globalColumnOffset)
      : Number.MAX_SAFE_INTEGER;
  const copiedLine = trimCopiedLine(sliceLineByCells(line.text, startColumn, endColumn));

  return copiedLine || line.retainEmpty ? copiedLine : null;
}

/** Resolve the global terminal origin for locally rendered planned-row text. */
function resolveCopyVisualLineOffset({
  context,
  copySide,
  lineNumberDigits,
  row,
}: {
  context: CopySelectionContext;
  copySide?: CopySelectionSide;
  lineNumberDigits: number;
  row: PlannedReviewRow;
}) {
  const { copyDecorations, layout, width } = context;
  const splitPaneWidths = layout === "split" ? resolveSplitPaneWidths(width) : null;

  if (copyDecorations) {
    return copySide === "right" && splitPaneWidths ? splitPaneWidths.leftWidth : 0;
  }

  const codeLayout = planCodeRowLayout(row, {
    lineNumberDigits,
    reserveAddNoteColumn: context.reserveAddNoteColumn,
    showLineNumbers: context.showLineNumbers,
    width,
    wrapLines: context.wrapLines,
  });
  if (codeLayout?.kind === "stack") {
    return codeLayout.cell.prefixWidth + codeLayout.cell.gutterWidth;
  }
  if (codeLayout?.kind !== "split" || !copySide) {
    return 0;
  }

  const cell = copySide === "right" ? codeLayout.right : codeLayout.left;
  return (
    (copySide === "right" ? codeLayout.leftPaneWidth : 0) + cell.prefixWidth + cell.gutterWidth
  );
}

/** Return whether a character should be part of a double-click word selection. */
function isCopyWordChar(char: string | undefined) {
  return char !== undefined && /[A-Za-z0-9_$]/.test(char);
}

/** Render one file header as plain text using the same visible columns as DiffFileHeaderRow. */
function renderFileHeaderCopyText({
  file,
  headerLabelWidth,
  headerStatsWidth,
  width,
}: {
  file: DiffFile;
  headerLabelWidth: number;
  headerStatsWidth: number;
  width: number;
}) {
  const statsText = fileHeaderStats(file).text.padStart(headerStatsWidth);
  const { filename, stateLabel } = fitFileHeaderLabel(file, headerLabelWidth);
  const label = `${filename}${stateLabel ?? ""}`;
  // The gap and clamp are measured in cells to mirror DiffFileHeaderRow's space-between flex
  // layout, so wide-character filenames keep the stats columns aligned with the screen.
  const availableGap = Math.max(1, width - 2 - measureTextWidth(label) - statsText.length);
  const headerLine = ` ${label}${" ".repeat(availableGap)}${statsText} `;
  const clamped = sliceTextByWidth(headerLine, 0, width);

  return `${clamped.text}${" ".repeat(Math.max(0, width - clamped.width))}`;
}

// The "pinned-header" point variant is constructed inline by callers that observe a click on the
// pinned-header row directly. This function only resolves coordinates against the scrolling review
// body, so it always returns a "review-row" point (or null when the row is outside the stream).
export function findCopySelectionPoint({
  column,
  copyDecorations,
  fileSectionLayouts,
  sectionGeometry,
  visualRow,
  width,
}: {
  column: number;
  copyDecorations: boolean;
  fileSectionLayouts: FileSectionLayout[];
  sectionGeometry: DiffSectionGeometry[];
  visualRow: number;
  width: number;
}): Extract<CopySelectionPoint, { kind: "review-row" }> | null {
  for (const section of fileSectionLayouts) {
    if (
      copyDecorations &&
      section.headerTop < section.bodyTop &&
      visualRow >= section.headerTop &&
      visualRow < section.bodyTop
    ) {
      return {
        kind: "review-row",
        column: clampCopyColumn(column, width),
        visualRow,
      };
    }

    if (visualRow < section.bodyTop || visualRow >= section.bodyTop + section.bodyHeight) {
      continue;
    }

    const geometry = sectionGeometry[section.sectionIndex];
    if (!geometry) {
      return null;
    }

    const bodyRow = visualRow - section.bodyTop;
    const rowIndex = geometry.rowBounds.findIndex((bounds) =>
      rowBoundsContainsVisualRow(bounds, bodyRow),
    );
    if (rowIndex < 0) {
      return null;
    }

    return {
      kind: "review-row",
      column: clampCopyColumn(column, width),
      visualRow,
    };
  }

  return null;
}

/** Render the selected planned rows into clipboard text. */
export function renderCopySelectionText({
  context,
  end,
  side,
  start,
}: {
  context: CopySelectionContext;
  end: CopySelectionPoint;
  side?: CopySelectionSide;
  start: CopySelectionPoint;
}) {
  const lines: string[] = [];
  const {
    codeHorizontalOffset,
    copyDecorations,
    files,
    fileSectionLayouts,
    headerLabelWidth,
    headerStatsWidth,
    pinnedHeaderFile,
    reserveAddNoteColumn,
    sectionGeometry,
    showHunkHeaders,
    showLineNumbers,
    width,
    wrapLines,
  } = context;

  const copySide =
    side ??
    (context.layout === "split" && start.kind === "review-row"
      ? resolveCopySelectionSide(start.column, context.layout, context.width)
      : undefined);

  if (
    copyDecorations &&
    pinnedHeaderFile &&
    start.kind === "pinned-header" &&
    start.fileId === pinnedHeaderFile.id
  ) {
    const pinnedHeaderLine: CopyVisualLine = {
      visualRow: copySelectionSortRow(start),
      text: renderFileHeaderCopyText({
        file: pinnedHeaderFile,
        headerLabelWidth,
        headerStatsWidth,
        width,
      }),
      globalColumnOffset: 0,
      retainEmpty: true,
    };
    const pinnedHeaderEnd =
      end.kind === "pinned-header" && end.fileId === start.fileId
        ? end
        : { ...end, column: Number.MAX_SAFE_INTEGER };
    const copiedLine = clipSelectedVisualLine(pinnedHeaderLine, start, pinnedHeaderEnd);
    if (copiedLine !== null) {
      lines.push(copiedLine);
    }
  }

  const { startRow, endRow } = copySelectionBodyRange(start, end);

  for (const section of fileSectionLayouts) {
    if (section.sectionBottom <= startRow || section.headerTop > endRow) {
      continue;
    }

    if (
      copyDecorations &&
      section.headerTop < section.bodyTop &&
      section.headerTop >= startRow &&
      section.headerTop <= endRow
    ) {
      const file = files[section.sectionIndex];
      if (file) {
        const line = renderFileHeaderCopyText({
          file,
          headerLabelWidth,
          headerStatsWidth,
          width,
        });
        const copiedLine = clipSelectedVisualLine(
          {
            visualRow: section.headerTop,
            text: line,
            globalColumnOffset: 0,
            retainEmpty: true,
          },
          start,
          end,
        );
        if (copiedLine !== null) {
          lines.push(copiedLine);
        }
      }
    }

    const geometry = sectionGeometry[section.sectionIndex];
    if (!geometry) {
      continue;
    }

    const plannedRows = geometry.plannedRows;

    for (let rowIndex = 0; rowIndex < geometry.rowBounds.length; rowIndex += 1) {
      const rowBounds = geometry.rowBounds[rowIndex]!;
      const row = plannedRows[rowIndex];
      if (!row || rowBounds.height <= 0) {
        continue;
      }

      const rowTop = section.bodyTop + rowBounds.top;
      const rowBottom = rowTop + rowBounds.height;
      if (rowBottom <= startRow || rowTop > endRow) {
        continue;
      }

      const rowTextOptions = {
        codeHorizontalOffset,
        lineNumberDigits: geometry.lineNumberDigits,
        reserveAddNoteColumn,
        showHunkHeaders,
        showLineNumbers,
        side: copySide,
        width,
        wrapLines,
      };
      const renderRowText = copyDecorations
        ? renderDecoratedPlannedRowText
        : renderCodeOnlyPlannedRowText;
      const renderedLines = renderRowText(row, rowTextOptions);

      const globalColumnOffset = resolveCopyVisualLineOffset({
        context,
        copySide,
        lineNumberDigits: geometry.lineNumberDigits,
        row,
      });
      for (const [lineIndex, text] of renderedLines.entries()) {
        const copiedLine = clipSelectedVisualLine(
          {
            visualRow: rowTop + lineIndex,
            text,
            globalColumnOffset,
            retainEmpty: copyDecorations,
          },
          start,
          end,
        );
        if (copiedLine !== null) {
          lines.push(copiedLine);
        }
      }
    }
  }

  return lines.join("\n").replace(/\n+$/g, "");
}

/**
 * Expand a single selection point to word or line boundaries for double/triple-click support.
 *
 * Returns the expanded column range (inclusive, global review-stream columns), or `null` if
 * the row text cannot be resolved.
 */
export function expandSelectionPoint(
  point: Extract<CopySelectionPoint, { kind: "review-row" }>,
  clickCount: 2 | 3,
  context: CopySelectionContext,
): { startCol: number; endCol: number } | null {
  const {
    fileSectionLayouts,
    layout,
    reserveAddNoteColumn,
    sectionGeometry,
    showLineNumbers,
    width,
  } = context;

  // Find the section and row at this visual row.
  for (const section of fileSectionLayouts) {
    if (
      point.visualRow < section.bodyTop ||
      point.visualRow >= section.bodyTop + section.bodyHeight
    ) {
      continue;
    }

    const geometry = sectionGeometry[section.sectionIndex];
    if (!geometry) {
      return null;
    }

    const bodyRow = point.visualRow - section.bodyTop;
    const rowIndex = geometry.rowBounds.findIndex((bounds) =>
      rowBoundsContainsVisualRow(bounds, bodyRow),
    );
    if (rowIndex < 0) {
      return null;
    }

    const row = geometry.plannedRows[rowIndex];
    if (!row) {
      return null;
    }

    if (clickCount === 3 && context.copyDecorations) {
      // Triple-click: select the entire rendered line.
      // In split layout, scope to the side containing the click so triple-click never
      // selects across both panes or resolves to the wrong side for copy/highlight.
      if (layout === "split") {
        const { leftWidth } = resolveSplitPaneWidths(width);
        const clickSide = resolveCopySelectionSide(point.column, layout, width);
        if (clickSide === "right") {
          return { startCol: leftWidth, endCol: width - 1 };
        }
        return { startCol: 0, endCol: Math.max(0, leftWidth - 1) };
      }
      return { startCol: 0, endCol: width - 1 };
    }

    // Double-click: expand to word boundaries within the code content (excluding rail/gutter).
    const side = resolveCopySelectionSide(point.column, layout, width);

    const rowTextOptions = {
      codeHorizontalOffset: context.codeHorizontalOffset,
      lineNumberDigits: geometry.lineNumberDigits,
      reserveAddNoteColumn,
      showHunkHeaders: context.showHunkHeaders,
      showLineNumbers,
      side,
      width,
      wrapLines: context.wrapLines,
    };
    const codeLayout = planCodeRowLayout(row, rowTextOptions);

    // Compute how many global columns the planned prefix and gutter consume so we can convert
    // between code-local and global column spaces.
    let globalContentStart = 0;
    if (codeLayout?.kind === "split") {
      const cell = side === "left" ? codeLayout.left : codeLayout.right;
      globalContentStart =
        (side === "left" ? 0 : codeLayout.leftPaneWidth) + cell.prefixWidth + cell.gutterWidth;
    } else if (codeLayout?.kind === "stack") {
      globalContentStart = codeLayout.cell.prefixWidth + codeLayout.cell.gutterWidth;
    }

    const lineIndex = bodyRow - geometry.rowBounds[rowIndex]!.top;

    // Use code-only text so word detection ignores the rail, line numbers, and diff signs.
    const codeText = renderCodeOnlyPlannedRowText(row, rowTextOptions);

    const lineText = codeText[lineIndex];
    if (lineText === undefined || lineText.length === 0) {
      return null;
    }

    // Column math stays in terminal cells; word detection below walks code units and converts
    // back through cellRangeToCharRange / measureTextWidth.
    const lineWidth = measureTextWidth(lineText);

    if (clickCount === 3) {
      return {
        startCol: globalContentStart,
        // A line of only zero-width characters measures 0 cells; clamp so the range never inverts.
        endCol: globalContentStart + Math.max(0, lineWidth - 1),
      };
    }

    // Convert the global click column to a code-local cell, then resolve the covering cluster.
    const localCell = Math.max(0, Math.min(lineWidth - 1, point.column - globalContentStart));
    const cluster = cellRangeToCharRange(lineText, localCell, localCell);

    // Punctuation and whitespace are separators for word selection; selecting just the clicked
    // separator matches terminal/editor double-click behavior without swallowing code punctuation.
    if (!isCopyWordChar(lineText[cluster.startIndex])) {
      const clusterStartCell = measureTextWidth(lineText.slice(0, cluster.startIndex));
      const clusterWidth = Math.max(
        1,
        measureTextWidth(lineText.slice(cluster.startIndex, cluster.endIndex)),
      );
      return {
        startCol: clusterStartCell + globalContentStart,
        endCol: clusterStartCell + clusterWidth - 1 + globalContentStart,
      };
    }

    let wordStart = cluster.startIndex;
    let wordEnd = cluster.startIndex;

    // Expand left to word start.
    while (wordStart > 0 && isCopyWordChar(lineText[wordStart - 1])) {
      wordStart -= 1;
    }
    // Expand right to word end (exclusive).
    while (wordEnd < lineText.length && isCopyWordChar(lineText[wordEnd])) {
      wordEnd += 1;
    }

    // Convert the code-unit word bounds back to cell columns. wordEnd is exclusive (one past
    // the last char), so the inclusive endCol is the width through wordEnd minus one.
    return {
      startCol: globalContentStart + measureTextWidth(lineText.slice(0, wordStart)),
      endCol: globalContentStart + measureTextWidth(lineText.slice(0, wordEnd)) - 1,
    };
  }

  return null;
}

/** Build file-local row key ranges for the visible copy-selection highlight. */
export function buildCopySelectedRowKeys({
  drag,
  fileSectionLayouts,
  sectionGeometry,
  width,
}: {
  drag: CopySelectionDrag | null;
  fileSectionLayouts: FileSectionLayout[];
  sectionGeometry: DiffSectionGeometry[];
  /** Diff content width, used as the full-width range value for middle rows. */
  width: number;
}) {
  const selected = new Map<string, Map<string, CopySelectedRowRange>>();
  if (!drag?.moved) {
    return selected;
  }

  const { start, end } = normalizeCopySelectionRange(drag.anchor, drag.focus);
  const { startRow, endRow } = copySelectionBodyRange(start, end);
  for (const section of fileSectionLayouts) {
    if (section.bodyTop + section.bodyHeight <= startRow || section.bodyTop > endRow) {
      continue;
    }

    const geometry = sectionGeometry[section.sectionIndex];
    if (!geometry) {
      continue;
    }

    for (const rowBounds of geometry.rowBounds) {
      const rowTop = section.bodyTop + rowBounds.top;
      const rowBottom = rowTop + rowBounds.height;
      if (rowBounds.height <= 0 || rowBottom <= startRow || rowTop > endRow) {
        continue;
      }

      // A row crossing either inclusive selection boundary inherits that boundary's column.
      // Otherwise the row is selected across the full content width.
      const rangeStartCol = rowTop <= startRow ? start.column : 0;
      const rangeEndCol = rowBottom > endRow ? end.column : width - 1;

      const fileRows = selected.get(section.fileId) ?? new Map<string, CopySelectedRowRange>();
      fileRows.set(rowBounds.key, { startCol: rangeStartCol, endCol: rangeEndCol });
      selected.set(section.fileId, fileRows);
    }
  }

  return selected;
}
