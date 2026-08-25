import type { ExtensionReviewNavigation } from "../../extension-api/types";
import type { ExtensionNotifySink } from "../../extensions/types";

/**
 * The file fields navigation guarding reads: identity to validate a target,
 * parsed hunks to clamp an index. Structural so the sidebar pane's `files`
 * prop and App's live visible-files ref both satisfy it without conversion.
 */
interface NavigableFile {
  id: string;
  metadata: { hunks: readonly unknown[] };
}

/** Read an error's message without assuming extension code throws `Error` instances. */
function describeError(error: unknown) {
  if (error instanceof Error) {
    return error.message || error.name;
  }

  return String(error);
}

export interface CreateGuardedReviewNavigationOptions {
  extensionId: string;
  /**
   * The currently visible review-stream files, read per call.
   *
   * A getter rather than a list so one navigation object can stay
   * identity-stable while the review moves underneath it — a command handler
   * that awaits a dialog and then navigates must be validated against the
   * files visible *now*, not the ones visible when its key fired.
   */
  getFiles: () => readonly NavigableFile[];
  /**
   * Whether the review surface this navigation was minted for still exists.
   *
   * A session reload may remount the whole app (`resetApp`), and a command
   * handler still in flight across that remount holds navigation closing over
   * the unmounted instance — its file list frozen at the old review, its
   * callbacks driving a controller whose state updates no longer render.
   * Checked per call, so such a handler gets an accurate refusal instead of a
   * stale validation or a silent no-op. Omitted means always live, which is
   * right for a sidebar's actions: the pane unmounts with the instance.
   */
  isLive?: () => boolean;
  notify: ExtensionNotifySink;
  onSelectFile: (fileId: string) => void;
  onSelectHunk: (fileId: string, hunkIndex: number) => void;
  /**
   * Jump to one source line, reporting which target the review could reach.
   *
   * `"line"` and `"hunk"` both moved the review; `"none"` means the line is nowhere in the
   * file, which only this guard can report with the extension's name on it.
   */
  onRevealLine: (fileId: string, side: "old" | "new", line: number) => "line" | "hunk" | "none";
}

/**
 * Build the guarded review navigation extension surfaces share.
 *
 * One builder behind both a sidebar's `actions` and a command handler's
 * `navigation`, so every extension-driven jump enforces the same contract: a
 * target is refused (with a warning naming the extension) unless it is a
 * currently visible file, a hunk index is clamped into the file's real hunk
 * range, and a failure inside the host callback becomes a warning instead of
 * unwinding into extension code.
 */
export function createGuardedReviewNavigation({
  extensionId,
  getFiles,
  isLive,
  notify,
  onSelectFile,
  onSelectHunk,
  onRevealLine,
}: CreateGuardedReviewNavigationOptions): ExtensionReviewNavigation {
  /** Resolve a navigation target, or report one the review stream cannot show. */
  const resolveVisibleFile = (method: string, fileId: string) => {
    const file = getFiles().find((candidate) => candidate.id === fileId);
    if (!file) {
      notify(`Extension ${extensionId} ${method} targeted unknown file id "${fileId}"`, "warning");
    }

    return file;
  };

  /** Turn one action failure into a warning naming the extension. */
  const guard = (method: string, run: () => void) => {
    if (isLive && !isLive()) {
      notify(
        `Extension ${extensionId} ${method} ignored — the review session was reloaded`,
        "warning",
      );
      return;
    }

    try {
      run();
    } catch (error) {
      notify(`Extension ${extensionId} failed ${method} • ${describeError(error)}`, "warning");
    }
  };

  return Object.freeze({
    selectFile(fileId: string) {
      guard("selectFile", () => {
        if (resolveVisibleFile("selectFile", fileId)) {
          onSelectFile(fileId);
        }
      });
    },
    selectHunk(fileId: string, hunkIndex: number) {
      guard("selectHunk", () => {
        const file = resolveVisibleFile("selectHunk", fileId);
        if (!file) {
          return;
        }

        // Selection state, reveal scrolling, and `selection_changed` all
        // carry this index, so an out-of-range or non-numeric value must not
        // reach the controller: refuse garbage, clamp the rest into the
        // file's real hunk range.
        if (typeof hunkIndex !== "number" || !Number.isFinite(hunkIndex)) {
          notify(
            `Extension ${extensionId} selectHunk received an invalid hunk index for "${fileId}"`,
            "warning",
          );
          return;
        }

        const maxHunkIndex = Math.max(0, file.metadata.hunks.length - 1);
        onSelectHunk(fileId, Math.min(Math.max(0, Math.floor(hunkIndex)), maxHunkIndex));
      });
    },
    revealLine(fileId: string, side: "old" | "new", line: number) {
      guard("revealLine", () => {
        if (!resolveVisibleFile("revealLine", fileId)) {
          return;
        }

        // Line numbers are 1-based whole numbers as a patch writes them; anything else is a
        // bug in the caller rather than a line the review failed to find.
        if (side !== "old" && side !== "new") {
          notify(
            `Extension ${extensionId} revealLine received an invalid side for "${fileId}"`,
            "warning",
          );
          return;
        }

        if (typeof line !== "number" || !Number.isInteger(line) || line < 1) {
          notify(
            `Extension ${extensionId} revealLine received an invalid line number for "${fileId}"`,
            "warning",
          );
          return;
        }

        if (onRevealLine(fileId, side, line) === "none") {
          notify(
            `Extension ${extensionId} revealLine found no ${side} line ${line} in "${fileId}"`,
            "warning",
          );
        }
      });
    },
  });
}
