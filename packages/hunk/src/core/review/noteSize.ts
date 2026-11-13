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

/**
 * Most stored notes — live and reviewer, replies included — one review holds.
 *
 * Every note travels in the session snapshot (`MAX_SNAPSHOT_REVIEW_NOTES`, `MAX_SNAPSHOT_LIVE_
 * COMMENTS`) beside at most `MAX_PROJECTED_SIDECAR_NOTES` sidecar annotations, so the two
 * together stay within the snapshot's note bound; `scripts/quality/review-vocabulary.test.ts`
 * asserts that coupling, because the broker limits cannot be imported into this browser-safe
 * module. Generous for any human or agent review: thousands of comments on one changeset. With
 * `MAX_REVIEW_NOTES_TOTAL_BYTES` it allows an average of about 500 serialized bytes per note
 * (roughly 200 characters of text after a live note's framing) at the full count.
 */
export const MAX_REVIEW_NOTES = 4_000;

/**
 * Most serialized bytes all stored notes of one review add up to.
 *
 * The shared-state snapshot carries every stored note and the projected sidecar annotations
 * inside `MAX_REVIEW_SHARED_STATE_BYTES` (4 MiB): 2 MiB here plus 1 MiB of sidecar leaves a
 * quarter for file metadata and framing. The session snapshot carries each note's text up to
 * twice (live-comment and note summaries), within three quarters of the websocket frame bound.
 * Eight maximum-size notes, or four thousand of about 200 characters.
 */
export const MAX_REVIEW_NOTES_TOTAL_BYTES = 2 * 1024 * 1024;

/**
 * Most sidecar annotations a snapshot or shared state carries.
 *
 * Sidecar annotations are launch input, not actions: they never count against the stored-note
 * bounds and never fail a review. A sidecar larger than this is still drawn in full by the
 * terminal; the projections other surfaces read carry the first ones in file order and report
 * how many they omitted.
 */
export const MAX_PROJECTED_SIDECAR_NOTES = 5_000;

/** Most serialized bytes of sidecar annotations a shared state carries; see above. */
export const MAX_PROJECTED_SIDECAR_NOTE_BYTES = 1024 * 1024;

/** Which stored-note bound a change would exceed, if any. */
export type ReviewNoteCapacityIssue = "count" | "bytes";

const collectionBytes = new WeakMap<readonly { note: ReviewNoteV1 }[], number>();

/** Total serialized bytes of one immutable note collection, cached by array identity. */
function storedNotesByteLength(notes: readonly { note: ReviewNoteV1 }[]) {
  let total = collectionBytes.get(notes);
  if (total === undefined) {
    total = notes.reduce((sum, entry) => sum + reviewNoteByteLength(entry.note), 0);
    collectionBytes.set(notes, total);
  }
  return total;
}

/**
 * Decide whether adding notes, or replacing one note's body, keeps a review within its bounds.
 *
 * Measured over the stored collections (live and reviewer notes) in the same unit as the
 * per-note bound. A replacement counts only its growth, so editing a note in a full review
 * that does not grow it is always allowed.
 */
export function reviewNoteCapacityIssue(
  state: {
    liveNotes: readonly { note: ReviewNoteV1 }[];
    userNotes: readonly { note: ReviewNoteV1 }[];
  },
  change: {
    add?: readonly ReviewNoteV1[];
    replace?: { before: ReviewNoteV1; after: ReviewNoteV1 };
  },
): ReviewNoteCapacityIssue | undefined {
  const added = change.add ?? [];
  if (
    added.length > 0 &&
    state.liveNotes.length + state.userNotes.length + added.length > MAX_REVIEW_NOTES
  ) {
    return "count";
  }
  const growth =
    added.reduce((sum, note) => sum + reviewNoteByteLength(note), 0) +
    (change.replace
      ? reviewNoteByteLength(change.replace.after) - reviewNoteByteLength(change.replace.before)
      : 0);
  if (growth <= 0) return undefined;
  const total = storedNotesByteLength(state.liveNotes) + storedNotesByteLength(state.userNotes);
  return total + growth > MAX_REVIEW_NOTES_TOTAL_BYTES ? "bytes" : undefined;
}

/**
 * Admit sidecar annotations into one projection, in the order offered, within the projected
 * sidecar bounds.
 *
 * `admit` returns false once an annotation would exceed either bound; every later one is then
 * refused too, so a projection never skips one annotation and shows a later one.
 * `omitted` counts what was refused.
 */
export function createSidecarProjectionBudget() {
  let count = 0;
  let bytes = 0;
  let full = false;
  let omitted = 0;
  return {
    admit(note: ReviewNoteV1) {
      const size = reviewNoteByteLength(note);
      if (
        full ||
        count + 1 > MAX_PROJECTED_SIDECAR_NOTES ||
        bytes + size > MAX_PROJECTED_SIDECAR_NOTE_BYTES
      ) {
        full = true;
        omitted += 1;
        return false;
      }
      count += 1;
      bytes += size;
      return true;
    },
    get omitted() {
      return omitted;
    },
  };
}
