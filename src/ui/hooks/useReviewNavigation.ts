import { useCallback, useMemo } from "react";
import type { DiffFile } from "../../core/types";
import { buildAnnotatedHunkCursors, buildHunkCursors, findNextHunkCursor } from "../lib/hunks";

interface UseReviewNavigationOptions {
  files: DiffFile[];
  jumpToAnnotatedHunk: (fileId: string, hunkIndex?: number) => void;
  jumpToFile: (fileId: string, hunkIndex?: number) => void;
  selectedFileId: string | undefined;
  selectedHunkIndex: number;
}

/** Coordinate hunk and file navigation across the visible review stream. */
export function useReviewNavigation({
  files,
  jumpToAnnotatedHunk,
  jumpToFile,
  selectedFileId,
  selectedHunkIndex,
}: UseReviewNavigationOptions) {
  const hunkCursors = useMemo(() => buildHunkCursors(files), [files]);
  const annotatedHunkCursors = useMemo(() => buildAnnotatedHunkCursors(files), [files]);

  const moveHunk = useCallback(
    (delta: number) => {
      const nextCursor = findNextHunkCursor(hunkCursors, selectedFileId, selectedHunkIndex, delta);
      if (nextCursor) {
        jumpToFile(nextCursor.fileId, nextCursor.hunkIndex);
      }
    },
    [hunkCursors, jumpToFile, selectedFileId, selectedHunkIndex],
  );

  const moveAnnotatedHunk = useCallback(
    (delta: number) => {
      const nextCursor = findNextHunkCursor(
        annotatedHunkCursors,
        selectedFileId,
        selectedHunkIndex,
        delta,
      );
      if (nextCursor) {
        jumpToAnnotatedHunk(nextCursor.fileId, nextCursor.hunkIndex);
      }
    },
    [annotatedHunkCursors, jumpToAnnotatedHunk, selectedFileId, selectedHunkIndex],
  );

  const moveAnnotatedFile = useCallback(
    (delta: number) => {
      const annotatedFiles = files.filter((file) => file.agent);
      if (annotatedFiles.length === 0) {
        return;
      }

      const currentIndex = annotatedFiles.findIndex((file) => file.id === selectedFileId);
      const nextIndex =
        ((currentIndex >= 0 ? currentIndex : 0) + delta + annotatedFiles.length) %
        annotatedFiles.length;
      const nextFile = annotatedFiles[nextIndex];
      if (nextFile) {
        jumpToFile(nextFile.id);
      }
    },
    [files, jumpToFile, selectedFileId],
  );

  const openAgentNotesAtHunk = useCallback(
    (fileId: string, hunkIndex: number) => {
      jumpToFile(fileId, hunkIndex);
    },
    [jumpToFile],
  );

  return { moveAnnotatedFile, moveAnnotatedHunk, moveHunk, openAgentNotesAtHunk };
}
