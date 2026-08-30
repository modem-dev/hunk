import { measureAgentInlineNoteHeight } from "../components/panes/AgentInlineNote";
import { reviewRowId } from "../lib/ids";
import type { PlannedHunkBounds } from "../diff/reviewRowGeometry";
import type { DiffSectionGeometry, DiffSectionRowBounds } from "../diff/diffSectionGeometry";
import type { ValidatedFileViewLayout } from "./layout";
import type { PlannedFileViewRow } from "./renderPlan";

/** Measure one extension or host-note row in the alternate presentation stream. */
function plannedFileViewRowHeight(
  row: PlannedFileViewRow,
  resolved: ValidatedFileViewLayout,
  width: number,
) {
  if (row.kind === "file-view-row") {
    return resolved.rowHeights[row.rowIndex]!;
  }

  return measureAgentInlineNoteHeight({
    annotation: row.annotation,
    anchorSide: row.anchorSide,
    // Alternate presentations are one full-width stack even when raw code uses split columns.
    layout: "stack",
    width,
    actions: row.note.actions,
    threadDepth: row.note.thread?.depth,
  });
}

/**
 * Build host-owned scroll, note, and hunk geometry for one alternate file presentation.
 *
 * `plannedRows` and `width` are required together: note heights depend on the same content width the
 * rows are painted at, so a defaulted width would silently measure notes for the wrong terminal.
 */
export function measureFileViewGeometry({
  resolved,
  plannedRows,
  width,
}: {
  resolved: ValidatedFileViewLayout;
  plannedRows: readonly PlannedFileViewRow[];
  width: number;
}): DiffSectionGeometry {
  const { layout } = resolved;
  const rowBounds: DiffSectionRowBounds[] = [];
  const rowBoundsByKey = new Map<string, DiffSectionRowBounds>();
  const rowBoundsByStableKey = new Map<string, DiffSectionRowBounds>();
  let bodyHeight = 0;

  for (const row of plannedRows) {
    const entry: DiffSectionRowBounds = {
      key: row.key,
      stableKey: row.stableKey,
      stableKeys:
        row.kind === "file-view-row" && row.stableAliasKeys
          ? [row.stableKey, ...row.stableAliasKeys]
          : [row.stableKey],
      top: bodyHeight,
      height: plannedFileViewRowHeight(row, resolved, width),
    };
    rowBounds.push(entry);
    rowBoundsByKey.set(entry.key, entry);
    for (const stableKey of entry.stableKeys) {
      if (!rowBoundsByStableKey.has(stableKey)) {
        rowBoundsByStableKey.set(stableKey, entry);
      }
    }
    bodyHeight += entry.height;
  }

  const planExtentsByRow = Array.from({ length: layout.rows.length }, () => ({
    anchor: -1,
    first: -1,
    last: -1,
  }));
  for (const [planIndex, row] of plannedRows.entries()) {
    const rowIndex = row.kind === "file-view-row" ? row.rowIndex : row.anchorRowIndex;
    const extent = planExtentsByRow[rowIndex]!;
    if (extent.first < 0) extent.first = planIndex;
    extent.last = planIndex;
    if (row.kind === "file-view-row") extent.anchor = planIndex;
  }

  const hunkAnchorRows = new Map<number, number>();
  const hunkBounds = new Map<number, PlannedHunkBounds>();
  for (const [hunkIndex, hunk] of layout.hunkRows.entries()) {
    const startExtent = planExtentsByRow[hunk.startRow]!;
    const endExtent = planExtentsByRow[hunk.endRow]!;
    if (startExtent.anchor < 0 || startExtent.first < 0 || endExtent.last < 0) continue;

    const anchor = rowBounds[startExtent.anchor]!;
    const start = rowBounds[startExtent.first]!;
    const end = rowBounds[endExtent.last]!;
    hunkAnchorRows.set(hunkIndex, anchor.top);
    hunkBounds.set(hunkIndex, {
      top: start.top,
      height: end.top + end.height - start.top,
      startRowId: reviewRowId(start.key),
      endRowId: reviewRowId(end.key),
    });
  }

  return {
    bodyHeight,
    hunkAnchorRows,
    hunkBounds,
    lineNumberDigits: 1,
    // Alternate rows are not Pierre rows, so raw copy selection intentionally remains unavailable.
    plannedRows: [],
    fileViewRows: plannedRows,
    rowBounds,
    rowBoundsByKey,
    rowBoundsByStableKey,
  };
}
