/**
 * Pure review-stream derivation helpers used by `useTerminalReview`.
 *
 * This module turns raw diff files plus live comments into the current visible review
 * state, the terminal's selection-reconciliation follow-up, and absolute session-daemon
 * navigation targets. It stays side-effect free so selection and navigation rules can be
 * tested without React state in the loop.
 *
 * Relative navigation lives in `core/review/navigation.ts` and the annotation index it
 * plans against in `core/review/annotations.ts`: both are shared with every other review
 * surface rather than derived per renderer.
 */
import { findDiffFileByPath, findHunkIndexForLine } from "../../core/liveComments";
import type { ReviewAction } from "../../core/review/actions";
import { reviewHunkRanges } from "../../core/review/geometry";
import { reviewFileMatchesFilter, selectNormalizedSelection } from "../../core/review/selectors";
import type { ReviewState } from "../../core/review/state";
import { noDiffFileMatchesMessage } from "../../session/agent/errors";
import type { DiffFile } from "../../core/changeset/model";
import type { AgentAnnotation } from "../../extension-api/types";
import type { NavigateToHunkToolInput, SelectedHunkSummary } from "../../session/types";
import { mergeFileAnnotationsByFileId } from "./files";

export interface BuildReviewStreamStateOptions {
  files: DiffFile[];
  liveCommentsByFileId: Record<string, AgentAnnotation[]>;
  filterQuery: string;
}

export interface ReviewStreamState {
  allFiles: DiffFile[];
  visibleFiles: DiffFile[];
}

export interface ReviewNavigationTarget {
  file: DiffFile;
  hunkIndex: number;
}

/** Build selection-independent review stream state from files and filter text. */
export function buildReviewStreamState({
  files,
  liveCommentsByFileId,
  filterQuery,
}: BuildReviewStreamStateOptions): ReviewStreamState {
  const allFiles = mergeFileAnnotationsByFileId(files, liveCommentsByFileId);

  return {
    allFiles,
    // The shared matcher, not a terminal copy of it: sidebar, review stream, and every
    // other surface must agree on what one query matches.
    visibleFiles: allFiles.filter((file) =>
      reviewFileMatchesFilter(
        {
          path: file.path,
          ...(file.previousPath !== undefined ? { previousPath: file.previousPath } : {}),
          ...(file.agent?.summary !== undefined ? { agentSummary: file.agent.summary } : {}),
        },
        filterQuery,
      ),
    ),
  };
}

/**
 * Plan the terminal follow-up when a document replacement invalidates its selection.
 *
 * A filter only changes the visible stream, so a selected file it hides stays selected.
 * The shared selector instead supplies a replacement only when the selected file vanished
 * or its hunk index became stale. This returns no reveal request: reconciliation must not
 * move the reviewer's viewport.
 */
export function planTerminalSelectionReconciliation(
  state: ReviewState,
): Extract<ReviewAction, { type: "selection/select" }> | undefined {
  const normalized = selectNormalizedSelection(state);
  const fileKey = normalized.fileKey;
  if (
    fileKey === null ||
    (fileKey === state.selection.fileKey && normalized.hunkIndex === state.selection.hunkIndex)
  ) {
    return undefined;
  }

  return { type: "selection/select", fileKey, hunkIndex: normalized.hunkIndex };
}

/** Format the currently selected hunk for daemon snapshots and session command replies. */
export function buildSelectedHunkSummary(file: DiffFile, hunkIndex: number): SelectedHunkSummary {
  const hunk = file.metadata.hunks[hunkIndex];
  return hunk
    ? {
        index: hunkIndex,
        ...reviewHunkRanges(hunk),
      }
    : {
        index: hunkIndex,
      };
}

/**
 * Resolve one absolute session-daemon navigation request against the review stream.
 *
 * Absolute only — a path plus either a hunk index or a side and line. Relative requests
 * (`--next-comment` / `--prev-comment`) are the same walk the keyboard performs and are
 * planned through the shared `selection/move` intent instead of being resolved here.
 */
export function resolveReviewNavigationTarget({
  allFiles,
  input,
}: {
  allFiles: DiffFile[];
  input: NavigateToHunkToolInput;
}): ReviewNavigationTarget {
  if (!input.filePath) {
    throw new Error("navigate requires --file when not using --next-comment or --prev-comment.");
  }

  const file = findDiffFileByPath(allFiles, input.filePath);
  if (!file) {
    throw new Error(noDiffFileMatchesMessage(input.filePath));
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

  return { file, hunkIndex };
}
