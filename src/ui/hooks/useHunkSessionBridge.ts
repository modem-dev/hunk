import { useEffect, useMemo, useRef } from "react";
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
import { writePersistedReviewComments } from "../../app/session/persistedComments";

/**
 * Bridge one live Hunk review session to the local session daemon, and mirror the
 * published review notes to the persisted-comments file when one is configured.
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
  onPersistedCommentsError,
  openAgentNotes,
  persistedCommentsPath,
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
  sourceLabel,
}: {
  addAgentLineHighlight: TerminalReview["addAgentLineHighlight"];
  addLiveComment: TerminalReview["addLiveComment"];
  addLiveCommentBatch: TerminalReview["addLiveCommentBatch"];
  clearAgentLineHighlights: TerminalReview["clearAgentLineHighlights"];
  clearLiveComments: TerminalReview["clearLiveComments"];
  hostClient?: HunkSessionBrokerClient;
  liveCommentCount: number;
  liveCommentSummaries: SessionLiveCommentSummary[];
  navigateToLocation: TerminalReview["navigateToLocation"];
  /** Width STML note markup currently renders at (see agentNoteMarkupWidth). */
  noteMarkupWidth?: number;
  onPersistedCommentsError?: (message: string) => void;
  openAgentNotes: () => void;
  /** Mirror `reviewNoteSummaries` to this file as notes change; absent when persistence is off. */
  persistedCommentsPath?: string;
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
  /** Where this review came from (`git diff`, a patch file, …), recorded in the persisted file. */
  sourceLabel: string;
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

  // The mount's first summaries are recorded, not written: a session that never touches
  // its notes must not clobber what an earlier session persisted before an agent reads it.
  const persistedBaselineRef = useRef<SessionReviewNoteSummary[] | null>(null);

  useEffect(() => {
    if (!persistedCommentsPath) {
      return;
    }
    if (persistedBaselineRef.current === null) {
      persistedBaselineRef.current = reviewNoteSummaries;
      return;
    }
    if (persistedBaselineRef.current === reviewNoteSummaries) {
      return;
    }
    persistedBaselineRef.current = reviewNoteSummaries;

    try {
      writePersistedReviewComments(persistedCommentsPath, {
        updatedAt: new Date().toISOString(),
        sourceLabel,
        reviewNotes: reviewNoteSummaries,
      });
    } catch (error) {
      onPersistedCommentsError?.(
        `Persisting comments failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, [onPersistedCommentsError, persistedCommentsPath, reviewNoteSummaries, sourceLabel]);
}
