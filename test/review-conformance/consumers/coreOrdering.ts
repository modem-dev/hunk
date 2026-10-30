/**
 * The ordering contract itself as a consumer.
 *
 * Registered so the corpus has a reference answer beside every consumer that reaches it
 * indirectly: whatever a mirror, a client, or a server does with a publication, this is
 * what the rule says.
 */
import { classifyReviewPublication } from "../../../packages/hunk/src/core/review/generationOrder";
import type { ReviewOrderingConsumer } from "../types";

export const coreOrderingConsumer: ReviewOrderingConsumer = {
  name: "core publication ordering",
  phase: "Phase 2",
  classify: classifyReviewPublication,
};
