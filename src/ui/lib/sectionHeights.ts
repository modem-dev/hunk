import type { DiffFile, LayoutMode } from "../../core/types";
import { buildSplitRows, buildStackRows } from "../diff/pierre";
import { buildReviewRenderPlan, type PlannedReviewRow } from "../diff/reviewRenderPlan";
import type { AppTheme } from "../themes";

export interface DiffSectionMetrics {
  bodyHeight: number;
  hunkAnchorRows: Map<number, number>;
}

function buildBasePlannedRows(
  file: DiffFile,
  layout: Exclude<LayoutMode, "auto">,
  showHunkHeaders: boolean,
  theme: AppTheme,
) {
  const rows =
    layout === "split" ? buildSplitRows(file, null, theme) : buildStackRows(file, null, theme);

  return buildReviewRenderPlan({
    fileId: file.id,
    rows,
    selectedHunkIndex: -1,
    showHunkHeaders,
    visibleAgentNotes: [],
  });
}

function plannedRowHeight(row: PlannedReviewRow, showHunkHeaders: boolean) {
  if (row.kind !== "diff-row") {
    return 0;
  }

  if (row.row.type === "hunk-header") {
    return showHunkHeaders ? 1 : 0;
  }

  return 1;
}

/**
 * Measure one file section from the same render plan used by PierreDiffView.
 * This drives the no-wrap/no-note windowing path, where every visible planned row is one terminal row.
 */
export function measureDiffSectionMetrics(
  file: DiffFile,
  layout: Exclude<LayoutMode, "auto">,
  showHunkHeaders: boolean,
  theme: AppTheme,
): DiffSectionMetrics {
  if (file.metadata.hunks.length === 0) {
    return {
      bodyHeight: 1,
      hunkAnchorRows: new Map(),
    };
  }

  const plannedRows = buildBasePlannedRows(file, layout, showHunkHeaders, theme);
  const hunkAnchorRows = new Map<number, number>();
  let bodyHeight = 0;

  for (const row of plannedRows) {
    if (row.kind === "diff-row" && row.anchorId && !hunkAnchorRows.has(row.hunkIndex)) {
      hunkAnchorRows.set(row.hunkIndex, bodyHeight);
    }

    bodyHeight += plannedRowHeight(row, showHunkHeaders);
  }

  return {
    bodyHeight,
    hunkAnchorRows,
  };
}

/** Estimate the number of diff-body rows for one file in the windowed path. */
export function estimateDiffBodyRows(
  file: DiffFile,
  layout: Exclude<LayoutMode, "auto">,
  showHunkHeaders: boolean,
  theme: AppTheme,
) {
  return measureDiffSectionMetrics(file, layout, showHunkHeaders, theme).bodyHeight;
}

/** Estimate the body-row offset for the anchor that should represent the selected hunk. */
export function estimateHunkAnchorRow(
  file: DiffFile,
  layout: Exclude<LayoutMode, "auto">,
  showHunkHeaders: boolean,
  hunkIndex: number,
  theme: AppTheme,
) {
  if (file.metadata.hunks.length === 0) {
    return 0;
  }

  const clampedHunkIndex = Math.max(0, Math.min(hunkIndex, file.metadata.hunks.length - 1));
  return (
    measureDiffSectionMetrics(file, layout, showHunkHeaders, theme).hunkAnchorRows.get(
      clampedHunkIndex,
    ) ?? 0
  );
}
