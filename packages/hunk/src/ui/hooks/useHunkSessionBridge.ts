import { useEffect, useMemo } from "react";
import type { ReviewProducer } from "../../app/review/producer";
import type { DiffFile } from "../../core/changeset/model";
import type { CliInput } from "../../core/run/commandInputs";
import { buildSessionSnapshotState } from "../../app/review/reviewSessionProjections";
import { createHunkSessionBridge } from "../../app/session/bridge";
import type { HunkSessionBrokerClient } from "../../session/broker/brokerClient";
import type { HunkReviewRefreshResultV1 } from "../../session/reviewProtocol";
import type {
  ReloadedSessionResult,
  ReloadSessionOptions,
  SessionLiveCommentSummary,
  SessionReviewNoteSummary,
} from "../../session/types";
import type { TerminalReview } from "./useTerminalReview";

/**
 * Bridge one live Hunk review session to the local session daemon.
 *
 * Publishes the session's registration and snapshots, receives agent commands through the
 * bridge, and relays the daemon link's sticky notice (a refused hello, a rejected registration)
 * to the status bar. The notice text and its direction are decided by the broker client; the UI
 * only shows or clears it.
 */
export function useHunkSessionBridge({
  addAgentLineHighlight,
  addLiveComment,
  addLiveCommentBatch,
  clearAgentLineHighlights,
  clearLiveComments,
  hostClient,
  liveCommentCount,
  liveCommentSummaries,
  navigateToLocation,
  noteMarkupWidth,
  onConnectionNotice,
  openAgentNotes,
  reloadSession,
  refreshReview,
  removeLiveComment,
  reviewNoteCount,
  reviewNoteSummaries,
  reviewProducer,
  reviewStateRevision,
  reviewSharedStateRevision,
  selectedFile,
  selectedHunk,
  selectedHunkIndex,
  showAgentNotes,
}: {
  addAgentLineHighlight: TerminalReview["addAgentLineHighlight"];
  addLiveComment: TerminalReview["addLiveComment"];
  addLiveCommentBatch: TerminalReview["addLiveCommentBatch"];
  clearAgentLineHighlights: TerminalReview["clearAgentLineHighlights"];
  clearLiveComments: TerminalReview["clearLiveComments"];
  hostClient?: HunkSessionBrokerClient;
  /** Receive the daemon link notice, or `null` once the link is connected again. */
  onConnectionNotice?: (notice: string | null) => void;
  liveCommentCount: number;
  liveCommentSummaries: SessionLiveCommentSummary[];
  navigateToLocation: TerminalReview["navigateToLocation"];
  /** Width STML note markup currently renders at (see agentNoteMarkupWidth). */
  noteMarkupWidth?: number;
  openAgentNotes: () => void;
  reloadSession: (
    nextInput: CliInput,
    options?: ReloadSessionOptions,
  ) => Promise<ReloadedSessionResult>;
  removeLiveComment: TerminalReview["removeLiveComment"];
  /** Reload the current input for a browser's refresh; absent means refresh is unavailable. */
  refreshReview?: () => Promise<HunkReviewRefreshResultV1>;
  reviewNoteCount: number;
  reviewNoteSummaries: SessionReviewNoteSummary[];
  /** The producer that answers brokered review resource reads and actions for this session. */
  reviewProducer?: ReviewProducer;
  /** The review store's current revision, published so the daemon can order snapshots. */
  reviewStateRevision: number;
  /** The review's shared-state revision, published so a browser refetches state only on change. */
  reviewSharedStateRevision?: number;
  selectedFile: DiffFile | undefined;
  selectedHunk: DiffFile["metadata"]["hunks"][number] | undefined;
  selectedHunkIndex: number;
  showAgentNotes: boolean;
}) {
  const bridge = useMemo(
    () =>
      createHunkSessionBridge({
        addAgentLineHighlight,
        addLiveComment,
        addLiveCommentBatch,
        clearAgentLineHighlights,
        clearLiveComments,
        navigateToLocation,
        openAgentNotes,
        reloadSession: (nextInput, options) => reloadSession(nextInput, { ...options }),
        removeLiveComment,
        reviewProducer,
        refreshReview,
      }),
    [
      addAgentLineHighlight,
      addLiveComment,
      addLiveCommentBatch,
      clearAgentLineHighlights,
      clearLiveComments,
      navigateToLocation,
      openAgentNotes,
      reloadSession,
      removeLiveComment,
      reviewProducer,
      refreshReview,
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
    if (!hostClient || !onConnectionNotice) {
      return;
    }
    return hostClient.subscribeConnectionNotice(onConnectionNotice);
  }, [hostClient, onConnectionNotice]);

  // The generation is a property of the producer's publication, not of this render; the
  // revision beside it is the store's own counter. Read as a string rather than as the
  // address object so the effect below re-runs when the review moves, not on every render.
  const publicationGeneration = reviewProducer?.getPublication().generation;

  useEffect(() => {
    hostClient?.updateSnapshot({
      updatedAt: new Date().toISOString(),
      state: buildSessionSnapshotState({
        selectedFile,
        selectedHunk,
        selectedHunkIndex,
        showAgentNotes,
        noteMarkupWidth,
        liveCommentCount,
        liveComments: liveCommentSummaries,
        reviewNoteCount,
        reviewNotes: reviewNoteSummaries,
        publicationGeneration,
        stateRevision: reviewStateRevision,
        sharedStateRevision: reviewSharedStateRevision,
      }),
    });
  }, [
    hostClient,
    publicationGeneration,
    reviewStateRevision,
    reviewSharedStateRevision,
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
