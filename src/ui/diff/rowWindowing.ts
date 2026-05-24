import type { DiffSectionGeometry } from "./diffSectionGeometry";
import type { PlannedReviewRow } from "./reviewRenderPlan";

/** One visible slice within a file body, measured in file-local row units. */
export interface VisibleBodyBounds {
  top: number;
  height: number;
}

export interface VisiblePlannedRowWindow {
  bottomSpacerHeight: number;
  plannedRows: PlannedReviewRow[];
  topSpacerHeight: number;
}

/**
 * Slice planned rows down to the visible body range while preserving total section height.
 *
 * The geometry row bounds come from the same render plan as `plannedRows`, so their array order is
 * intentionally aligned and can be sliced by index.
 */
export function resolveVisiblePlannedRowWindow({
  plannedRows,
  sectionGeometry,
  visibleBodyBounds,
}: {
  plannedRows: PlannedReviewRow[];
  sectionGeometry: DiffSectionGeometry;
  visibleBodyBounds: VisibleBodyBounds;
}): VisiblePlannedRowWindow {
  if (plannedRows.length === 0 || sectionGeometry.rowBounds.length !== plannedRows.length) {
    return {
      bottomSpacerHeight: 0,
      plannedRows,
      topSpacerHeight: 0,
    };
  }

  // Convert the requested visible window into one closed-open interval within this file body:
  // [minVisibleTop, maxVisibleBottom). Rows above/below that interval become spacer height.
  const minVisibleTop = Math.max(0, visibleBodyBounds.top);
  const maxVisibleBottom = Math.min(
    sectionGeometry.bodyHeight,
    visibleBodyBounds.top + Math.max(0, visibleBodyBounds.height),
  );

  let firstVisibleIndex = -1;
  let lastVisibleIndex = -1;

  for (let index = 0; index < sectionGeometry.rowBounds.length; index += 1) {
    const rowBounds = sectionGeometry.rowBounds[index]!;
    if (rowBounds.height <= 0) {
      continue;
    }

    const rowBottom = rowBounds.top + rowBounds.height;
    // Treat each row as the half-open interval [row.top, row.bottom). If that interval does not
    // overlap the visible file-body interval, the row can stay unmounted.
    if (rowBottom <= minVisibleTop || rowBounds.top >= maxVisibleBottom) {
      continue;
    }

    if (firstVisibleIndex < 0) {
      firstVisibleIndex = index;
    }
    lastVisibleIndex = index;
  }

  if (firstVisibleIndex < 0 || lastVisibleIndex < 0) {
    const topSpacerHeight = Math.min(sectionGeometry.bodyHeight, minVisibleTop);

    return {
      bottomSpacerHeight: Math.max(0, sectionGeometry.bodyHeight - topSpacerHeight),
      plannedRows: [],
      topSpacerHeight,
    };
  }

  let startIndex = firstVisibleIndex;
  // Zero-height rows still matter structurally: for example, hidden hunk headers keep anchor ids
  // and stable row ordering. If one sits immediately before the visible slice, keep it attached.
  while (startIndex > 0 && sectionGeometry.rowBounds[startIndex - 1]?.height === 0) {
    startIndex -= 1;
  }

  let endIndex = lastVisibleIndex + 1;
  // Do the same on the trailing edge so hidden structural rows continue to travel with the last
  // visible rendered row instead of being stranded in the spacer region.
  while (endIndex < plannedRows.length && sectionGeometry.rowBounds[endIndex]?.height === 0) {
    endIndex += 1;
  }

  const startRowBounds = sectionGeometry.rowBounds[startIndex]!;
  const endRowBounds = sectionGeometry.rowBounds[endIndex - 1]!;

  return {
    // The top spacer is exactly the skipped body height before the first mounted row.
    topSpacerHeight: startRowBounds.top,
    plannedRows: plannedRows.slice(startIndex, endIndex),
    // The bottom spacer is the remaining body height after the last mounted row's bottom edge.
    bottomSpacerHeight: Math.max(
      0,
      sectionGeometry.bodyHeight - (endRowBounds.top + endRowBounds.height),
    ),
  };
}
