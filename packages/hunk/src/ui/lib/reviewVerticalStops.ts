/**
 * Builds the keyboard's vertical review stops from the rows the active presentation measures.
 * Source lines and semantic note cards share visual order; decoration-only annotations never
 * become stops because they carry no stored-note identity.
 */
import type { DiffFile } from "../../core/changeset/model";
import type { DiffSectionGeometry } from "../diff/diffSectionGeometry";
import type { LineCursor } from "./lineCursors";

export type ReviewVerticalStop =
  | { kind: "line"; cursor: LineCursor }
  | {
      kind: "note";
      fileId: string;
      hunkIndex: number;
      noteId: string;
      stableKey: string;
    };

export const EMPTY_REVIEW_VERTICAL_STOPS: ReviewVerticalStop[] = [];

const indexesByStopList = new WeakMap<ReviewVerticalStop[], Map<string, number>>();

/** Identify one stop independently of newly allocated wrapper objects. */
function reviewVerticalStopId(stop: ReviewVerticalStop) {
  return stop.kind === "line"
    ? `line\u0000${stop.cursor.fileId}\u0000${stop.cursor.stableKey}`
    : `note\u0000${stop.fileId}\u0000${stop.noteId}`;
}

/** Flatten canonical measured rows into source-line and semantic-note stops. */
export function buildReviewVerticalStops(
  files: DiffFile[],
  sectionGeometry: DiffSectionGeometry[],
  lineCursors: LineCursor[],
): ReviewVerticalStop[] {
  const lineCursorByKey = new Map(
    lineCursors.map((cursor) => [`${cursor.fileId}\u0000${cursor.stableKey}`, cursor] as const),
  );

  return files.flatMap((file, sectionIndex) => {
    const geometry = sectionGeometry[sectionIndex];
    if (!geometry) return [];

    const plannedRows = geometry.fileViewRows ?? geometry.plannedRows;
    const plannedRowByStableKey = new Map(plannedRows.map((row) => [row.stableKey, row] as const));
    const stops: ReviewVerticalStop[] = [];

    for (const bounds of geometry.rowBounds) {
      const plannedRow = plannedRowByStableKey.get(bounds.stableKey);
      if (plannedRow?.kind === "inline-note") {
        const noteId =
          plannedRow.note.source === "draft" ? undefined : plannedRow.note.thread?.noteId;
        if (noteId) {
          stops.push({
            kind: "note",
            fileId: file.id,
            hunkIndex: plannedRow.hunkIndex,
            noteId,
            stableKey: bounds.stableKey,
          });
        }
        continue;
      }

      const stableKeys = [
        bounds.stableKey,
        ...bounds.stableKeys.filter((key) => key !== bounds.stableKey),
      ];
      for (const stableKey of stableKeys) {
        const cursor = lineCursorByKey.get(`${file.id}\u0000${stableKey}`);
        if (cursor) stops.push({ kind: "line", cursor });
      }
    }

    return stops;
  });
}

/** Reuse the previous stop list when remeasurement preserved the same visual targets. */
export function reuseEquivalentReviewVerticalStops(
  previous: ReviewVerticalStop[],
  next: ReviewVerticalStop[],
) {
  return previous.length === next.length &&
    next.every(
      (stop, index) => reviewVerticalStopId(stop) === reviewVerticalStopId(previous[index]!),
    )
    ? previous
    : next;
}

/** Create a stabilizer that compares only newly measured stop lists. */
export function createReviewVerticalStopStabilizer() {
  let measured = EMPTY_REVIEW_VERTICAL_STOPS;
  let stable = EMPTY_REVIEW_VERTICAL_STOPS;
  return (next: ReviewVerticalStop[]) => {
    if (next !== measured) {
      measured = next;
      stable = reuseEquivalentReviewVerticalStops(stable, next);
    }
    return stable;
  };
}

/** Index one stable stop list so repeated vertical movement stays constant-time. */
function reviewVerticalStopIndexes(stops: ReviewVerticalStop[]) {
  let indexes = indexesByStopList.get(stops);
  if (!indexes) {
    indexes = new Map(stops.map((stop, index) => [reviewVerticalStopId(stop), index]));
    indexesByStopList.set(stops, indexes);
  }
  return indexes;
}

/** Move through mixed review stops, clamping at the first and last rendered target. */
export function findNextReviewVerticalStop(
  stops: ReviewVerticalStop[],
  current: ReviewVerticalStop | null,
  delta: number,
): ReviewVerticalStop | null {
  if (stops.length === 0) return null;
  const currentId = current ? reviewVerticalStopId(current) : null;
  const currentIndex = currentId ? (reviewVerticalStopIndexes(stops).get(currentId) ?? -1) : -1;
  if (currentIndex < 0) return delta < 0 ? (stops.at(-1) ?? null) : (stops[0] ?? null);
  const nextIndex = Math.min(Math.max(currentIndex + delta, 0), stops.length - 1);
  return stops[nextIndex] ?? null;
}

/** Move only between semantic note stops using the active surface's rendered order. */
export function findNextReviewNoteStop(
  stops: ReviewVerticalStop[],
  current: ReviewVerticalStop | null,
  delta: number,
): Extract<ReviewVerticalStop, { kind: "note" }> | null {
  if (delta === 0) return null;
  const notes = stops.filter(
    (stop): stop is Extract<ReviewVerticalStop, { kind: "note" }> => stop.kind === "note",
  );
  if (notes.length === 0) return null;

  if (current?.kind === "note") {
    const currentIndex = notes.findIndex((note) => note.noteId === current.noteId);
    if (currentIndex >= 0) {
      const nextIndex = Math.min(Math.max(currentIndex + delta, 0), notes.length - 1);
      return nextIndex === currentIndex ? null : (notes[nextIndex] ?? null);
    }
  }

  const currentIndex = current
    ? (reviewVerticalStopIndexes(stops).get(reviewVerticalStopId(current)) ?? -1)
    : -1;
  const candidates = notes.filter((note) => {
    const index = reviewVerticalStopIndexes(stops).get(reviewVerticalStopId(note)) ?? -1;
    return delta > 0 ? index > currentIndex : currentIndex < 0 || index < currentIndex;
  });
  const nearest = delta > 0 ? candidates[0] : candidates.at(-1);
  if (!nearest) return null;
  const remaining = Math.abs(delta) - 1;
  const nearestIndex = notes.indexOf(nearest);
  return (
    notes[Math.min(Math.max(nearestIndex + Math.sign(delta) * remaining, 0), notes.length - 1)] ??
    null
  );
}
