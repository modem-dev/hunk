/**
 * The browser client's mirror as an ordering consumer.
 *
 * The mirror decides what to do with an arriving publication, and the only way it is
 * allowed to decide is `classifyReviewPublication`. This adapter drives the real mirror —
 * a real event handler delivering real publication bodies — and reads the verdict back out
 * of what the mirror did with them, so a client that had grown a comparison of its own
 * (the prototype's contiguous `+1` revision rule) disagrees with the reference consumer
 * here (`docs/browser-review-seam-audit.md`, C1).
 *
 * The verdict is inferred from behavior rather than asked for: `gap` is the only case that
 * reads the catalog again, `accepted` moves the position without reading, and `stale`
 * changes nothing. That is exactly the difference a client's users would see.
 */
import type {
  ReviewPublicationAddress,
  ReviewPublicationOrder,
} from "../../../src/core/review/generationOrder";
import { reviewResourceId } from "../../../src/core/review/resources";
import { HUNK_REVIEW_PROTOCOL_VERSION } from "../../../src/session/reviewProtocol";
import type { HunkReviewPublicationBodyV1 } from "../../../src/session/reviewHttpProtocol";
import type { ReviewEventHandlers } from "../../../src/web/reviewApiClient";
import { ReviewMirror, type ReviewMirrorSource } from "../../../src/web/reviewMirror";
import type { ReviewOrderingConsumer } from "../types";

const SESSION_ID = "session-conformance";
const FILE_KEY = "file:00000001";

/** One publication body for a position, with a catalog naming a single readable file. */
function publicationFor(address: ReviewPublicationAddress): HunkReviewPublicationBodyV1 {
  return {
    protocolVersion: HUNK_REVIEW_PROTOCOL_VERSION,
    sessionId: SESSION_ID,
    publication: address,
    catalog: {
      generation: address.generation,
      fileKeysByRuntimeId: { "file-1": FILE_KEY },
      resources: [
        {
          id: reviewResourceId({ kind: "canonical-file", fileKey: FILE_KEY }),
          generation: address.generation,
          fileKey: FILE_KEY,
          kind: "canonical-file",
          contentType: "application/vnd.hunk.review-file+json; charset=utf-8",
        },
      ],
    },
  };
}

export const browserMirrorOrderingConsumer: ReviewOrderingConsumer = {
  name: "browser review mirror",
  phase: "Phase 5 PR 1",
  classify(current: ReviewPublicationAddress, incoming: ReviewPublicationAddress) {
    let handlers: ReviewEventHandlers | undefined;
    const readGenerations: string[] = [];
    const source: ReviewMirrorSource = {
      async readResource(descriptor) {
        readGenerations.push(descriptor.generation);
        // The bytes are irrelevant to ordering; refusing them keeps the adapter from
        // needing a document while still recording that a read was attempted.
        return { ok: false, code: "unknown-resource", message: "not part of this corpus" };
      },
      streamEvents(next) {
        handlers = next;
        return new Promise<void>(() => undefined);
      },
    };
    const mirror = new ReviewMirror(source, {
      timers: { setTimeout: () => 1, clearTimeout: () => undefined },
    });

    mirror.start();
    handlers!.onPublication(publicationFor(current));
    const readsBefore = readGenerations.length;
    handlers!.onPublication(publicationFor(incoming));
    mirror.stop();

    const reread = readGenerations.length > readsBefore;
    const moved = mirror.getSnapshot().publication?.stateRevision !== current.stateRevision;
    if (reread) {
      return "gap" satisfies ReviewPublicationOrder;
    }
    return moved ? "accepted" : "stale";
  },
};
