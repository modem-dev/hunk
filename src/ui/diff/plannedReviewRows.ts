import type { LayoutMode } from "../../core/types";
import { measureAgentInlineNoteHeight } from "../components/panes/AgentInlineNote";
import type { SectionGeometry, VerticalBounds } from "../lib/diffSpatial";
import { reviewRowId } from "../lib/ids";
import type { PlannedReviewRow } from "./reviewRenderPlan";

/** Layout inputs needed to turn one planned review row into concrete terminal height. */
export interface PlannedReviewRowLayoutOptions {
  showHunkHeaders: boolean;
  layout: Exclude<LayoutMode, "auto">;
  width: number;
}

/**
 * Visible bounds for one hunk within a file section body.
 *
 * The row ids let DiffPane upgrade from planned measurements to exact mounted measurements later.
 */
export interface PlannedHunkBounds extends VerticalBounds {
  startRowId: string;
  endRowId: string;
}

/** Aggregate geometry for one file section measured from planned review rows. */
export type PlannedSectionGeometry = SectionGeometry<PlannedHunkBounds>;

/** Return whether this planned row should count toward a hunk's own visible extent. */
function rowContributesToHunkBounds(row: PlannedReviewRow) {
  // Collapsed gap rows belong between hunks, so they affect total section height but not a hunk's
  // own visible extent.
  return !(row.kind === "diff-row" && row.row.type === "collapsed");
}

/** Measure how many terminal rows one planned review row will occupy once rendered. */
export function plannedReviewRowHeight(
  row: PlannedReviewRow,
  { showHunkHeaders, layout, width }: PlannedReviewRowLayoutOptions,
) {
  if (row.kind === "inline-note") {
    return measureAgentInlineNoteHeight({
      annotation: row.annotation,
      anchorSide: row.anchorSide,
      layout,
      width,
    });
  }

  if (row.kind === "note-guide-cap") {
    return 1;
  }

  if (row.row.type === "hunk-header") {
    return showHunkHeaders ? 1 : 0;
  }

  return 1;
}

/** Check whether a planned row will produce any visible output at all. */
export function plannedReviewRowVisible(
  row: PlannedReviewRow,
  options: PlannedReviewRowLayoutOptions,
) {
  return plannedReviewRowHeight(row, options) > 0;
}

/**
 * Walk one file's planned rows and derive section geometry plus hunk-local bounds.
 *
 * `top` is measured in section-body rows, so callers can add the file section offset later.
 */
export function measurePlannedSectionGeometry(
  plannedRows: PlannedReviewRow[],
  options: PlannedReviewRowLayoutOptions,
): PlannedSectionGeometry {
  const hunkAnchorRows = new Map<number, number>();
  const hunkBounds = new Map<number, PlannedHunkBounds>();
  let bodyHeight = 0;

  for (const row of plannedRows) {
    if (row.kind === "diff-row" && row.anchorId && !hunkAnchorRows.has(row.hunkIndex)) {
      // Track the renderer's anchor row separately from the full hunk bounds so navigation can
      // still target the same semantic row when headers are hidden.
      hunkAnchorRows.set(row.hunkIndex, bodyHeight);
    }

    const rowHeight = plannedReviewRowHeight(row, options);

    if (rowHeight > 0 && rowContributesToHunkBounds(row)) {
      const rowId = reviewRowId(row.key);
      const existingBounds = hunkBounds.get(row.hunkIndex);

      if (existingBounds) {
        // Extend the current hunk through the latest visible row that belongs to it.
        existingBounds.endRowId = rowId;
        existingBounds.height += rowHeight;
      } else {
        // Seed the first visible row for this hunk; later rows will widen the bounds.
        hunkBounds.set(row.hunkIndex, {
          top: bodyHeight,
          height: rowHeight,
          startRowId: rowId,
          endRowId: rowId,
        });
      }
    }

    bodyHeight += rowHeight;
  }

  return {
    bodyHeight,
    hunkAnchorRows,
    hunkBounds,
  };
}
