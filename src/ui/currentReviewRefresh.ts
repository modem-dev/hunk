/**
 * Describes how the currently mounted review can be rebuilt from its original input.
 *
 * Manual refresh, watch mode, editor return, extension trust reloads, external extension requests,
 * and completed workspace writes all reuse this descriptor. It reapplies live view options so a soft reload does not
 * fall back to launch-time settings, and it supplies a source path only for VCS-backed reviews.
 *
 * Stdin-backed inputs remain non-reloadable because refreshing must not attempt to reread
 * already-consumed stdin.
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

/** Current mounted review descriptor AppHost dereferences for deferred host reloads. */
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
