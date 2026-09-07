/** Adapts and dispatches diff rows to their focused mounted row views. */
import { memo } from "react";
import type { UserNoteLineTarget } from "../../core/liveComments";
import type { CopySelectedRowRange } from "../lib/diffSpatial";
import type { AppTheme } from "../themes";
import { CodeRowView, type PlannedCodeReviewRow } from "./CodeRowView";
import { legacyPlannedDiffRow, type PlannedDiffReviewRow } from "./codeRowLayout";
import type { CursorHighlight } from "./cursorHighlight";
import { DiffMetaRowView, type PlannedDiffMetaReviewRow } from "./DiffMetaRowView";
import type { DiffRow } from "./diffRows";
import type { LineHighlightPaintIndex } from "./lineHighlightPaint";

/** Inputs accepted by the memoized diff-row facade. */
export interface DiffRowViewProps {
  /** Complete review-stream row; preferred when the caller owns the shared render plan. */
  plannedRow?: PlannedDiffReviewRow;
  /** Raw row fallback for renderer-only surfaces outside the shared review stream. */
  row?: DiffRow;
  width: number;
  lineNumberDigits: number;
  showLineNumbers: boolean;
  showHunkHeaders: boolean;
  wrapLines: boolean;
  codeHorizontalOffset: number;
  theme: AppTheme;
  selected: boolean;
  copySelectedRowRange?: CopySelectedRowRange;
  copySelectedSide?: "left" | "right";
  cursorHighlight?: CursorHighlight;
  /** Extension marks for this row's file, resolved to terminal columns. */
  lineHighlights?: LineHighlightPaintIndex;
  anchorId?: string;
  noteGuideSide?: "old" | "new";
  showAddNoteBadge?: boolean;
  onHoverRow?: (rowKey: string) => void;
  onStartUserNoteAtHunk?: (hunkIndex: number, target?: UserNoteLineTarget) => void;
  onToggleGap?: (gapKey: string) => void;
}

/**
 * Render one diff row, memoized to avoid unnecessary rerenders.
 *
 * React's shallow comparison checks every handler by reference, so callers (DiffSectionBody) must
 * pass identity-stable callbacks — e.g. one shared onHoverRow that receives the row key — or memo
 * silently degrades to re-rendering every visible row per parent render.
 */
export const DiffRowView = memo(function DiffRowViewComponent({
  plannedRow,
  row,
  width,
  lineNumberDigits,
  showLineNumbers,
  showHunkHeaders,
  wrapLines,
  codeHorizontalOffset,
  theme,
  selected,
  copySelectedRowRange,
  copySelectedSide,
  cursorHighlight,
  lineHighlights,
  anchorId,
  noteGuideSide,
  showAddNoteBadge,
  onHoverRow,
  onStartUserNoteAtHunk,
  onToggleGap,
}: DiffRowViewProps) {
  const resolvedPlannedRow =
    plannedRow ?? (row ? legacyPlannedDiffRow(row, anchorId, noteGuideSide) : undefined);
  if (!resolvedPlannedRow) {
    return null;
  }

  if (
    resolvedPlannedRow.row.type === "collapsed" ||
    resolvedPlannedRow.row.type === "hunk-header"
  ) {
    return (
      <DiffMetaRowView
        plannedRow={resolvedPlannedRow as PlannedDiffMetaReviewRow}
        width={width}
        theme={theme}
        selected={selected || copySelectedRowRange !== undefined}
        showHunkHeaders={showHunkHeaders}
        showAddNoteBadge={showAddNoteBadge}
        onHoverRow={onHoverRow}
        onStartUserNoteAtHunk={onStartUserNoteAtHunk}
        onToggleGap={onToggleGap}
      />
    );
  }

  if (
    resolvedPlannedRow.row.type === "split-line" ||
    resolvedPlannedRow.row.type === "stack-line"
  ) {
    return (
      <CodeRowView
        plannedRow={resolvedPlannedRow as PlannedCodeReviewRow}
        width={width}
        lineNumberDigits={lineNumberDigits}
        showLineNumbers={showLineNumbers}
        wrapLines={wrapLines}
        codeHorizontalOffset={codeHorizontalOffset}
        theme={theme}
        selected={selected}
        copySelectedRowRange={copySelectedRowRange}
        copySelectedSide={copySelectedSide}
        cursorHighlight={cursorHighlight}
        lineHighlights={lineHighlights}
        showAddNoteBadge={showAddNoteBadge}
        onHoverRow={onHoverRow}
        onStartUserNoteAtHunk={onStartUserNoteAtHunk}
      />
    );
  }

  return (
    <box style={{ width: "100%", height: 1 }}>
      <text fg={theme.muted}>Unsupported row.</text>
    </box>
  );
});
