import type { DiffFile } from "../../core/types";
import { getAnnotatedHunkIndices } from "./agentAnnotations";

export interface HunkCursor {
  fileId: string;
  hunkIndex: number;
}

/** Flatten the visible files into one review-stream hunk cursor list. */
export function buildHunkCursors(files: DiffFile[]): HunkCursor[] {
  return files.flatMap((file) =>
    file.metadata.hunks.map((_, hunkIndex) => ({ fileId: file.id, hunkIndex })),
  );
}

/** Flatten only the annotated hunks into a cursor list for comment navigation. */
export function buildAnnotatedHunkCursors(files: DiffFile[]): HunkCursor[] {
  return files.flatMap((file) => {
    const annotated = getAnnotatedHunkIndices(file);
    return file.metadata.hunks
      .map((_, hunkIndex) => ({ fileId: file.id, hunkIndex }))
      .filter((cursor) => annotated.has(cursor.hunkIndex));
  });
}

/** Move forward or backward through the review-stream hunk cursor list. */
export function findNextHunkCursor(
  cursors: HunkCursor[],
  currentFileId: string | undefined,
  currentHunkIndex: number,
  delta: number,
  streamCursors: HunkCursor[] = cursors,
): HunkCursor | null {
  if (cursors.length === 0) {
    return null;
  }

  const currentIndex = cursors.findIndex(
    (cursor) => cursor.fileId === currentFileId && cursor.hunkIndex === currentHunkIndex,
  );
  const nextIndex =
    currentIndex >= 0
      ? Math.min(Math.max(currentIndex + delta, 0), cursors.length - 1)
      : findNearestCursorIndex(cursors, streamCursors, currentFileId, currentHunkIndex, delta);

  return cursors[nextIndex] ?? null;
}

/** Resolve relative movement when the current hunk is not in the target cursor subset. */
function findNearestCursorIndex(
  cursors: HunkCursor[],
  streamCursors: HunkCursor[],
  currentFileId: string | undefined,
  currentHunkIndex: number,
  delta: number,
) {
  if (!currentFileId) {
    return delta >= 0 ? 0 : cursors.length - 1;
  }

  const currentStreamIndex = streamCursors.findIndex(
    (cursor) => cursor.fileId === currentFileId && cursor.hunkIndex === currentHunkIndex,
  );
  if (currentStreamIndex < 0) {
    return delta >= 0 ? 0 : cursors.length - 1;
  }

  const streamIndexByCursor = new Map(
    streamCursors.map((cursor, index) => [`${cursor.fileId}\0${cursor.hunkIndex}`, index] as const),
  );
  const cursorStreamIndex = (cursor: HunkCursor) =>
    streamIndexByCursor.get(`${cursor.fileId}\0${cursor.hunkIndex}`) ?? -1;
  const indexedCursors = cursors
    .map((cursor, index) => ({ index, streamIndex: cursorStreamIndex(cursor) }))
    .filter(({ streamIndex }) => streamIndex >= 0);

  if (indexedCursors.length === 0) {
    return delta >= 0 ? 0 : cursors.length - 1;
  }

  // Comment navigation is non-cyclic like normal hunk navigation, so positions outside
  // the annotated span clamp to the nearest annotated edge instead of wrapping.
  if (delta >= 0) {
    const nextCursor = indexedCursors.find(({ streamIndex }) => streamIndex > currentStreamIndex);
    return nextCursor?.index ?? indexedCursors[indexedCursors.length - 1]!.index;
  }

  for (let index = indexedCursors.length - 1; index >= 0; index -= 1) {
    const indexedCursor = indexedCursors[index]!;
    if (indexedCursor.streamIndex < currentStreamIndex) {
      return indexedCursor.index;
    }
  }

  return indexedCursors[0]!.index;
}
