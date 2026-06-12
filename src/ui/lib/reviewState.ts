/**
 * Pure review-stream derivation helpers used by `useReviewController`.
 *
 * This module turns raw diff files plus live comments into the current visible
 * review state, sidebar entries, hunk cursors, and session-daemon navigation targets. It
 * stays side-effect free so selection and navigation rules can be shared and
 * tested without React state in the loop.
 */
import { findDiffFileByPath, findHunkIndexForLine, hunkLineRange } from "../../core/liveComments";
import { resolveReviewedHunkIndices } from "../../core/reviewedHunks";
import type { AgentAnnotation, DiffFile } from "../../core/types";
import type { NavigateToHunkToolInput, SelectedHunkSummary } from "../../hunk-session/types";
import {
  buildSidebarEntries,
  filterReviewFiles,
  mergeFileAnnotationsByFileId,
  type SidebarEntry,
} from "./files";
import {
  buildAnnotatedHunkCursors,
  buildHunkCursors,
  buildUnreviewedHunkCursors,
  findNextHunkCursor,
  type HunkCursor,
} from "./hunks";

export interface BuildReviewStateOptions {
  files: DiffFile[];
  liveCommentsByFileId: Record<string, AgentAnnotation[]>;
  filterQuery: string;
  selectedFileId: string;
  selectedHunkIndex: number;
  reviewedHashes: ReadonlySet<string>;
  expandedReviewedHunksByFileId: Record<string, ReadonlySet<number>>;
}

export interface ReviewState {
  allFiles: DiffFile[];
  visibleFiles: DiffFile[];
  sidebarEntries: SidebarEntry[];
  selectedFile: DiffFile | undefined;
  selectedHunk: DiffFile["metadata"]["hunks"][number] | undefined;
  hunkCursors: HunkCursor[];
  annotatedHunkCursors: HunkCursor[];
  // Hunk indices whose content hash is in the reviewed set, per visible file.
  reviewedHunkIndicesByFileId: Record<string, ReadonlySet<number>>;
  // Reviewed hunks currently rendered as collapsed markers (reviewed minus
  // explicitly expanded ones).
  collapsedReviewedHunksByFileId: Record<string, ReadonlySet<number>>;
  // Stream cursors that still need review. `[`/`]` walk the full stream
  // (markers included so they can be expanded or un-marked from the
  // keyboard); this subset only drives mark-and-advance.
  unreviewedHunkCursors: HunkCursor[];
}

export interface ReviewNavigationTarget {
  file: DiffFile;
  hunkIndex: number;
  scrollToNote: boolean;
}

/** Build the derived review stream state from files, filter text, and selection. */
export function buildReviewState({
  files,
  liveCommentsByFileId,
  filterQuery,
  selectedFileId,
  selectedHunkIndex,
  reviewedHashes,
  expandedReviewedHunksByFileId,
}: BuildReviewStateOptions): ReviewState {
  const allFiles = mergeFileAnnotationsByFileId(files, liveCommentsByFileId);
  const visibleFiles = filterReviewFiles(allFiles, filterQuery);
  const selectedFile = resolveSelectedFile(allFiles, visibleFiles, selectedFileId);

  const reviewedHunkIndicesByFileId: Record<string, ReadonlySet<number>> = {};
  const collapsedReviewedHunksByFileId: Record<string, ReadonlySet<number>> = {};
  for (const file of visibleFiles) {
    const reviewed = resolveReviewedHunkIndices(file, reviewedHashes);
    if (reviewed.size === 0) {
      continue;
    }

    reviewedHunkIndicesByFileId[file.id] = reviewed;
    const expanded = expandedReviewedHunksByFileId[file.id];
    const collapsed = expanded
      ? new Set([...reviewed].filter((hunkIndex) => !expanded.has(hunkIndex)))
      : reviewed;
    if (collapsed.size > 0) {
      collapsedReviewedHunksByFileId[file.id] = collapsed;
    }
  }

  return {
    allFiles,
    visibleFiles,
    sidebarEntries: buildSidebarEntries(visibleFiles, reviewedHunkIndicesByFileId),
    selectedFile,
    selectedHunk: selectedFile?.metadata.hunks[selectedHunkIndex],
    hunkCursors: buildHunkCursors(visibleFiles),
    annotatedHunkCursors: buildAnnotatedHunkCursors(visibleFiles),
    reviewedHunkIndicesByFileId,
    collapsedReviewedHunksByFileId,
    unreviewedHunkCursors: buildUnreviewedHunkCursors(visibleFiles, reviewedHunkIndicesByFileId),
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

/** Resolve one session-daemon navigation request against the review stream's current state. */
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
    const hunkCursors = buildHunkCursors(visibleFiles);
    const annotatedCursors = buildAnnotatedHunkCursors(visibleFiles);
    const nextCursor = findNextHunkCursor(
      annotatedCursors,
      currentFileId,
      currentHunkIndex,
      delta,
      hunkCursors,
    );

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
    throw new Error(`No diff file matches ${input.filePath}.`);
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
