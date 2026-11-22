/**
 * Makes a stored note the active one when keyboard navigation lands on its hunk.
 *
 * The terminal reaches an active note by stepping onto its card; the page has no line cursor,
 * so annotated-hunk navigation (`{`, `}`) is where the keyboard arrives at a note. Which note
 * comes first is the shared order (`selectNavigableStoredReviewNotes`), and the selection is
 * written with the same `selection/select` + `activeNoteId` the shared note planner emits, so
 * `E`, `R`, and `D` then lower through the shared active-note selectors as they do in the
 * terminal.
 */
import {
  selectNavigableStoredReviewNotes,
  selectNormalizedSelection,
} from "../../core/review/selectors";
import type { ClientReviewStore } from "../store/clientReviewStore";

/** Activate the first visible stored note of the selected hunk, if it has one. */
export function activateFirstNoteOfSelection(review: Pick<ClientReviewStore, "apply" | "store">) {
  const state = review.store.getSnapshot();
  const { fileKey, hunkIndex } = selectNormalizedSelection(state);
  if (fileKey === null) return;
  const first = selectNavigableStoredReviewNotes(state).find(
    (item) => item.fileKey === fileKey && item.hunkIndex === hunkIndex,
  );
  if (!first) return;
  review.apply({
    type: "selection/select",
    fileKey,
    hunkIndex,
    reveal: { anchor: "hunk", scrollToNote: true },
    activeNoteId: first.entry.note.id,
  });
}
