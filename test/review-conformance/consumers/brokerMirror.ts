/**
 * The broker's review mirror as an ordering consumer.
 *
 * The mirror is asked the corpus's question the only way it can be asked one: seed it with
 * the position a receiver already holds, hand it the arriving publication, and read the
 * verdict back out of what it did. `advanced` is an accepted publication, `replaced` is
 * the resnapshot a generation change forces, and `ignored` is everything the mirror
 * declined to act on.
 *
 * Driving the shared fixtures through the mirror's own update path is what proves it has
 * no comparison rules of its own (`docs/browser-review-seam-audit.md`, C1).
 */
import type { ReviewPublicationAddress } from "../../../packages/hunk/src/core/review/generationOrder";
import { ReviewMirror } from "../../../packages/hunk/src/session/broker/reviewMirror";
import {
  REVIEW_PATCH_CONTENT_TYPE,
  reviewResourceId,
} from "../../../packages/hunk/src/core/review/resources";
import type { HunkReviewResourceCatalogV1 } from "../../../packages/hunk/src/session/reviewProtocol";
import type { ReviewOrderingConsumer } from "../types";

const FILE_KEY = "file:0123456789abcdef";

/**
 * The catalog that accompanies one generation.
 *
 * A generation is only adoptable together with the resources it offers, so the corpus's
 * arriving publication is always given one — otherwise the mirror would decline for a
 * reason the fixture is not about.
 */
function catalogFor(generation: string): HunkReviewResourceCatalogV1 {
  return {
    generation,
    fileKeysByRuntimeId: { "file-1": FILE_KEY },
    resources: [
      {
        id: reviewResourceId({ kind: "patch", fileKey: FILE_KEY }),
        generation,
        fileKey: FILE_KEY,
        kind: "patch",
        contentType: REVIEW_PATCH_CONTENT_TYPE,
      },
    ],
  };
}

export const brokerMirrorOrderingConsumer: ReviewOrderingConsumer = {
  name: "broker review mirror",
  phase: "Phase 3",
  classify(current: ReviewPublicationAddress, incoming: ReviewPublicationAddress) {
    const mirror = new ReviewMirror();
    mirror.observe({
      sessionId: "session-1",
      catalog: catalogFor(current.generation),
      address: current,
    });
    const update = mirror.observe({
      sessionId: "session-1",
      catalog: catalogFor(incoming.generation),
      address: incoming,
    });

    switch (update.kind) {
      case "advanced":
        return "accepted";
      case "replaced":
        return "gap";
      default:
        return "stale";
    }
  },
};
