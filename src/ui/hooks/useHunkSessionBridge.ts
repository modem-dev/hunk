import { useEffect, useMemo } from "react";
import type { ReviewSessionRuntime } from "../../app/reviewSessionRuntime";
import type { CliInput } from "../../core/types";
import type { ReviewStore } from "../../core/review/store";
import { createHunkSessionBridge } from "../../session/app/bridge";
import type { ReloadedSessionResult, ReloadSessionOptions } from "../../session/types";
import type { ReviewController } from "./useReviewController";

/** Register the mounted terminal command adapter with the renderer-neutral runtime authority. */
export function useHunkSessionBridge({
  addLiveComment,
  addLiveCommentBatch,
  clearLiveComments,
  navigateToLocation,
  openAgentNotes,
  reloadSession,
  removeLiveComment,
  reviewStore,
  runtime,
}: {
  addLiveComment: ReviewController["addLiveComment"];
  addLiveCommentBatch: ReviewController["addLiveCommentBatch"];
  clearLiveComments: ReviewController["clearLiveComments"];
  navigateToLocation: ReviewController["navigateToLocation"];
  openAgentNotes: () => void;
  reloadSession: (
    nextInput: CliInput,
    options?: ReloadSessionOptions,
  ) => Promise<ReloadedSessionResult>;
  removeLiveComment: ReviewController["removeLiveComment"];
  reviewStore: ReviewStore;
  runtime: ReviewSessionRuntime;
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

  useEffect(
    () => runtime.registerSessionCommandAdapter(reviewStore, bridge),
    [bridge, reviewStore, runtime],
  );
}
