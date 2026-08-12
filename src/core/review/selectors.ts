import { isRenderableStoredReviewNote, type ReviewState } from "./state";
import type { ReviewFileV1, ReviewHunkV1, ReviewNoteV1 } from "./types";

export type ReviewFilterFile = Pick<ReviewFileV1, "path" | "previousPath" | "agentSummary">;

/** Return whether a renderer-neutral file matches the shared review filter. */
export function reviewFileMatchesFilter(file: ReviewFilterFile, filter: string) {
  const query = filter.trim().toLowerCase();
  if (!query) return true;
  return [file.path, file.previousPath, file.agentSummary]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(query);
}

/** Select files in authoritative document order after applying the shared filter. */
export function selectVisibleReviewFiles(state: Pick<ReviewState, "document" | "filter">) {
  return state.document.files.filter((file) => reviewFileMatchesFilter(file, state.filter));
}

/** Apply the shared source policy: user notes stay visible when agent notes are hidden. */
export function reviewNoteVisibleByPolicy(
  note: Pick<ReviewNoteV1, "source">,
  showAgentNotes: boolean,
) {
  return showAgentNotes || note.source === "user";
}

/** Select the semantic file currently targeted by review selection. */
export function selectReviewFile(state: ReviewState) {
  return state.document.files.find((file) => file.key === state.selection.fileKey);
}

/** Select the semantic hunk currently targeted by review selection. */
export function selectReviewHunk(state: ReviewState): ReviewHunkV1 | undefined {
  return selectReviewFile(state)?.hunks[state.selection.hunkIndex];
}

/** Select all notes currently safe to expose under the explicit stale-note policy. */
export function selectReviewNotes(state: ReviewState): ReviewNoteV1[] {
  return [
    ...state.document.files.flatMap((file) => file.notes),
    ...[...state.liveNotes, ...state.userNotes]
      .filter(isRenderableStoredReviewNote)
      .map((entry) => entry.note),
  ];
}

/** Return active mutable notes for one semantic file. */
export function selectActiveMutableNotesForFile(state: ReviewState, fileKey: string) {
  return [...state.liveNotes, ...state.userNotes].filter(
    (entry) => entry.resolution === "active" && entry.note.fileKey === fileKey,
  );
}
