/** Plans canonical terminal geometry and height for code rows. */
import type { AppTheme } from "../themes/types";
import {
  resolveSplitCellGeometry,
  resolveSplitPaneWidths,
  resolveStackCellGeometry,
} from "./codeColumns";
import { CODE_ROW_ADD_NOTE_BADGE_WIDTH } from "./codeRowAffordance";
import type { DiffRow, RenderSpan } from "./diffRowModel";
import type { PlannedReviewRow } from "./reviewRenderPlan";
import { measureWrappedSpansLineCount } from "./styledSpanLayout";

/** Planned review row that carries one terminal diff row. */
export type PlannedDiffReviewRow = Extract<PlannedReviewRow, { kind: "diff-row" }>;

/** Concrete width and wrapping decisions for one rendered code cell. */
export interface CodeCellLayoutPlan {
  width: number;
  prefixWidth: number;
  gutterWidth: number;
  contentWidth: number;
  wrappedLineCount: number;
}

/** Inputs that affect the terminal columns reserved by one code row. */
export interface CodeRowLayoutOptions {
  width: number;
  lineNumberDigits: number;
  showLineNumbers: boolean;
  wrapLines: boolean;
  reserveAddNoteColumn?: boolean;
  showAddNoteBadge?: boolean;
}

/** Concrete split or stack layout used to measure, copy, and paint one planned code row. */
export type CodeRowLayoutPlan =
  | {
      kind: "split";
      left: CodeCellLayoutPlan;
      right: CodeCellLayoutPlan;
      leftPaneWidth: number;
      rightPaneWidth: number;
      noteGuideSide?: "old" | "new";
      trailingGuideWidth: number;
      addNoteBadgeWidth: number;
      wrappedLineCount: number;
    }
  | {
      kind: "stack";
      cell: CodeCellLayoutPlan;
      noteGuideSide?: "old" | "new";
      trailingGuideWidth: number;
      addNoteBadgeWidth: number;
      wrappedLineCount: number;
    };

/** Plan one cell from its concrete outer width, prefix, gutter, and wrapping policy. */
function planCodeCellLayout(
  spans: RenderSpan[],
  width: number,
  prefixWidth: number,
  gutterWidth: number,
  wrapLines: boolean,
): CodeCellLayoutPlan {
  const contentWidth = Math.max(0, width - prefixWidth - gutterWidth);
  let measuredWrappedLineCount: number | undefined;
  return {
    width,
    prefixWidth,
    gutterWidth,
    contentWidth,
    get wrappedLineCount() {
      measuredWrappedLineCount ??= wrapLines
        ? measureWrappedSpansLineCount(spans, contentWidth)
        : 1;
      return measuredWrappedLineCount;
    },
  };
}

/** Plan all width-sensitive terminal geometry for one complete planned code row. */
export function planCodeRowLayout(
  plannedRow: PlannedReviewRow,
  {
    width,
    lineNumberDigits,
    showLineNumbers,
    wrapLines,
    reserveAddNoteColumn = false,
    showAddNoteBadge = false,
  }: CodeRowLayoutOptions,
): CodeRowLayoutPlan | null {
  if (plannedRow.kind !== "diff-row") {
    return null;
  }

  const row = plannedRow.row;
  if (row.type !== "split-line" && row.type !== "stack-line") {
    return null;
  }

  const prefixWidth = 1;
  const trailingGuideWidth = plannedRow.noteGuideSide === "new" ? 1 : 0;
  const addNoteBadgeWidth =
    showAddNoteBadge || (wrapLines && reserveAddNoteColumn) ? CODE_ROW_ADD_NOTE_BADGE_WIDTH : 0;

  if (row.type === "split-line") {
    const { leftWidth: leftPaneWidth, rightWidth: rightPaneWidth } = resolveSplitPaneWidths(width);
    const rightWidth = Math.max(0, rightPaneWidth - trailingGuideWidth - addNoteBadgeWidth);
    const leftGeometry = resolveSplitCellGeometry(
      leftPaneWidth,
      lineNumberDigits,
      showLineNumbers,
      prefixWidth,
    );
    const rightGeometry = resolveSplitCellGeometry(
      rightWidth,
      lineNumberDigits,
      showLineNumbers,
      prefixWidth,
    );
    const left = planCodeCellLayout(
      row.left.spans,
      leftPaneWidth,
      prefixWidth,
      leftGeometry.gutterWidth,
      wrapLines,
    );
    const right = planCodeCellLayout(
      row.right.spans,
      rightWidth,
      prefixWidth,
      rightGeometry.gutterWidth,
      wrapLines,
    );

    let measuredWrappedLineCount: number | undefined;
    return {
      kind: "split",
      left,
      right,
      leftPaneWidth,
      rightPaneWidth,
      noteGuideSide: plannedRow.noteGuideSide,
      trailingGuideWidth,
      addNoteBadgeWidth,
      get wrappedLineCount() {
        measuredWrappedLineCount ??= Math.max(left.wrappedLineCount, right.wrappedLineCount);
        return measuredWrappedLineCount;
      },
    };
  }

  const cellWidth = Math.max(0, width - trailingGuideWidth - addNoteBadgeWidth);
  const cellGeometry = resolveStackCellGeometry(
    cellWidth,
    lineNumberDigits,
    showLineNumbers,
    prefixWidth,
  );
  const cell = planCodeCellLayout(
    row.cell.spans,
    cellWidth,
    prefixWidth,
    cellGeometry.gutterWidth,
    wrapLines,
  );

  let measuredWrappedLineCount: number | undefined;
  return {
    kind: "stack",
    cell,
    noteGuideSide: plannedRow.noteGuideSide,
    trailingGuideWidth,
    addNoteBadgeWidth,
    get wrappedLineCount() {
      measuredWrappedLineCount ??= cell.wrappedLineCount;
      return measuredWrappedLineCount;
    },
  };
}

/** Adapt a raw diff row for surfaces that do not use the review render plan. */
export function legacyPlannedDiffRow(
  row: DiffRow,
  anchorId?: string,
  noteGuideSide?: "old" | "new",
): PlannedDiffReviewRow {
  return {
    kind: "diff-row",
    key: row.key,
    stableKey: row.key,
    fileId: row.fileId,
    hunkIndex: row.hunkIndex,
    row,
    anchorId,
    noteGuideSide,
  };
}

/** Measure how many terminal rows one complete planned diff row occupies. */
export function measurePlannedRenderedRowHeight(
  plannedRow: PlannedDiffReviewRow,
  options: CodeRowLayoutOptions & { showHunkHeaders: boolean },
) {
  if (plannedRow.row.type === "hunk-header") {
    return options.showHunkHeaders ? 1 : 0;
  }

  if (plannedRow.row.type === "collapsed" || !options.wrapLines) {
    return 1;
  }

  return planCodeRowLayout(plannedRow, options)?.wrappedLineCount ?? 1;
}

/** Measure a raw diff row for renderer-only consumers outside the planned review stream. */
export function measureRenderedRowHeight(
  row: DiffRow,
  width: number,
  lineNumberDigits: number,
  showLineNumbers: boolean,
  showHunkHeaders: boolean,
  wrapLines: boolean,
  _theme: AppTheme,
  reserveAddNoteColumn = false,
) {
  return measurePlannedRenderedRowHeight(legacyPlannedDiffRow(row), {
    width,
    lineNumberDigits,
    showLineNumbers,
    showHunkHeaders,
    wrapLines,
    reserveAddNoteColumn,
  });
}
