/**
 * What the reader's note gestures in the diff do, handed from the page to every file view.
 *
 * One stable object for the page's lifetime, so a file view never re-renders because a
 * handler changed: picking lines opens a composer, a card's buttons reply, edit, or delete,
 * clicking a card makes its note the active one, and composers are drawn by the page.
 */
import type { ReactNode } from "react";
import type { ReviewSide } from "../../core/review/types";
import type { NoteComposer } from "./composerStore";
import type { WebNoteCardAction } from "./noteCards";

export interface ReviewNoteInteraction {
  /** Draw one composer. */
  renderComposer: (composer: NoteComposer) => ReactNode;
  /** The reader picked one line, or a range on one side, of a file. */
  onPickLines: (fileKey: string, side: ReviewSide, start: number, end: number) => void;
  /** A card's button, or a click on the card itself (`select`). */
  onNoteAction: (fileKey: string, action: WebNoteCardAction | "select", noteId: string) => void;
}
