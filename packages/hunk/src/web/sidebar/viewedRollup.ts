/**
 * Counts how much of each sidebar folder the reader has marked viewed.
 *
 * Tree directories count every file at or below them; flat-list headings count the run of
 * files listed under them, so a directory that review order leaves and re-enters gets one
 * count per heading. Only a current "viewed" mark counts: a file changed since it was viewed
 * needs another look. Small folders stay quiet until something in them is viewed.
 */
import type { ReviewSidebarEntry } from "../../core/review/fileLabels";
import { formatCount } from "../format/lineCounts";
import type { ReviewViewedStatus } from "../viewed/viewedFiles";

/** Viewed and total files in one folder. */
export interface ViewedRollup {
  viewed: number;
  total: number;
}

/** Folders with at most this many files show no roll-up until one of them is viewed. */
export const QUIET_FOLDER_FILE_COUNT = 5;

type ViewedStatuses = ReadonlyMap<string, ReviewViewedStatus> | undefined;

/** Adds one file to a folder's roll-up, creating it on first use. */
function countInto(
  rollups: Map<string, ViewedRollup>,
  folder: string,
  key: string,
  statuses: ViewedStatuses,
) {
  const rollup = rollups.get(folder) ?? { viewed: 0, total: 0 };
  rollup.total += 1;
  if (statuses?.get(key) === "viewed") rollup.viewed += 1;
  rollups.set(folder, rollup);
}

/**
 * Roll-ups for every directory above the given files, keyed by directory path without a
 * trailing slash (`src/gen`).
 */
export function directoryViewedRollups(
  files: readonly { key: string; path: string }[],
  statuses: ViewedStatuses,
): Map<string, ViewedRollup> {
  const rollups = new Map<string, ViewedRollup>();
  for (const { key, path } of files) {
    const segments = path.split("/");
    for (let depth = 1; depth < segments.length; depth += 1) {
      countInto(rollups, segments.slice(0, depth).join("/"), key, statuses);
    }
  }
  return rollups;
}

/** Roll-ups for each flat-list heading, keyed by the heading's row id. */
export function headingViewedRollups(
  rows: readonly ReviewSidebarEntry[],
  statuses: ViewedStatuses,
): Map<string, ViewedRollup> {
  const rollups = new Map<string, ViewedRollup>();
  let heading: string | undefined;
  for (const row of rows) {
    if (row.kind === "group") heading = row.id;
    else if (row.kind === "file" && heading !== undefined) {
      countInto(rollups, heading, row.id, statuses);
    }
  }
  return rollups;
}

/** Whether a folder shows its roll-up: once anything in it is viewed, or when it is large. */
export function showsViewedRollup(rollup: ViewedRollup | undefined): rollup is ViewedRollup {
  return rollup !== undefined && (rollup.viewed > 0 || rollup.total > QUIET_FOLDER_FILE_COUNT);
}

/** The roll-up as the sidebar prints it (`1/40`) and as it reads aloud. */
export function formatViewedRollup(rollup: ViewedRollup) {
  return {
    text: `${formatCount(rollup.viewed)}/${formatCount(rollup.total)}`,
    label: `${formatCount(rollup.viewed)} of ${formatCount(rollup.total)} files viewed`,
    complete: rollup.viewed === rollup.total,
  };
}

/** `1 note` or `2 notes`, the accessible name of a note-count badge. */
export function formatNoteCountLabel(count: number): string {
  return count === 1 ? "1 note" : `${formatCount(count)} notes`;
}
