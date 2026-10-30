/**
 * The note-body corpus: what counts as an empty note, decided once.
 *
 * Separate from the geometry corpus because it pins a policy rather than a projection.
 * The surfaces differ in what they *do* about a blank body — the terminal quietly retires
 * the draft, an agent command reports a rejection — which is exactly why the predicate
 * behind that decision has to be one function (`docs/browser-review-seam-audit.md`, D2).
 */
export interface ReviewNoteBodyFixture {
  id: string;
  body: string;
  blank: boolean;
}

export const REVIEW_NOTE_BODY_FIXTURES: readonly ReviewNoteBodyFixture[] = [
  { id: "empty", body: "", blank: true },
  { id: "spaces", body: "   ", blank: true },
  { id: "newlines", body: "\n\n", blank: true },
  { id: "tabs-and-newlines", body: "\t \r\n ", blank: true },
  { id: "unicode-space", body: " ", blank: true },
  { id: "single-character", body: "x", blank: false },
  { id: "padded-text", body: "  needs a test  ", blank: false },
  { id: "markup-only", body: "<hr/>", blank: false },
];
