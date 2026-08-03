/**
 * Line-granular navigation targets for the review stream.
 *
 * `hunks.ts` flattens the stream into hunks for `[` and `]`; this does the same one level down.
 * Stops come from the measured render plan rather than the parsed diff, so the marker visits exactly
 * the rows the active layout draws — expanded gaps and alternate file presentations included — and
 * every stop carries the plan anchor that rendering, reveal, and note placement already key on.
 */

import type { DiffFile, UserNoteLineTarget } from "../../core/types";
import type { DiffSectionGeometry, DiffSectionRowBounds } from "../diff/diffSectionGeometry";
import { contextLineStableKeyTarget, lineStableKeyTarget } from "../diff/reviewRenderPlan";
import type { VerticalBounds } from "./diffSpatial";

export interface LineCursor {
  fileId: string;
  hunkIndex: number;
  /** The render plan's anchor for this row, shared with reveal and highlight lookups. */
  stableKey: string;
  target: UserNoteLineTarget;
}

const cursorsBySectionGeometry = new WeakMap<DiffSectionGeometry, LineCursor[]>();

/** Enumerate the navigable stops one measured row renders, left to right. */
function rowLineCursors(fileId: string, bounds: DiffSectionRowBounds): LineCursor[] {
  // A context row shows one source line on both sides, so its sided anchors name the same position.
  const context = contextLineStableKeyTarget(bounds.stableKey);
  if (context) {
    const { hunkIndex, ...target } = context;
    return [{ fileId, hunkIndex, stableKey: bounds.stableKey, target }];
  }

  const cursors: LineCursor[] = [];
  for (const stableKey of bounds.stableKeys) {
    const anchor = lineStableKeyTarget(stableKey);
    if (!anchor) {
      continue;
    }

    const { hunkIndex, ...target } = anchor;
    cursors.push({ fileId, hunkIndex, stableKey, target });
  }

  return cursors;
}

/**
 * List one file's cursors, reusing the last result while its measured rows are unchanged.
 *
 * Geometry is already cached per file, so this keeps a keypress from reallocating one object per
 * rendered row across the whole changeset.
 */
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

/** Check whether two cursors name the same review-stream row. */
function sameLineCursor(left: LineCursor, right: LineCursor) {
  return left.fileId === right.fileId && left.stableKey === right.stableKey;
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
  const currentIndex = current
    ? cursors.findIndex((cursor) => sameLineCursor(cursor, current))
    : -1;
  if (currentIndex < 0) {
    return cursors[0] ?? null;
  }

  // Line navigation is non-cyclic like hunk navigation, so both ends of the stream clamp.
  const nextIndex = Math.min(Math.max(currentIndex + delta, 0), cursors.length - 1);
  return cursors[nextIndex] ?? null;
}

/**
 * Keep a cursor pointing at a real line after filtering or a reload retires the one it was on.
 *
 * Falls back toward the same hunk and then the same file, mirroring how file selection recovers.
 */
export function resolveLineCursor(
  cursors: LineCursor[],
  current: LineCursor | null,
): LineCursor | null {
  if (!current) {
    return null;
  }

  if (cursors.some((cursor) => sameLineCursor(cursor, current))) {
    return current;
  }

  return nearestCursorInFile(cursors, current.fileId, current.hunkIndex) ?? null;
}

/** Read one cursor's measured extent in whole-stream rows. */
export type LineCursorBoundsLookup = (cursor: LineCursor) => VerticalBounds | undefined;
