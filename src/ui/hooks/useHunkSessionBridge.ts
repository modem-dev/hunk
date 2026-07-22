import { useEffect, useMemo } from "react";
import type { CliInput, DiffFile } from "../../core/types";
import { hunkLineRange } from "../../core/liveComments";
import { createHunkSessionBridge } from "../../hunk-session/bridge";
import type {
  HunkSessionBrokerClient,
  ReloadedSessionResult,
  SessionLiveCommentSummary,
  SessionReviewNoteSummary,
} from "../../hunk-session/types";
import type { ReviewController } from "./useReviewController";

/** Bridge one live Hunk review session to the local session daemon. */
export function useHunkSessionBridge({
  addLiveComment,
  addLiveCommentBatch,
  clearLiveComments,
  hostClient,
  liveCommentCount,
  liveCommentSummaries,
  navigateToLocation,
  noteMarkupWidth,
  openAgentNotes,
  reloadSession,
  removeLiveComment,
  reviewNoteCount,
  reviewNoteSummaries,
  selectedFile,
  selectedHunk,
  selectedHunkIndex,
  showAgentNotes,
}: {
  addLiveComment: ReviewController["addLiveComment"];
  addLiveCommentBatch: ReviewController["addLiveCommentBatch"];
  clearLiveComments: ReviewController["clearLiveComments"];
  hostClient?: HunkSessionBrokerClient;
  liveCommentCount: number;
  liveCommentSummaries: SessionLiveCommentSummary[];
  navigateToLocation: ReviewController["navigateToLocation"];
  /** Width STML note markup currently renders at (see agentNoteMarkupWidth). */
  noteMarkupWidth?: number;
  openAgentNotes: () => void;
  reloadSession: (
    nextInput: CliInput,
    options?: { resetApp?: boolean; sourcePath?: string },
  ) => Promise<ReloadedSessionResult>;
  removeLiveComment: ReviewController["removeLiveComment"];
  reviewNoteCount: number;
  reviewNoteSummaries: SessionReviewNoteSummary[];
  selectedFile: DiffFile | undefined;
  selectedHunk: DiffFile["metadata"]["hunks"][number] | undefined;
  selectedHunkIndex: number;
  showAgentNotes: boolean;
}) {
  const bridge = useMemo(
    () =>
      createHunkSessionBridge({
        addLiveComment,
        addLiveCommentBatch,
        clearLiveComments,
        navigateToLocation,
        openAgentNotes,
        reloadSession: (nextInput, options) => reloadSession(nextInput, { ...options }),
        removeLiveComment,
      }),
    [
      addLiveComment,
      addLiveCommentBatch,
      clearLiveComments,
      navigateToLocation,
      openAgentNotes,
      reloadSession,
      removeLiveComment,
    ],
  );

  useEffect(() => {
    if (!hostClient) {
      return;
    }

    hostClient.setBridge(bridge);

    return () => {
      hostClient.setBridge(null);
    };
  }, [bridge, hostClient]);

  useEffect(() => {
    const selectedRange = selectedHunk ? hunkLineRange(selectedHunk) : undefined;

    hostClient?.updateSnapshot({
      updatedAt: new Date().toISOString(),
      state: {
        selectedFileId: selectedFile?.id,
        selectedFilePath: selectedFile?.path,
        selectedHunkIndex,
        selectedHunkOldRange: selectedRange?.oldRange,
        selectedHunkNewRange: selectedRange?.newRange,
        showAgentNotes,
        noteMarkupWidth,
        liveCommentCount,
        liveComments: liveCommentSummaries,
        reviewNoteCount,
        reviewNotes: reviewNoteSummaries,
      },
    });
  }, [
    hostClient,
    liveCommentCount,
    liveCommentSummaries,
    noteMarkupWidth,
    reviewNoteCount,
    reviewNoteSummaries,
    selectedFile?.id,
    selectedFile?.path,
    selectedHunk,
    selectedHunkIndex,
    showAgentNotes,
  ]);
}
