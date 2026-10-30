/** Dispatches planned diff rows to their focused mounted row views. */
import { memo } from "react";
import type { UserNoteLineTarget } from "../../core/liveComments";
import type { CopySelectedRowRange } from "../lib/diffSpatial";
import type { AppTheme } from "../themes";
import { CodeRowView } from "./CodeRowView";
import type { CursorHighlight } from "./cursorHighlight";
import { DiffMetaRowView } from "./DiffMetaRowView";
import type { LineHighlightPaintIndex } from "./lineHighlightPaint";
import {
  isPlannedCodeReviewRow,
  isPlannedDiffMetaReviewRow,
  type PlannedDiffReviewRow,
} from "./reviewRenderPlan";

/** Inputs accepted by the memoized diff-row facade. */
export interface DiffRowViewProps {
  /** Complete row from the shared review render plan. */
  plannedRow: PlannedDiffReviewRow;
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
  showAddNoteBadge?: boolean;
  onHoverRow?: (rowKey: string) => void;
  onStartUserNoteAtHunk?: (hunkIndex: number, target?: UserNoteLineTarget) => void;
  onToggleGap?: (gapKey: string) => void;
}

/** Reject a planned row variant that lacks a mounted row view. */
function unsupportedPlannedDiffRow(plannedRow: never): never {
  throw new Error(`Unsupported planned diff row: ${JSON.stringify(plannedRow)}`);
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
  showAddNoteBadge,
  onHoverRow,
  onStartUserNoteAtHunk,
  onToggleGap,
}: DiffRowViewProps) {
  if (isPlannedDiffMetaReviewRow(plannedRow)) {
    return (
      <DiffMetaRowView
        plannedRow={plannedRow}
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

  if (isPlannedCodeReviewRow(plannedRow)) {
    return (
      <CodeRowView
        plannedRow={plannedRow}
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

  return unsupportedPlannedDiffRow(plannedRow);
});
