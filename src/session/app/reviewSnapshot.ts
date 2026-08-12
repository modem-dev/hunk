import { reviewHunkRange } from "../../core/review/reconcile";
import { isRenderableStoredReviewNote, type ReviewState } from "../../core/review/state";
import type { ReviewHunkV1, ReviewSide } from "../../core/review/types";
import {
  MAX_SNAPSHOT_LIVE_COMMENTS,
  MAX_SNAPSHOT_REVIEW_NOTES,
  utf8ByteLength,
} from "@hunk/session-broker-core";
import {
  MAX_REVIEW_NOTE_BYTES,
  MAX_REVIEW_PRODUCER_METADATA_BYTES,
  ReviewProducerCapacityError,
  type HunkReviewStateV1,
} from "../reviewProtocol";
import type { HunkSessionSnapshot } from "../types";
import { projectReviewCompatibility } from "../reviewCompatibility";

export interface SessionRendererSnapshotFields {
  noteMarkupWidth?: number;
  /** Terminal-owned deterministic layout validation; never serialized. */
  validateMarkup?: (markup: string, width: number) => string[];
}

/** Project the authoritative semantic state without repeating its document bodies. */
export function createHunkReviewState(snapshot: ReviewState): HunkReviewStateV1 {
  const mutableNotes = [...snapshot.liveNotes, ...snapshot.userNotes]
    .filter(isRenderableStoredReviewNote)
    .map((entry) => entry.note);
  return {
    documentGeneration: snapshot.documentGeneration,
    stateRevision: snapshot.stateRevision,
    selection: snapshot.selection,
    reveal: snapshot.reveal,
    filter: snapshot.filter,
    showAgentNotes: snapshot.showAgentNotes,
    ...(snapshot.trustPromptRepoRoot ? { trustPromptRepoRoot: snapshot.trustPromptRepoRoot } : {}),
    // Immutable document notes already live in the manifest; only mutable notes belong in state.
    notes: mutableNotes,
    expandedGaps: snapshot.expandedGaps.map((gap) => ({ ...gap })),
    sourceStatusByFileKey: Object.fromEntries(
      Object.entries(snapshot.sourceStatusByFileKey).map(([fileKey, status]) => [
        fileKey,
        status.kind === "error"
          ? { kind: status.kind, ...(status.reason ? { reason: status.reason } : {}) }
          : { kind: status.kind },
      ]),
    ),
  };
}

/** Return a protocol range only when that side has positive source line coordinates. */
function sessionHunkRange(hunk: ReviewHunkV1, side: ReviewSide) {
  const range = reviewHunkRange(hunk, side);
  return range[0] > 0 ? ([...range] as [number, number]) : undefined;
}

/** Adapt the authoritative renderer-neutral store snapshot to the broker contract. */
export function createSessionSnapshotFromReviewState(
  snapshot: ReviewState,
  renderer: SessionRendererSnapshotFields = {},
): HunkSessionSnapshot {
  const file = snapshot.document.files.find(
    (candidate) => candidate.key === snapshot.selection.fileKey,
  );
  const hunk = file?.hunks[snapshot.selection.hunkIndex];
  const selectedOldRange = hunk ? sessionHunkRange(hunk, "old") : undefined;
  const selectedNewRange = hunk ? sessionHunkRange(hunk, "new") : undefined;
  const mutableNotes = [...snapshot.liveNotes, ...snapshot.userNotes].filter(
    isRenderableStoredReviewNote,
  );
  const { liveComments, reviewNotes } = projectReviewCompatibility(
    snapshot.document.files,
    mutableNotes.map((entry) => entry.note),
  );

  const sessionSnapshot: HunkSessionSnapshot = {
    updatedAt: new Date().toISOString(),
    state: {
      documentGeneration: snapshot.documentGeneration,
      stateRevision: snapshot.stateRevision,
      review: createHunkReviewState(snapshot),
      ...(file ? { selectedFileId: file.runtimeId, selectedFilePath: file.path } : {}),
      selectedHunkIndex: snapshot.selection.hunkIndex,
      ...(selectedOldRange ? { selectedHunkOldRange: selectedOldRange } : {}),
      ...(selectedNewRange ? { selectedHunkNewRange: selectedNewRange } : {}),
      showAgentNotes: snapshot.showAgentNotes,
      ...(renderer.noteMarkupWidth !== undefined
        ? { noteMarkupWidth: renderer.noteMarkupWidth }
        : {}),
      liveCommentCount: liveComments.length,
      liveComments,
      reviewNoteCount: reviewNotes.length,
      reviewNotes,
    },
  };
  if (sessionSnapshot.state.liveComments.length > MAX_SNAPSHOT_LIVE_COMMENTS) {
    throw new ReviewProducerCapacityError(
      "Review snapshot exceeds the aggregate live comment limit.",
    );
  }
  if (
    sessionSnapshot.state.review.notes.length > MAX_SNAPSHOT_REVIEW_NOTES ||
    (sessionSnapshot.state.reviewNotes?.length ?? 0) > MAX_SNAPSHOT_REVIEW_NOTES
  ) {
    throw new ReviewProducerCapacityError(
      "Review snapshot exceeds the aggregate review note limit.",
    );
  }
  for (const note of sessionSnapshot.state.review.notes) {
    if (utf8ByteLength(JSON.stringify(note)) > MAX_REVIEW_NOTE_BYTES) {
      throw new ReviewProducerCapacityError(
        `Review note ${note.id} exceeds the producer note metadata limit.`,
      );
    }
  }
  if (utf8ByteLength(JSON.stringify(sessionSnapshot)) > MAX_REVIEW_PRODUCER_METADATA_BYTES) {
    throw new ReviewProducerCapacityError(
      "Review snapshot exceeds the producer message metadata limit.",
    );
  }
  return sessionSnapshot;
}
