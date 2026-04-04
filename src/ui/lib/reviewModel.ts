import { findDiffFileByPath, findHunkIndexForLine, hunkLineRange } from "../../core/liveComments";
import type { DiffFile } from "../../core/types";
import type { LiveComment, NavigateToHunkToolInput, SelectedHunkSummary } from "../../mcp/types";
import {
  buildSidebarEntries,
  filterReviewFiles,
  mergeFileAnnotationsByFileId,
  type SidebarEntry,
} from "./files";
import {
  buildAnnotatedHunkCursors,
  buildHunkCursors,
  findNextHunkCursor,
  type HunkCursor,
} from "./hunks";

export interface BuildReviewModelOptions {
  files: DiffFile[];
  liveCommentsByFileId: Record<string, LiveComment[]>;
  filterQuery: string;
  selectedFileId: string;
  selectedHunkIndex: number;
}

export interface ReviewModel {
  allFiles: DiffFile[];
  visibleFiles: DiffFile[];
  sidebarEntries: SidebarEntry[];
  selectedFile: DiffFile | undefined;
  selectedHunk: DiffFile["metadata"]["hunks"][number] | undefined;
  hunkCursors: HunkCursor[];
  annotatedHunkCursors: HunkCursor[];
}

export interface ReviewNavigationTarget {
  file: DiffFile;
  hunkIndex: number;
  scrollToNote: boolean;
}

/** Build the derived review stream state from files, filter text, and selection. */
export function buildReviewModel({
  files,
  liveCommentsByFileId,
  filterQuery,
  selectedFileId,
  selectedHunkIndex,
}: BuildReviewModelOptions): ReviewModel {
  const allFiles = mergeFileAnnotationsByFileId(files, liveCommentsByFileId);
  const visibleFiles = filterReviewFiles(allFiles, filterQuery);
  const selectedFile = resolveSelectedFile(allFiles, visibleFiles, selectedFileId);

  return {
    allFiles,
    visibleFiles,
    sidebarEntries: buildSidebarEntries(visibleFiles),
    selectedFile,
    selectedHunk: selectedFile?.metadata.hunks[selectedHunkIndex],
    hunkCursors: buildHunkCursors(visibleFiles),
    annotatedHunkCursors: buildAnnotatedHunkCursors(visibleFiles),
  };
}

/** Resolve the selected file using the visible stream first, then the hidden current selection. */
export function resolveSelectedFile(
  allFiles: DiffFile[],
  visibleFiles: DiffFile[],
  selectedFileId: string,
) {
  return (
    visibleFiles.find((file) => file.id === selectedFileId) ??
    allFiles.find((file) => file.id === selectedFileId) ??
    visibleFiles[0]
  );
}

/** Format the currently selected hunk for daemon snapshots and session command replies. */
export function buildSelectedHunkSummary(file: DiffFile, hunkIndex: number): SelectedHunkSummary {
  const hunk = file.metadata.hunks[hunkIndex];
  return hunk
    ? {
        index: hunkIndex,
        ...hunkLineRange(hunk),
      }
    : {
        index: hunkIndex,
      };
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
  const nextIndex = (normalizedIndex + delta + annotatedFiles.length) % annotatedFiles.length;
  return annotatedFiles[nextIndex] ?? null;
}

/** Resolve one MCP navigation request against the review stream's current state. */
export function resolveReviewNavigationTarget({
  allFiles,
  currentFileId,
  currentHunkIndex,
  input,
  visibleFiles,
}: {
  allFiles: DiffFile[];
  visibleFiles: DiffFile[];
  currentFileId: string | undefined;
  currentHunkIndex: number;
  input: NavigateToHunkToolInput;
}): ReviewNavigationTarget {
  if (input.commentDirection) {
    const delta = input.commentDirection === "next" ? 1 : -1;
    const annotatedCursors = buildAnnotatedHunkCursors(visibleFiles);
    const nextCursor = findNextHunkCursor(annotatedCursors, currentFileId, currentHunkIndex, delta);

    if (!nextCursor) {
      throw new Error("No annotated hunks found in the current review.");
    }

    const targetFile = visibleFiles.find((file) => file.id === nextCursor.fileId);
    if (!targetFile) {
      throw new Error("Resolved annotated hunk references an unknown file.");
    }

    return {
      file: targetFile,
      hunkIndex: nextCursor.hunkIndex,
      scrollToNote: true,
    };
  }

  if (!input.filePath) {
    throw new Error("navigate requires --file when not using --next-comment or --prev-comment.");
  }

  const file = findDiffFileByPath(allFiles, input.filePath);
  if (!file) {
    throw new Error(`No visible diff file matches ${input.filePath}.`);
  }

  let hunkIndex = input.hunkIndex;
  if (hunkIndex === undefined) {
    if (!input.side || input.line === undefined) {
      throw new Error("navigate_to_hunk requires either hunkIndex or both side and line.");
    }

    hunkIndex = findHunkIndexForLine(file, input.side, input.line);
  }

  if (hunkIndex < 0 || hunkIndex >= file.metadata.hunks.length) {
    throw new Error(`No diff hunk in ${input.filePath} matches the requested target.`);
  }

  return {
    file,
    hunkIndex,
    scrollToNote: false,
  };
}
