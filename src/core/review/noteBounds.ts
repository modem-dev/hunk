/**
 * The one size a review note is measured against.
 *
 * The prototype measured notes in two units: action validation checked `body` and
 * `markup` separately, while the producer and broker checked the whole serialized note.
 * A note could therefore pass the check that admitted it and then fail the check that
 * published it — poisoning an entire snapshot with a capacity error rather than rejecting
 * one note (`docs/browser-review-seam-audit.md`, D1).
 *
 * So there is one measurement, and it is the whole note: everything that will be
 * serialized, counted together, in the unit the transport actually pays. A composer
 * checking a note it is about to create and a producer checking a note it is about to
 * publish call the same function and get the same answer.
 */
import type { ReviewNoteV1 } from "./types";
import { utf8ByteLength } from "./validation";

/** Largest whole note any surface will accept, publish, or transport. */
export const MAX_REVIEW_NOTE_BYTES = 256 * 1024;

/**
 * The serialized size of one note.
 *
 * Measured over the note's JSON form, because that is what a snapshot carries — summing
 * the text fields alone would undercount the framing every one of them is wrapped in, and
 * undercounting is how the per-field check let an oversized note through. Key order does
 * not affect the total, so two encoders that order fields differently still agree.
 */
export function reviewNoteByteLength(note: ReviewNoteV1) {
  return utf8ByteLength(JSON.stringify(note));
}

/** Whether one note fits within the shared bound. */
export function reviewNoteWithinBounds(note: ReviewNoteV1) {
  return reviewNoteByteLength(note) <= MAX_REVIEW_NOTE_BYTES;
}
