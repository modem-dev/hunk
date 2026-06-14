import { type Accessor, createEffect, onCleanup, onMount } from "solid-js";
import { hunkLineRange } from "../../core/liveComments";
import type { CliInput, DiffFile } from "../../core/types";
import { createHunkSessionBridge } from "../../hunk-session/bridge";
import type {
  HunkSessionBrokerClient,
  ReloadedSessionResult,
  SessionLiveCommentSummary,
  SessionReviewNoteSummary,
} from "../../hunk-session/types";
import type { ReviewController } from "./useReviewController";

/**
 * Bridge one live Hunk review session to the local session daemon.
 *
 * Action callbacks and `hostClient` are stable references captured once; the selection/comment
 * fields are accessors so the snapshot push re-runs whenever the reviewed location changes.
 */
export function useHunkSessionBridge(params: {
  addLiveComment: ReviewController["addLiveComment"];
  addLiveCommentBatch: ReviewController["addLiveCommentBatch"];
  clearLiveComments: ReviewController["clearLiveComments"];
  hostClient?: HunkSessionBrokerClient;
  liveCommentCount: Accessor<number>;
  liveCommentSummaries: Accessor<SessionLiveCommentSummary[]>;
  navigateToLocation: ReviewController["navigateToLocation"];
  openAgentNotes: () => void;
  reloadSession: (
    nextInput: CliInput,
    options?: { resetApp?: boolean; sourcePath?: string },
  ) => Promise<ReloadedSessionResult>;
  removeLiveComment: ReviewController["removeLiveComment"];
  reviewNoteCount: Accessor<number>;
  reviewNoteSummaries: Accessor<SessionReviewNoteSummary[]>;
  selectedFile: Accessor<DiffFile | undefined>;
  selectedHunk: Accessor<DiffFile["metadata"]["hunks"][number] | undefined>;
  selectedHunkIndex: Accessor<number>;
  showAgentNotes: Accessor<boolean>;
}) {
  const { hostClient } = params;

  // Action callbacks are stable for the controller's lifetime, so the bridge is built once.
  const bridge = createHunkSessionBridge({
    addLiveComment: params.addLiveComment,
    addLiveCommentBatch: params.addLiveCommentBatch,
    clearLiveComments: params.clearLiveComments,
    navigateToLocation: params.navigateToLocation,
    openAgentNotes: params.openAgentNotes,
    reloadSession: (nextInput, options) => params.reloadSession(nextInput, { ...options }),
    removeLiveComment: params.removeLiveComment,
  });

  onMount(() => {
    if (!hostClient) {
      return;
    }

    hostClient.setBridge(bridge);
    onCleanup(() => {
      hostClient.setBridge(null);
    });
  });

  // Push a fresh snapshot whenever the selected location or comment/note state changes.
  createEffect(() => {
    const selectedHunk = params.selectedHunk();
    const selectedFile = params.selectedFile();
    const selectedRange = selectedHunk ? hunkLineRange(selectedHunk) : undefined;

    hostClient?.updateSnapshot({
      updatedAt: new Date().toISOString(),
      state: {
        selectedFileId: selectedFile?.id,
        selectedFilePath: selectedFile?.path,
        selectedHunkIndex: params.selectedHunkIndex(),
        selectedHunkOldRange: selectedRange?.oldRange,
        selectedHunkNewRange: selectedRange?.newRange,
        showAgentNotes: params.showAgentNotes(),
        liveCommentCount: params.liveCommentCount(),
        liveComments: params.liveCommentSummaries(),
        reviewNoteCount: params.reviewNoteCount(),
        reviewNotes: params.reviewNoteSummaries(),
      },
    });
  });
}
