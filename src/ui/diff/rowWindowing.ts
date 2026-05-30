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
 * Find the first row whose bottom edge is after the visible top boundary.
 * Requires row bounds to be sorted by non-decreasing row bottom.
 */
function findFirstRowWithBottomAfter(rowBounds: DiffSectionGeometry["rowBounds"], top: number) {
  let low = 0;
  let high = rowBounds.length - 1;
  let result = rowBounds.length;

  while (low <= high) {
    const mid = (low + high) >>> 1;
    const rowBoundsEntry = rowBounds[mid]!;

    if (rowBoundsEntry.top + rowBoundsEntry.height > top) {
      result = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  return result;
}

/**
 * Find the last row whose top edge is before the visible bottom boundary.
 * Requires row bounds to be sorted by non-decreasing row top.
 */
function findLastRowWithTopBefore(rowBounds: DiffSectionGeometry["rowBounds"], bottom: number) {
  let low = 0;
  let high = rowBounds.length - 1;
  let result = -1;

  while (low <= high) {
    const mid = (low + high) >>> 1;
    const rowBoundsEntry = rowBounds[mid]!;

    if (rowBoundsEntry.top < bottom) {
      result = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return result;
}

/** Return whether one measured row overlaps the requested closed-open visible interval. */
function rowOverlapsVisibleRange(
  rowBounds: DiffSectionGeometry["rowBounds"][number],
  minVisibleTop: number,
  maxVisibleBottom: number,
) {
  if (rowBounds.height <= 0) {
    return false;
  }

  const rowBottom = rowBounds.top + rowBounds.height;
  return rowBottom > minVisibleTop && rowBounds.top < maxVisibleBottom;
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

  let firstVisibleIndex = findFirstRowWithBottomAfter(sectionGeometry.rowBounds, minVisibleTop);
  while (
    firstVisibleIndex < sectionGeometry.rowBounds.length &&
    !rowOverlapsVisibleRange(
      sectionGeometry.rowBounds[firstVisibleIndex]!,
      minVisibleTop,
      maxVisibleBottom,
    )
  ) {
    firstVisibleIndex += 1;
  }

  let lastVisibleIndex = findLastRowWithTopBefore(sectionGeometry.rowBounds, maxVisibleBottom);
  while (
    lastVisibleIndex >= 0 &&
    !rowOverlapsVisibleRange(
      sectionGeometry.rowBounds[lastVisibleIndex]!,
      minVisibleTop,
      maxVisibleBottom,
    )
  ) {
    lastVisibleIndex -= 1;
  }

  if (firstVisibleIndex >= sectionGeometry.rowBounds.length) {
    firstVisibleIndex = -1;
  }

  // firstVisibleIndex > lastVisibleIndex should not happen with sorted row bounds, but keep the
  // empty-window fallback defensive in case an upstream geometry invariant is ever broken.
  if (firstVisibleIndex < 0 || lastVisibleIndex < 0 || firstVisibleIndex > lastVisibleIndex) {
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
