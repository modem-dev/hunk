/**
 * Derives the reloadable descriptor for the review currently mounted in the UI.
 * It preserves live view options and only attaches a VCS working-directory source.
 */

import type { SessionReloadReason } from "../extension-api/types";
import type { CliInput, LayoutMode } from "../core/run/commandInputs";
import { canReloadInput } from "../core/run/inputReload";
import { isVcsReviewInput } from "../core/vcs";

/** Live view settings that must survive an in-session review refresh. */
export interface CurrentReviewViewOptions {
  layoutMode: LayoutMode;
  themeId: string;
  showAgentNotes: boolean;
  showHunkHeaders: boolean;
  showLineNumbers: boolean;
  showMenuBar: boolean;
  wrapLines: boolean;
}

/** Caller-selected provenance and extension loading behavior for an in-session refresh. */
export interface CurrentReviewRefreshOptions {
  reason?: SessionReloadReason;
  reloadExtensions?: boolean;
}

/** Full reload options emitted by the current-review controller. */
export interface CurrentReviewReloadOptions extends CurrentReviewRefreshOptions {
  resetApp: false;
  sourcePath?: string;
}

/** Current mounted review descriptor AppHost dereferences after a completed workspace write. */
export interface WorkspaceRefreshRequest {
  nextInput: CliInput;
  sourcePath?: string;
}

/** Apply the mounted review's live view settings to a reload input. */
export function withCurrentReviewViewOptions(
  input: CliInput,
  view: CurrentReviewViewOptions,
): CliInput {
  return {
    ...input,
    options: {
      ...input.options,
      mode: view.layoutMode,
      theme: view.themeId,
      agentNotes: view.showAgentNotes,
      hunkHeaders: view.showHunkHeaders,
      lineNumbers: view.showLineNumbers,
      menuBar: view.showMenuBar,
      wrapLines: view.wrapLines,
    },
  };
}

/** Derive the descriptor for the mounted input, or null when it cannot be reopened. */
export function deriveWorkspaceRefreshRequest({
  input,
  sourceLabel,
  view,
}: {
  input: CliInput;
  sourceLabel: string;
  view: CurrentReviewViewOptions;
}): WorkspaceRefreshRequest | null {
  if (!canReloadInput(input)) return null;

  return {
    nextInput: withCurrentReviewViewOptions(input, view),
    sourcePath: isVcsReviewInput(input) ? sourceLabel : undefined,
  };
}
