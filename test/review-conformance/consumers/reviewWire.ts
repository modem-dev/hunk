/**
 * The wire protocol as a conformance consumer.
 *
 * It answers the corpus by doing exactly what a producer does with an arriving action:
 * parse it strictly, then lower it to the intent it derives from. Nothing about the
 * expectations is captured from the parser — the fixtures state the intent by hand — so a
 * wire type that drifted away from the semantics it carries fails here rather than at a
 * client (`docs/browser-review-seam-audit.md`, B12/B10).
 *
 * It also runs the note-size corpus, because "may this note cross a boundary" is a wire
 * question as much as a producer one, and both must answer it the same way (D1).
 */
import { reviewNoteWithinSizeLimit } from "../../../packages/hunk/src/core/review/noteSize";
import {
  parseHunkReviewAction,
  toReviewIntent,
} from "../../../packages/hunk/src/session/reviewProtocol";
import type { ReviewWireConsumer } from "../types";

export const reviewWireConsumer: ReviewWireConsumer = {
  name: "review wire protocol",
  phase: "Phase 3",
  parseAction(action) {
    const parsed = parseHunkReviewAction(action);
    return parsed.ok
      ? { accepted: true, intent: toReviewIntent(parsed.value) }
      : { accepted: false };
  },
  acceptsNote: reviewNoteWithinSizeLimit,
};
