/**
 * The review selection snapshot extension code receives.
 *
 * Sidebar components already get the selection as props; command handlers used
 * to get nothing, and had to shadow-track `selection_changed` into module state
 * to answer "which file am I on?". Both now resolve through this one function,
 * fed the same frozen file views the sidebar panes render from, so a command
 * and a sidebar can never disagree about what is selected.
 */
import { readMetadataHunkCount } from "../../extensions/events";
import type { ExtensionDiffFile, ExtensionReviewSelection } from "../../extension-api/types";
import type { LineCursor } from "./lineCursors";

export interface BuildExtensionReviewSelectionOptions {
  /**
   * The visible review-stream files as frozen read-only views, in stream order.
   *
   * Already converted by `toReadOnlyFileViews`: this function selects from that
   * list rather than projecting files itself, which is what keeps one
   * conversion pipeline between the host model and everything extensions see.
   */
  files: readonly ExtensionDiffFile[];
  selectedFileId: string | null;
  selectedHunkIndex: number | null;
  /** The visible current-line cursor, after App applies the cursor-line preference. */
  lineCursor?: Pick<LineCursor, "fileId" | "hunkIndex" | "target"> | null;
}

/**
 * Resolve the current selection into the snapshot extensions see.
 *
 * The selected id is resolved against the *visible* files only: a selection the
 * file filter hides is reported as no selection, because a file an extension
 * cannot find in `files` is not one it can act on. The hunk index is clamped
 * into the file's real hunk range — a reload can shrink a file under a
 * selection that has not caught up yet — and is `null` for a file with no hunks
 * at all, matching the same clamp the sidebar's `selectHunk` action applies.
 */
export function buildExtensionReviewSelection({
  files,
  selectedFileId,
  selectedHunkIndex,
  lineCursor = null,
}: BuildExtensionReviewSelectionOptions): ExtensionReviewSelection {
  const file =
    selectedFileId === null
      ? undefined
      : files.find((candidate) => candidate.id === selectedFileId);

  if (!file) {
    return Object.freeze({ file: null, hunkIndex: null, currentLine: null });
  }

  const hunkIndex = resolveHunkIndex(file, selectedHunkIndex);
  return Object.freeze({
    file,
    hunkIndex,
    currentLine: selectedLineCursor(file.id, hunkIndex, lineCursor),
  });
}

/** Copy the current source target only when it belongs to this public selection. */
function selectedLineCursor(
  fileId: string,
  hunkIndex: number | null,
  lineCursor: Pick<LineCursor, "fileId" | "hunkIndex" | "target"> | null,
) {
  if (!lineCursor || lineCursor.fileId !== fileId || lineCursor.hunkIndex !== hunkIndex) {
    return null;
  }

  return Object.freeze({ side: lineCursor.target.side, line: lineCursor.target.line });
}

/** Clamp one selected hunk index into a file's real hunk range, or drop it. */
function resolveHunkIndex(file: ExtensionDiffFile, selectedHunkIndex: number | null) {
  if (selectedHunkIndex === null || !Number.isFinite(selectedHunkIndex)) {
    return null;
  }

  const hunkCount = readMetadataHunkCount(file.metadata);
  if (hunkCount === 0) {
    return null;
  }

  return Math.min(Math.max(0, Math.floor(selectedHunkIndex)), hunkCount - 1);
}
