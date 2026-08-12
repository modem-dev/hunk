/**
 * The note-size corpus: one note, one measurement, at the boundary.
 *
 * The prototype measured a note twice — `body` and `markup` checked separately when the
 * note was admitted, the whole serialized note checked when it was published — so a note
 * could pass the first check and then fail the second, taking the entire snapshot with it
 * (`docs/browser-review-seam-audit.md`, D1). These fixtures are the cases that split the
 * two rules apart, written from the semantics: each states the field sizes and whether the
 * whole note fits.
 *
 * Sizes are stated relative to the shared bound rather than as literals, so the corpus
 * still means the same thing if the bound moves.
 */
import { MAX_REVIEW_NOTE_BYTES } from "../../src/core/review/noteBounds";
import type { ReviewNoteV1 } from "../../src/core/review/types";

export interface ReviewNoteBoundsFixture {
  id: string;
  /** What makes this note adversarial, in one line. */
  description: string;
  build: () => ReviewNoteV1;
  /** Hand-written from the semantics — never captured from the measurement. */
  withinBounds: boolean;
}

/** One minimal note with the given text fields; everything else is framing. */
function note(fields: Partial<ReviewNoteV1>): ReviewNoteV1 {
  return {
    id: "note:1",
    source: "user",
    fileKey: "file:abc",
    anchor: { intersectingHunkIndices: [0], ownerHunkIndex: 0 },
    summary: "",
    editable: true,
    ...fields,
  };
}

/** The bytes of framing one empty note costs before any text is added. */
const FRAMING_BYTES = JSON.stringify(note({})).length;

/** ASCII filler of an exact byte length. */
const filler = (bytes: number) => "x".repeat(Math.max(0, bytes));

export const REVIEW_NOTE_BOUNDS_FIXTURES: readonly ReviewNoteBoundsFixture[] = [
  {
    id: "empty-note",
    description: "Framing alone is far below the bound.",
    build: () => note({}),
    withinBounds: true,
  },
  {
    id: "whole-note-exactly-at-the-bound",
    description: "Summary sized so the serialized note lands on the limit exactly.",
    build: () => note({ summary: filler(MAX_REVIEW_NOTE_BYTES - FRAMING_BYTES) }),
    withinBounds: true,
  },
  {
    id: "whole-note-one-byte-over",
    description: "The same note plus one byte: over the limit as a whole.",
    build: () => note({ summary: filler(MAX_REVIEW_NOTE_BYTES - FRAMING_BYTES + 1) }),
    withinBounds: false,
  },
  {
    id: "every-field-fits-but-the-note-does-not",
    description:
      "Summary, rationale, and markup each sit under the bound while the whole note is triple it — the exact note the per-field check admitted and the publisher then rejected.",
    build: () =>
      note({
        summary: filler(MAX_REVIEW_NOTE_BYTES - 1),
        rationale: filler(MAX_REVIEW_NOTE_BYTES - 1),
        markup: filler(MAX_REVIEW_NOTE_BYTES - 1),
      }),
    withinBounds: false,
  },
  {
    id: "multibyte-summary-under-the-per-character-limit",
    description:
      "A summary of four-byte characters that is well under the bound counted as characters and over it counted as bytes.",
    build: () => note({ summary: "🧪".repeat(MAX_REVIEW_NOTE_BYTES / 4) }),
    withinBounds: false,
  },
  {
    id: "multibyte-summary-just-inside",
    description: "The same characters, one short of filling the bound with framing included.",
    build: () =>
      note({ summary: "🧪".repeat(Math.floor((MAX_REVIEW_NOTE_BYTES - FRAMING_BYTES) / 4)) }),
    withinBounds: true,
  },
];
