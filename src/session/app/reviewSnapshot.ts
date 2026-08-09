import { reviewHunkRange } from "../../core/review/reconcile";
import { isRenderableStoredReviewNote, type ReviewState } from "../../core/review/state";
import { utf8ByteLength } from "@hunk/session-broker-core";
import {
  MAX_REVIEW_NOTE_BYTES,
  MAX_REVIEW_PRODUCER_METADATA_BYTES,
  type HunkReviewStateV1,
} from "../reviewProtocol";
import type { HunkSessionSnapshot } from "../types";
import { projectReviewCompatibility } from "../reviewCompatibility";

export interface SessionRendererSnapshotFields {
  noteMarkupWidth?: number;
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
    filter: snapshot.filter,
    showAgentNotes: snapshot.showAgentNotes,
    // Immutable document notes already live in the manifest; only mutable notes belong in state.
    notes: mutableNotes,
  };
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
      ...(hunk
        ? {
            selectedHunkOldRange: [...reviewHunkRange(hunk, "old")] as [number, number],
            selectedHunkNewRange: [...reviewHunkRange(hunk, "new")] as [number, number],
          }
        : {}),
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
  for (const note of sessionSnapshot.state.review.notes) {
    if (utf8ByteLength(JSON.stringify(note)) > MAX_REVIEW_NOTE_BYTES) {
      throw new Error(`Review note ${note.id} exceeds the producer note metadata limit.`);
    }
  }
  if (utf8ByteLength(JSON.stringify(sessionSnapshot)) > MAX_REVIEW_PRODUCER_METADATA_BYTES) {
    throw new Error("Review snapshot exceeds the producer message metadata limit.");
  }
  return sessionSnapshot;
}
