/**
 * The browser client's mirror as an ordering consumer.
 *
 * Asked the corpus's question the way the page asks it: seed the mirror with the position
 * it holds, hand it the arriving publication, and read back the verdict it acted on. The
 * mirror decides with `classifyReviewPublication` and nothing else; a rule of its own would
 * disagree with the reference on the fixtures the C1 finding contributed. Loading is
 * stubbed out — the question is ordering, not transport.
 */
import type { ReviewPublicationAddress } from "../../../packages/hunk/src/core/review/generationOrder";
import type { ReviewApiClient } from "../../../packages/hunk/src/web/transport/apiClient";
import { ReviewMirror } from "../../../packages/hunk/src/web/mirror/reviewMirror";
import { HUNK_REVIEW_PROTOCOL_VERSION } from "../../../packages/hunk/src/session/reviewProtocol";
import type { ReviewOrderingConsumer } from "../types";

/** A client whose reads finish at once with nothing, so only ordering is exercised. */
const IDLE_CLIENT = { readResources: async () => undefined } as unknown as ReviewApiClient;

/** One publication body at a position, with an empty catalog of its generation. */
function bodyAt(address: ReviewPublicationAddress) {
  return {
    protocolVersion: HUNK_REVIEW_PROTOCOL_VERSION,
    sessionId: "session-1",
    publication: address,
    catalog: { generation: address.generation, fileKeysByRuntimeId: {}, resources: [] },
  };
}

export const browserMirrorOrderingConsumer: ReviewOrderingConsumer = {
  name: "browser client mirror",
  phase: "M4",
  classify(current: ReviewPublicationAddress, incoming: ReviewPublicationAddress) {
    const mirror = new ReviewMirror({ client: IDLE_CLIENT, scheduleNotify: (flush) => flush() });
    mirror.observe(bodyAt(current));
    const verdict = mirror.observe(bodyAt(incoming));
    mirror.close();
    return verdict;
  },
};
