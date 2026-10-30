/**
 * The note-size corpus: one note, one measurement, at the boundary.
 *
 * A note is measured whole, once, by `packages/hunk/src/core/review/noteSize.ts`
 * (`docs/browser-review-seam-audit.md`, D1). These fixtures are the cases that would split
 * a whole-note measurement apart from a per-field one, written from the semantics: each
 * states the field sizes and whether the whole note fits.
 *
 * Sizes are stated relative to the shared bound rather than as literals, so the corpus
 * still means the same thing if the bound moves.
 */
import { MAX_REVIEW_NOTE_BYTES } from "../../packages/hunk/src/core/review/noteSize";
import type { ReviewNoteV1 } from "../../packages/hunk/src/core/review/types";

export interface ReviewNoteSizeFixture {
  id: string;
  /** What makes this note adversarial, in one line. */
  description: string;
  build: () => ReviewNoteV1;
  /** Hand-written from the semantics — never captured from the measurement. */
  withinSizeLimit: boolean;
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

export const REVIEW_NOTE_SIZE_FIXTURES: readonly ReviewNoteSizeFixture[] = [
  {
    id: "empty-note",
    description: "Framing alone is far below the bound.",
    build: () => note({}),
    withinSizeLimit: true,
  },
  {
    id: "whole-note-exactly-at-the-bound",
    description: "Summary sized so the serialized note lands on the limit exactly.",
    build: () => note({ summary: filler(MAX_REVIEW_NOTE_BYTES - FRAMING_BYTES) }),
    withinSizeLimit: true,
  },
  {
    id: "whole-note-one-byte-over",
    description: "The same note plus one byte: over the limit as a whole.",
    build: () => note({ summary: filler(MAX_REVIEW_NOTE_BYTES - FRAMING_BYTES + 1) }),
    withinSizeLimit: false,
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
    withinSizeLimit: false,
  },
  {
    id: "multibyte-summary-under-the-per-character-limit",
    description:
      "A summary of four-byte characters that is well under the bound counted as characters and over it counted as bytes.",
    build: () => note({ summary: "🧪".repeat(MAX_REVIEW_NOTE_BYTES / 4) }),
    withinSizeLimit: false,
  },
  {
    id: "multibyte-summary-just-inside",
    description: "The same characters, one short of filling the bound with framing included.",
    build: () =>
      note({ summary: "🧪".repeat(Math.floor((MAX_REVIEW_NOTE_BYTES - FRAMING_BYTES) / 4)) }),
    withinSizeLimit: true,
  },
];
