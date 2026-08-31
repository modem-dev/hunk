/**
 * Line-granular navigation targets for the review stream.
 *
 * Stops come from the measured render plan rather than the parsed diff, so they match the rows the
 * active layout draws and carry the plan anchor rendering, reveal, and note placement already use.
 */

import type { DiffFile } from "../../core/changeset/model";
import type { UserNoteLineTarget } from "../../core/liveComments";
import type { DiffSectionGeometry, DiffSectionRowBounds } from "../diff/diffSectionGeometry";
import {
  contextLineStableKeySides,
  contextLineStableKeyTarget,
  lineStableKey,
  lineStableKeyTarget,
} from "../diff/reviewRenderPlan";
import type { VerticalBounds } from "./diffSpatial";

export interface LineCursor {
  fileId: string;
  hunkIndex: number;
  /** The render plan's anchor for this row, shared with reveal and highlight lookups. */
  stableKey: string;
  target: UserNoteLineTarget;
  /** Exact collapsed gap that produced this cursor, when it is a revealed source line. */
  expandedGapKey?: string;
}

export const EMPTY_LINE_CURSORS: LineCursor[] = [];

const cursorsBySectionGeometry = new WeakMap<DiffSectionGeometry, LineCursor[]>();
const indexesByCursorList = new WeakMap<LineCursor[], Map<string, number>>();

/** Index one cursor list by position, so stepping does not rescan the changeset per keypress. */
function cursorIndexes(cursors: LineCursor[]) {
  let indexes = indexesByCursorList.get(cursors);
  if (!indexes) {
    indexes = new Map(cursors.map((cursor, index) => [cursorId(cursor), index]));
    indexesByCursorList.set(cursors, indexes);
  }
  return indexes;
}

/** Identify one navigable line across the whole review stream. */
function cursorId(cursor: LineCursor) {
  return `${cursor.fileId}\u0000${cursor.stableKey}`;
}

/** Enumerate the navigable stops one measured row renders, left to right. */
function rowLineCursors(fileId: string, bounds: DiffSectionRowBounds): LineCursor[] {
  // A context row shows one source line on both sides, so its sided anchors name the same position.
  const context = contextLineStableKeyTarget(bounds.stableKey);
  if (context) {
    const { hunkIndex, ...target } = context;
    return [
      {
        fileId,
        hunkIndex,
        stableKey: bounds.stableKey,
        target,
        ...(bounds.expandedGapKey ? { expandedGapKey: bounds.expandedGapKey } : {}),
      },
    ];
  }

  const cursors: LineCursor[] = [];
  for (const stableKey of bounds.stableKeys) {
    const anchor = lineStableKeyTarget(stableKey);
    if (!anchor) {
      continue;
    }

    const { hunkIndex, ...target } = anchor;
    cursors.push({
      fileId,
      hunkIndex,
      stableKey,
      target,
      ...(bounds.expandedGapKey ? { expandedGapKey: bounds.expandedGapKey } : {}),
    });
  }

  return cursors;
}

/** List one file's cursors, reusing the last result while its measured rows are unchanged. */
function fileLineCursors(file: DiffFile, geometry: DiffSectionGeometry): LineCursor[] {
  const cached = cursorsBySectionGeometry.get(geometry);
  if (cached) {
    return cached;
  }

  const cursors = geometry.rowBounds.flatMap((bounds) => rowLineCursors(file.id, bounds));
  cursorsBySectionGeometry.set(geometry, cursors);
  return cursors;
}

/** Flatten the measured review stream into one ordered line cursor list. */
export function buildLineCursors(
  files: DiffFile[],
  sectionGeometry: DiffSectionGeometry[],
): LineCursor[] {
  return files.flatMap((file, index) => {
    const geometry = sectionGeometry[index];
    return geometry ? fileLineCursors(file, geometry) : [];
  });
}

/** Reuse the previous ordered cursor list when remeasurement preserved every navigation target. */
export function reuseEquivalentLineCursors(previous: LineCursor[], next: LineCursor[]) {
  if (
    previous.length === next.length &&
    next.every((cursor, index) => {
      const prior = previous[index];
      return (
        prior?.fileId === cursor.fileId &&
        prior.hunkIndex === cursor.hunkIndex &&
        prior.stableKey === cursor.stableKey &&
        prior.expandedGapKey === cursor.expandedGapKey &&
        prior.target.side === cursor.target.side &&
        prior.target.line === cursor.target.line
      );
    })
  ) {
    return previous;
  }
  return next;
}

/** Create a cursor stabilizer that only compares newly measured lists. */
export function createLineCursorStabilizer() {
  let measured = EMPTY_LINE_CURSORS;
  let stable = EMPTY_LINE_CURSORS;

  return (next: LineCursor[]) => {
    if (measured !== next) {
      measured = next;
      stable = reuseEquivalentLineCursors(stable, next);
    }
    return stable;
  };
}

/** Find the first cursor in one hunk, then anywhere in its file. */
function nearestCursorInFile(cursors: LineCursor[], fileId: string, hunkIndex: number) {
  return (
    cursors.find((cursor) => cursor.fileId === fileId && cursor.hunkIndex === hunkIndex) ??
    cursors.find((cursor) => cursor.fileId === fileId)
  );
}

/**
 * Find the first navigable line inside one hunk.
 *
 * Stays inside the requested file: falling back to the top of the stream would move the marker,
 * and with it the selection, off the file the reviewer just picked.
 */
export function firstLineCursorInHunk(
  cursors: LineCursor[],
  fileId: string | undefined,
  hunkIndex: number,
): LineCursor | null {
  if (!fileId) {
    return cursors[0] ?? null;
  }

  return nearestCursorInFile(cursors, fileId, hunkIndex) ?? null;
}

/** Move forward or backward through the review-stream line cursor list. */
export function findNextLineCursor(
  cursors: LineCursor[],
  current: LineCursor | null,
  delta: number,
): LineCursor | null {
  const currentIndex = current ? (cursorIndexes(cursors).get(cursorId(current)) ?? -1) : -1;
  if (currentIndex < 0) {
    return cursors[0] ?? null;
  }

  const nextIndex = Math.min(Math.max(currentIndex + delta, 0), cursors.length - 1);
  return cursors[nextIndex] ?? null;
}

/** Check whether one cursor still names a row the review stream renders. */
export function hasLineCursor(cursors: LineCursor[], cursor: LineCursor | null) {
  return cursor !== null && cursorIndexes(cursors).has(cursorId(cursor));
}

/** Keep a cursor pointing at a real line after filtering or a reload retires the one it was on. */
export function resolveLineCursor(
  cursors: LineCursor[],
  current: LineCursor | null,
): LineCursor | null {
  if (!current) {
    return null;
  }

  if (hasLineCursor(cursors, current)) {
    return current;
  }

  return nearestCursorInFile(cursors, current.fileId, current.hunkIndex) ?? null;
}

/**
 * Resolve the navigable line one note target sits on.
 *
 * Notes can address a side the stream does not stop on, so fall back to that line's own anchor,
 * which reveal and rendering still resolve through aliases.
 */
export function lineCursorAt(
  cursors: LineCursor[],
  fileId: string,
  hunkIndex: number,
  target: UserNoteLineTarget,
): LineCursor {
  const stop = cursors.find(
    (cursor) =>
      cursor.fileId === fileId &&
      cursor.hunkIndex === hunkIndex &&
      cursor.target.side === target.side &&
      cursor.target.line === target.line,
  );
  return (
    stop ?? {
      fileId,
      hunkIndex,
      stableKey: lineStableKey(hunkIndex, target.side, target.line),
      target,
    }
  );
}

/**
 * Check whether one cursor stands on the source line a caller named.
 *
 * A context row carries a single new-side target but renders one line under both sides'
 * numbers, so its old-side number addresses the same stop.
 */
function lineCursorAddresses(cursor: LineCursor, side: "old" | "new", line: number) {
  if (cursor.target.side === side && cursor.target.line === line) {
    return true;
  }

  const context = contextLineStableKeySides(cursor.stableKey);
  return context !== null && (side === "old" ? context.oldLine : context.newLine) === line;
}

/**
 * Find the rendered stop one file's source line sits on, addressed by side and number.
 *
 * Answers only for lines the review stream actually draws: a line hidden inside a collapsed
 * gap, or absent from a partial patch, has no cursor and no measured row to scroll to.
 */
export function findLineCursorAt(
  cursors: LineCursor[],
  fileId: string,
  side: "old" | "new",
  line: number,
): LineCursor | null {
  return (
    cursors.find((cursor) => cursor.fileId === fileId && lineCursorAddresses(cursor, side, line)) ??
    null
  );
}

/** Read one cursor's measured extent in whole-stream rows. */
export type LineCursorBoundsLookup = (cursor: LineCursor) => VerticalBounds | undefined;

/**
 * Find the first cursor whose row satisfies a monotonic viewport test.
 *
 * Cursor tops are non-decreasing, so both edges of the viewport resolve by binary search instead of
 * a walk over every row in the changeset.
 */
function firstCursorIndexWhere(
  cursors: LineCursor[],
  boundsOf: LineCursorBoundsLookup,
  reached: (bounds: VerticalBounds) => boolean,
) {
  let low = 0;
  let high = cursors.length;

  while (low < high) {
    const middle = (low + high) >>> 1;
    const bounds = boundsOf(cursors[middle]!);
    if (bounds && reached(bounds)) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }

  return low;
}

/** Keep the current line inside the viewport after the reviewer scrolls past it. */
export function clampLineCursorToViewport({
  boundsOf,
  current,
  cursors,
  scrollTop,
  viewportHeight,
}: {
  boundsOf: LineCursorBoundsLookup;
  current: LineCursor | null;
  cursors: LineCursor[];
  scrollTop: number;
  viewportHeight: number;
}): LineCursor | null {
  if (cursors.length === 0 || viewportHeight <= 0) {
    return current;
  }

  const viewportBottom = scrollTop + viewportHeight;
  const currentBounds = current ? boundsOf(current) : undefined;
  if (
    currentBounds &&
    currentBounds.top >= scrollTop &&
    currentBounds.top + currentBounds.height <= viewportBottom
  ) {
    return current;
  }

  const scrolledPastAbove = !currentBounds || currentBounds.top < scrollTop;
  const index = scrolledPastAbove
    ? firstCursorIndexWhere(cursors, boundsOf, (bounds) => bounds.top >= scrollTop)
    : firstCursorIndexWhere(
        cursors,
        boundsOf,
        (bounds) => bounds.top + bounds.height > viewportBottom,
      ) - 1;
  return cursors[Math.min(Math.max(index, 0), cursors.length - 1)] ?? null;
}
