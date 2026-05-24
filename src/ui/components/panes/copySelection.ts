import type { DiffFile, LayoutMode } from "../../../core/types";
import {
  DIFF_RAIL_PREFIX_WIDTH,
  resolveSplitCellGeometry,
  resolveSplitPaneWidths,
  resolveStackCellGeometry,
} from "../../diff/codeColumns";
import { renderCodeOnlyPlannedRowText, renderDecoratedPlannedRowText } from "../../diff/renderRows";
import {
  type DiffSectionGeometry,
  type DiffSectionRowBounds,
} from "../../diff/diffSectionGeometry";
import type { FileSectionLayout } from "../../lib/fileSectionLayout";
import { fileLabelParts } from "../../lib/files";
import { fitText } from "../../lib/text";
import type { AppTheme } from "../../themes";

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
  sectionGeometry: DiffSectionGeometry[];
  showHunkHeaders: boolean;
  showLineNumbers: boolean;
  theme: AppTheme;
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
  const additionsText = `+${file.stats.additions}${file.statsTruncated ? "+" : ""}`;
  const deletionsText = `-${file.stats.deletions}`;
  const statsText = `${additionsText} ${deletionsText}`.padStart(headerStatsWidth);
  const { filename, stateLabel } = fileLabelParts(file);
  const label = `${fitText(
    filename,
    Math.max(1, headerLabelWidth - (stateLabel?.length ?? 0)),
  )}${stateLabel ?? ""}`;
  const availableGap = Math.max(1, width - 2 - label.length - statsText.length);

  return ` ${label}${" ".repeat(availableGap)}${statsText} `.slice(0, width).padEnd(width);
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
    sectionGeometry,
    showHunkHeaders,
    showLineNumbers,
    theme,
    width,
    wrapLines,
  } = context;

  if (
    copyDecorations &&
    pinnedHeaderFile &&
    start.kind === "pinned-header" &&
    start.fileId === pinnedHeaderFile.id
  ) {
    const line = renderFileHeaderCopyText({
      file: pinnedHeaderFile,
      headerLabelWidth,
      headerStatsWidth,
      width,
    });
    const endColumn =
      end.kind === "pinned-header" && end.fileId === start.fileId
        ? end.column
        : Math.max(0, line.length - 1);
    lines.push(trimCopiedLine(line.slice(start.column, endColumn + 1)));
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
        const startColumn =
          start.kind === "review-row" && section.headerTop === start.visualRow ? start.column : 0;
        const endColumn =
          end.kind === "review-row" && section.headerTop === end.visualRow
            ? end.column
            : Math.max(0, line.length - 1);
        lines.push(trimCopiedLine(line.slice(startColumn, endColumn + 1)));
      }
    }

    const geometry = sectionGeometry[section.sectionIndex];
    if (!geometry) {
      continue;
    }

    const copySide =
      side ??
      (context.layout === "split" && start.kind === "review-row"
        ? resolveCopySelectionSide(start.column, context.layout, context.width)
        : undefined);

    for (let rowIndex = 0; rowIndex < geometry.rowBounds.length; rowIndex += 1) {
      const rowBounds = geometry.rowBounds[rowIndex]!;
      const row = geometry.plannedRows[rowIndex];
      if (!row || rowBounds.height <= 0) {
        continue;
      }

      const rowTop = section.bodyTop + rowBounds.top;
      const rowBottom = rowTop + rowBounds.height;
      if (rowBottom <= startRow || rowTop > endRow) {
        continue;
      }

      const renderRowText = copyDecorations
        ? renderDecoratedPlannedRowText
        : renderCodeOnlyPlannedRowText;
      const renderedLines = renderRowText(row, {
        codeHorizontalOffset,
        lineNumberDigits: geometry.lineNumberDigits,
        showHunkHeaders,
        showLineNumbers,
        side: copySide,
        theme,
        width,
        wrapLines,
      });

      if (!copyDecorations) {
        const codeColumnOffset =
          row.kind === "diff-row" && row.row.type === "stack-line"
            ? DIFF_RAIL_PREFIX_WIDTH +
              resolveStackCellGeometry(
                width,
                geometry.lineNumberDigits,
                showLineNumbers,
                DIFF_RAIL_PREFIX_WIDTH,
              ).gutterWidth
            : row.kind === "diff-row" && row.row.type === "split-line" && copySide
              ? (copySide === "right" ? resolveSplitPaneWidths(width).leftWidth : 0) +
                DIFF_RAIL_PREFIX_WIDTH +
                resolveSplitCellGeometry(
                  copySide === "right"
                    ? width - resolveSplitPaneWidths(width).leftWidth
                    : resolveSplitPaneWidths(width).leftWidth,
                  geometry.lineNumberDigits,
                  showLineNumbers,
                  DIFF_RAIL_PREFIX_WIDTH,
                ).gutterWidth
              : 0;

        for (let lineIndex = 0; lineIndex < renderedLines.length; lineIndex += 1) {
          const lineVisualRow = rowTop + lineIndex;
          if (lineVisualRow < startRow || lineVisualRow > endRow) {
            continue;
          }

          const line = renderedLines[lineIndex] ?? "";
          const startColumn =
            start.kind === "review-row" && lineVisualRow === start.visualRow
              ? Math.max(0, start.column - codeColumnOffset)
              : 0;
          const endColumn =
            end.kind === "review-row" && lineVisualRow === end.visualRow
              ? Math.min(Math.max(0, line.length - 1), Math.max(0, end.column - codeColumnOffset))
              : Math.max(0, line.length - 1);
          const copiedLine = trimCopiedLine(line.slice(startColumn, endColumn + 1));
          if (copiedLine) {
            lines.push(copiedLine);
          }
        }
        continue;
      }

      // In split layout, `side` selects which pane text to render via
      // renderDecoratedPlannedRowText. The returned lines start at the pane boundary,
      // not at global column 0. Global column values from the selection points must be
      // adjusted by subtracting the left-pane offset when side="right" so the slice
      // aligns with the actual rendered string.
      const paneOffset =
        copySide === "right" && context.layout === "split"
          ? resolveSplitPaneWidths(context.width).leftWidth
          : 0;

      for (let lineIndex = 0; lineIndex < renderedLines.length; lineIndex += 1) {
        const lineVisualRow = rowTop + lineIndex;
        if (lineVisualRow < startRow || lineVisualRow > endRow) {
          continue;
        }

        const line = renderedLines[lineIndex] ?? "";
        const startColumn =
          start.kind === "review-row" && lineVisualRow === start.visualRow
            ? Math.max(0, start.column - paneOffset)
            : 0;
        const endColumn =
          end.kind === "review-row" && lineVisualRow === end.visualRow
            ? Math.min(Math.max(0, line.length - 1), Math.max(0, end.column - paneOffset))
            : Math.max(0, line.length - 1);
        lines.push(trimCopiedLine(line.slice(startColumn, endColumn + 1)));
      }
    }
  }

  return lines.join("\n").replace(/\n+$/g, "");
}

export interface CopySelectedRowRange {
  /** Global column where the selection starts on this row. */
  startCol: number;
  /** Global column where the selection ends on this row (inclusive). */
  endCol: number;
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
  const { fileSectionLayouts, layout, sectionGeometry, showLineNumbers, width } = context;

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

    // Compute how many global columns the prefix and gutter consume so we can convert between
    // code-local and global column spaces.
    let globalContentStart: number;
    if (layout === "split") {
      const { leftWidth } = resolveSplitPaneWidths(width);
      const paneOffset = side === "left" ? 0 : leftWidth;
      const paneWidth = side === "left" ? leftWidth : width - leftWidth;
      const { gutterWidth } = resolveSplitCellGeometry(
        paneWidth,
        geometry.lineNumberDigits,
        showLineNumbers,
        DIFF_RAIL_PREFIX_WIDTH,
      );
      globalContentStart = paneOffset + DIFF_RAIL_PREFIX_WIDTH + gutterWidth;
    } else {
      const { gutterWidth } = resolveStackCellGeometry(
        width,
        geometry.lineNumberDigits,
        showLineNumbers,
        DIFF_RAIL_PREFIX_WIDTH,
      );
      globalContentStart = DIFF_RAIL_PREFIX_WIDTH + gutterWidth;
    }

    const lineIndex = bodyRow - geometry.rowBounds[rowIndex]!.top;

    // Use code-only text so word detection ignores the rail, line numbers, and diff signs.
    const codeText = renderCodeOnlyPlannedRowText(row, {
      codeHorizontalOffset: context.codeHorizontalOffset,
      lineNumberDigits: geometry.lineNumberDigits,
      showHunkHeaders: context.showHunkHeaders,
      showLineNumbers,
      side,
      theme: context.theme,
      width,
      wrapLines: context.wrapLines,
    });

    const lineText = codeText[lineIndex];
    if (lineText === undefined || lineText.length === 0) {
      return null;
    }

    if (clickCount === 3) {
      return {
        startCol: globalContentStart,
        endCol: globalContentStart + lineText.length - 1,
      };
    }

    // Convert the global click column to a code-local column.
    const localCol = Math.max(0, Math.min(lineText.length - 1, point.column - globalContentStart));

    // Punctuation and whitespace are separators for word selection; selecting just the clicked
    // separator matches terminal/editor double-click behavior without swallowing code punctuation.
    if (!isCopyWordChar(lineText[localCol])) {
      return {
        startCol: localCol + globalContentStart,
        endCol: localCol + globalContentStart,
      };
    }

    let wordStart = localCol;
    let wordEnd = localCol;

    // Expand left to word start.
    while (wordStart > 0 && isCopyWordChar(lineText[wordStart - 1])) {
      wordStart -= 1;
    }
    // Expand right to word end (exclusive).
    while (wordEnd < lineText.length && isCopyWordChar(lineText[wordEnd])) {
      wordEnd += 1;
    }

    // Convert back to global columns. wordEnd is exclusive (one past last char),
    // so endCol = wordEnd - 1 is inclusive.
    return {
      startCol: wordStart + globalContentStart,
      endCol: wordEnd - 1 + globalContentStart,
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

      // Determine the global column range for this planned row.
      // For unwrapped rows (height=1) this is straightforward.
      // For wrapped rows (height>1) the same row key spans multiple visual rows;
      // we use the visual row that overlaps the selection boundary to decide.
      const rowLastVisualRow = rowBottom - 1;
      let rangeStartCol: number;
      let rangeEndCol: number;

      if (rowTop >= startRow && rowLastVisualRow <= endRow) {
        // Row is fully inside the selection range.
        rangeStartCol = rowTop === startRow ? start.column : 0;
        rangeEndCol = rowLastVisualRow === endRow ? end.column : width - 1;
      } else if (rowTop <= startRow && rowLastVisualRow >= startRow && rowLastVisualRow <= endRow) {
        // Row starts above the selection and the last visual row is within it.
        rangeStartCol = start.column;
        rangeEndCol = rowLastVisualRow === endRow ? end.column : width - 1;
      } else if (rowTop >= startRow && rowTop <= endRow && rowLastVisualRow >= endRow) {
        // Row starts within the selection and extends past it.
        rangeStartCol = rowTop === startRow ? start.column : 0;
        rangeEndCol = end.column;
      } else {
        // Row spans across the entire selection (starts above, ends below).
        rangeStartCol = start.column;
        rangeEndCol = end.column;
      }

      const fileRows = selected.get(section.fileId) ?? new Map<string, CopySelectedRowRange>();
      fileRows.set(rowBounds.key, { startCol: rangeStartCol, endCol: rangeEndCol });
      selected.set(section.fileId, fileRows);
    }
  }

  return selected;
}
