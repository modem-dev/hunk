import { useEffect, useMemo } from "react";
import type { CliInput } from "../../core/types";
import { createHunkSessionBridge } from "../../hunk-session/bridge";
import type {
  HunkSessionBrokerClient,
  HunkSessionSnapshot,
  ReloadedSessionResult,
} from "../../hunk-session/types";
import type { ReviewController } from "./useReviewController";

/** Bridge one live Hunk review session to the local session daemon. */
export function useHunkSessionBridge({
  addLiveComment,
  addLiveCommentBatch,
  clearLiveComments,
  hostClient,
  navigateToLocation,
  openAgentNotes,
  reloadSession,
  removeLiveComment,
  sessionSnapshot,
}: {
  addLiveComment: ReviewController["addLiveComment"];
  addLiveCommentBatch: ReviewController["addLiveCommentBatch"];
  clearLiveComments: ReviewController["clearLiveComments"];
  hostClient?: HunkSessionBrokerClient;
  navigateToLocation: ReviewController["navigateToLocation"];
  openAgentNotes: () => void;
  reloadSession: (
    nextInput: CliInput,
    options?: { resetApp?: boolean; sourcePath?: string },
  ) => Promise<ReloadedSessionResult>;
  removeLiveComment: ReviewController["removeLiveComment"];
  sessionSnapshot: HunkSessionSnapshot;
}) {
  const bridge = useMemo(
    () =>
      createHunkSessionBridge({
        addLiveComment,
        addLiveCommentBatch,
        clearLiveComments,
        navigateToLocation,
        openAgentNotes,
        reloadSession,
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
    hostClient?.updateSnapshot(sessionSnapshot);
  }, [hostClient, sessionSnapshot]);
}
