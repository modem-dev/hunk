import { useEffect, useMemo } from "react";
import type { ReviewProducer } from "../../app/review/producer";
import type { DiffFile } from "../../core/changeset/model";
import type { CliInput } from "../../core/run/commandInputs";
import { reviewHunkRanges } from "../../core/review/geometry";
import { createHunkSessionBridge } from "../../app/session/bridge";
import type { HunkSessionBrokerClient } from "../../session/broker/brokerClient";
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
  removeLiveComment,
  reviewNoteCount,
  reviewNoteSummaries,
  reviewProducer,
  reviewStateRevision,
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
  reviewNoteCount: number;
  reviewNoteSummaries: SessionReviewNoteSummary[];
  /** The producer that answers brokered review resource reads and actions for this session. */
  reviewProducer?: ReviewProducer;
  /** The review store's current revision, published so the daemon can order snapshots. */
  reviewStateRevision: number;
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
    const selectedRange = selectedHunk ? reviewHunkRanges(selectedHunk) : undefined;

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
        // Where this review currently is, so the daemon's mirror can order what it
        // receives instead of guessing whether a snapshot is newer than the last.
        ...(publicationGeneration
          ? {
              reviewPublication: {
                generation: publicationGeneration,
                stateRevision: reviewStateRevision,
              },
            }
          : {}),
      },
    });
  }, [
    hostClient,
    publicationGeneration,
    reviewStateRevision,
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
