/**
 * Line-granular navigation targets for the review stream.
 *
 * `hunks.ts` flattens the stream into hunks for `[` and `]`; this does the same one level down.
 * Targets come from `hunkContent` rather than the render plan, so they stay cheap to hold, but
 * they are ordered to match the rows the active layout actually draws. Lines revealed by
 * expanding a collapsed gap are still out of reach.
 */

import type { Hunk } from "@pierre/diffs";
import type { DiffFile, LayoutMode, UserNoteLineTarget } from "../../core/types";

type ResolvedLayout = Exclude<LayoutMode, "auto">;

export interface LineCursor {
  fileId: string;
  hunkIndex: number;
  target: UserNoteLineTarget;
}

const cursorsByFileMetadata = new WeakMap<
  DiffFile["metadata"],
  Map<ResolvedLayout, LineCursor[]>
>();

/** Enumerate the source lines one hunk renders, top to bottom. */
function hunkLineTargets(hunk: Hunk, layout: ResolvedLayout): UserNoteLineTarget[] {
  const targets: UserNoteLineTarget[] = [];
  let deletionLineNumber = hunk.deletionStart;
  let additionLineNumber = hunk.additionStart;

  for (const content of hunk.hunkContent) {
    if (content.type === "context") {
      for (let offset = 0; offset < content.lines; offset += 1) {
        // Both sides exist here; the new side is what the mouse affordance already anchors to.
        targets.push({ side: "new", line: additionLineNumber + offset });
      }

      deletionLineNumber += content.lines;
      additionLineNumber += content.lines;
      continue;
    }

    if (layout === "split") {
      // Split draws one row per pair, padding the shorter side, so the marker has to cross each
      // row before moving down instead of walking the whole old column first.
      const pairedLines = Math.max(content.deletions, content.additions);
      for (let offset = 0; offset < pairedLines; offset += 1) {
        if (offset < content.deletions) {
          targets.push({ side: "old", line: deletionLineNumber + offset });
        }

        if (offset < content.additions) {
          targets.push({ side: "new", line: additionLineNumber + offset });
        }
      }
    } else {
      for (let offset = 0; offset < content.deletions; offset += 1) {
        targets.push({ side: "old", line: deletionLineNumber + offset });
      }

      for (let offset = 0; offset < content.additions; offset += 1) {
        targets.push({ side: "new", line: additionLineNumber + offset });
      }
    }

    deletionLineNumber += content.deletions;
    additionLineNumber += content.additions;
  }

  return targets;
}

/**
 * List one file's cursors, reusing the last result while its parsed diff is unchanged.
 *
 * Selection changes rebuild the visible file array without reparsing, so this keeps a keypress
 * from reallocating one object per source line across the whole changeset.
 */
function fileLineCursors(file: DiffFile, layout: ResolvedLayout): LineCursor[] {
  let byLayout = cursorsByFileMetadata.get(file.metadata);
  if (!byLayout) {
    byLayout = new Map();
    cursorsByFileMetadata.set(file.metadata, byLayout);
  }

  const cached = byLayout.get(layout);
  if (cached) {
    return cached;
  }

  const cursors = file.metadata.hunks.flatMap((hunk, hunkIndex) =>
    hunkLineTargets(hunk, layout).map((target) => ({ fileId: file.id, hunkIndex, target })),
  );
  byLayout.set(layout, cursors);
  return cursors;
}

/** Flatten the visible files into one review-stream line cursor list. */
export function buildLineCursors(files: DiffFile[], layout: ResolvedLayout): LineCursor[] {
  return files.flatMap((file) => fileLineCursors(file, layout));
}

/** Check whether two cursors name the same review-stream line. */
function sameLineCursor(left: LineCursor, right: LineCursor) {
  return (
    left.fileId === right.fileId &&
    left.hunkIndex === right.hunkIndex &&
    left.target.side === right.target.side &&
    left.target.line === right.target.line
  );
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
