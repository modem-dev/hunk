import { reviewFileMatchesFilter, reviewNoteVisibleByPolicy } from "../../core/review/selectors";
import type { ReviewNoteV1 } from "../../core/review/types";
import type { BrowserReviewDocument, BrowserReviewFile } from "./reviewTypes";

export interface VisibleBrowserReview {
  document: BrowserReviewDocument;
  files: BrowserReviewFile[];
  mutableNotes: ReviewNoteV1[];
}

/** Apply the core semantic file/source policies while retaining authoritative order. */
export function projectVisibleBrowserReview(
  document: BrowserReviewDocument,
  state: { filter: string; showAgentNotes: boolean; notes: readonly ReviewNoteV1[] },
): VisibleBrowserReview {
  const visibleKeys = new Set<string>();
  const files = document.files.flatMap((file) => {
    if (!reviewFileMatchesFilter(file, state.filter)) return [];
    visibleKeys.add(file.key);
    return [
      {
        ...file,
        notes: file.notes.filter((note) => reviewNoteVisibleByPolicy(note, state.showAgentNotes)),
      },
    ];
  });
  const mutableNotes = state.notes.filter(
    (note) =>
      visibleKeys.has(note.fileKey) && reviewNoteVisibleByPolicy(note, state.showAgentNotes),
  );
  return { document: { ...document, files }, files, mutableNotes };
}
