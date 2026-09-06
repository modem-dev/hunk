import type { HistoryGraphRow } from "../../core/history/types";
import { historyDayKey } from "./formatting";

export const LOG_ENTRY_HEIGHT = 3;
export const LOG_DAY_HEADER_HEIGHT = 2;

export interface LogViewportEntry {
  index: number;
  row: HistoryGraphRow;
  showDayHeader: boolean;
}

export interface LogViewportGeometry {
  top: number;
  entries: LogViewportEntry[];
  usedHeight: number;
}

/** Measure one commit entry, including a repeated day heading and spacer at viewport boundaries. */
function entryHeight(
  rows: readonly HistoryGraphRow[],
  index: number,
  top: number,
  bodyHeight: number,
  groupByDay: boolean,
) {
  const startsDay =
    groupByDay &&
    bodyHeight >= LOG_ENTRY_HEIGHT + LOG_DAY_HEADER_HEIGHT &&
    (index === top ||
      historyDayKey(rows[index]!.commit.authoredAt) !==
        historyDayKey(rows[index - 1]!.commit.authoredAt));
  return LOG_ENTRY_HEIGHT + (startsDay ? LOG_DAY_HEADER_HEIGHT : 0);
}

/** Return whether a commit fits when the viewport begins at the requested commit index. */
function selectionFits(
  rows: readonly HistoryGraphRow[],
  top: number,
  selected: number,
  bodyHeight: number,
  groupByDay: boolean,
) {
  let usedHeight = 0;
  for (let index = top; index <= selected; index += 1) {
    usedHeight += entryHeight(rows, index, top, bodyHeight, groupByDay);
    if (usedHeight > bodyHeight) return false;
  }
  return true;
}

/** Plan selectable commit entries and non-selectable day headers within the terminal body. */
export function planLogViewportGeometry({
  rows,
  selected,
  requestedTop,
  bodyHeight,
  groupByDay,
}: {
  rows: readonly HistoryGraphRow[];
  selected: number;
  requestedTop: number;
  bodyHeight: number;
  groupByDay: boolean;
}): LogViewportGeometry {
  if (rows.length === 0 || bodyHeight < LOG_ENTRY_HEIGHT) {
    return { top: 0, entries: [], usedHeight: 0 };
  }

  const safeSelected = Math.max(0, Math.min(rows.length - 1, selected));
  const minimumTop = Math.max(0, Math.min(safeSelected, requestedTop));
  let top = safeSelected;
  // Walk backward only through entries that can share the viewport with the selection. Starting
  // at requestedTop would revisit the same bounded window for every skipped commit in long logs.
  while (top > minimumTop && selectionFits(rows, top - 1, safeSelected, bodyHeight, groupByDay))
    top -= 1;
  // Near EOF, backfill earlier commits instead of leaving rows empty below the last group.
  while (top > 0) {
    let candidateHeight = 0;
    for (let index = top - 1; index < rows.length && candidateHeight <= bodyHeight; index += 1) {
      candidateHeight += entryHeight(rows, index, top - 1, bodyHeight, groupByDay);
    }
    if (candidateHeight > bodyHeight) break;
    top -= 1;
  }

  const entries: LogViewportEntry[] = [];
  let usedHeight = 0;
  for (let index = top; index < rows.length; index += 1) {
    const height = entryHeight(rows, index, top, bodyHeight, groupByDay);
    if (usedHeight + height > bodyHeight) break;
    const showDayHeader = height > LOG_ENTRY_HEIGHT;
    entries.push({ index, row: rows[index]!, showDayHeader });
    usedHeight += height;
  }
  return { top, entries, usedHeight };
}
