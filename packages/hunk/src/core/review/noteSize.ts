/**
 * The one size a review note is measured against.
 *
 * A note is measured whole — its serialized JSON, including framing — never field by
 * field, so the check that admits a note and the check that publishes it cannot disagree.
 * Composers and producers call the same function (`docs/browser-review-seam-audit.md`, D1).
 */
import type { ReviewNoteV1 } from "./types";
import { utf8ByteLength } from "./validation";

/** Largest whole note any surface will accept, publish, or transport. */
export const MAX_REVIEW_NOTE_BYTES = 256 * 1024;

/**
 * The serialized size of one note.
 *
 * Measured over the note's JSON form, because that is what a snapshot carries: summing
 * the text fields alone would undercount the framing every one of them is wrapped in. Key
 * order does not affect the total, so two encoders that order fields differently agree.
 */
export function reviewNoteByteLength(note: ReviewNoteV1) {
  return utf8ByteLength(JSON.stringify(note));
}

/** Whether one note fits within the shared size limit. */
export function reviewNoteWithinSizeLimit(note: ReviewNoteV1) {
  return reviewNoteByteLength(note) <= MAX_REVIEW_NOTE_BYTES;
}
