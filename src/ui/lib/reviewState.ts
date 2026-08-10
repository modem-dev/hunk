/**
 * Pure review-stream derivation helpers used by `useReviewController`.
 *
 * This module turns raw diff files plus live comments into the current visible
 * review state, sidebar entries, and terminal hunk cursors. It stays side-effect
 * free so selection and navigation rules can be tested without React state.
 */
import type { AgentAnnotation, DiffFile } from "../../core/types";
import { filterReviewFiles, mergeFileAnnotationsByFileId } from "./files";
import { buildNoteOwnerHunkCursors, buildHunkCursors, type HunkCursor } from "./hunks";

export interface BuildReviewStreamStateOptions {
  files: DiffFile[];
  liveCommentsByFileId: Record<string, AgentAnnotation[]>;
  filterQuery: string;
}

export interface ReviewStreamState {
  allFiles: DiffFile[];
  visibleFiles: DiffFile[];
  hunkCursors: HunkCursor[];
  annotatedHunkCursors: HunkCursor[];
}

/** Build selection-independent review stream state from files and filter text. */
export function buildReviewStreamState({
  files,
  liveCommentsByFileId,
  filterQuery,
}: BuildReviewStreamStateOptions): ReviewStreamState {
  const allFiles = mergeFileAnnotationsByFileId(files, liveCommentsByFileId);
  const visibleFiles = filterReviewFiles(allFiles, filterQuery);

  return {
    allFiles,
    visibleFiles,
    hunkCursors: buildHunkCursors(visibleFiles),
    annotatedHunkCursors: buildNoteOwnerHunkCursors(visibleFiles),
  };
}

/** Resolve the store-authoritative selection only when it is in the visible stream. */
export function resolveSelectedFile(visibleFiles: DiffFile[], selectedFileId: string) {
  return visibleFiles.find((file) => file.id === selectedFileId);
}

/** Find the next or previous annotated file in the current visible review stream. */
export function findNextAnnotatedFile(
  visibleFiles: DiffFile[],
  currentFileId: string | undefined,
  delta: number,
) {
  const annotatedFiles = visibleFiles.filter((file) => file.agent);
  if (annotatedFiles.length === 0) {
    return null;
  }

  const currentIndex = annotatedFiles.findIndex((file) => file.id === currentFileId);
  const normalizedIndex = currentIndex >= 0 ? currentIndex : 0;
  const nextIndex =
    (((normalizedIndex + delta) % annotatedFiles.length) + annotatedFiles.length) %
    annotatedFiles.length;
  return annotatedFiles[nextIndex] ?? null;
}
