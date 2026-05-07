import type { DiffSectionGeometry } from "../lib/diffSectionGeometry";
import type { PlannedReviewRow } from "./reviewRenderPlan";

const ROW_WINDOWING_POC_ENV = "HUNK_ROW_WINDOWING_POC";

export interface VisibleBodyBounds {
  top: number;
  height: number;
}

export interface VisiblePlannedRowWindow {
  bottomSpacerHeight: number;
  plannedRows: PlannedReviewRow[];
  topSpacerHeight: number;
}

/** Opt-in gate for the row-windowing proof of concept while we validate behavior and gains. */
export function rowWindowingPocEnabled(env: NodeJS.ProcessEnv = process.env) {
  return env[ROW_WINDOWING_POC_ENV] === "1";
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
    if (rowBottom <= minVisibleTop || rowBounds.top >= maxVisibleBottom) {
      continue;
    }

    if (firstVisibleIndex < 0) {
      firstVisibleIndex = index;
    }
    lastVisibleIndex = index;
  }

  if (firstVisibleIndex < 0 || lastVisibleIndex < 0) {
    return {
      bottomSpacerHeight: sectionGeometry.bodyHeight,
      plannedRows: [],
      topSpacerHeight: 0,
    };
  }

  let startIndex = firstVisibleIndex;
  while (startIndex > 0 && sectionGeometry.rowBounds[startIndex - 1]?.height === 0) {
    startIndex -= 1;
  }

  let endIndex = lastVisibleIndex + 1;
  while (endIndex < plannedRows.length && sectionGeometry.rowBounds[endIndex]?.height === 0) {
    endIndex += 1;
  }

  const startRowBounds = sectionGeometry.rowBounds[startIndex]!;
  const endRowBounds = sectionGeometry.rowBounds[endIndex - 1]!;

  return {
    bottomSpacerHeight: Math.max(
      0,
      sectionGeometry.bodyHeight - (endRowBounds.top + endRowBounds.height),
    ),
    plannedRows: plannedRows.slice(startIndex, endIndex),
    topSpacerHeight: startRowBounds.top,
  };
}
