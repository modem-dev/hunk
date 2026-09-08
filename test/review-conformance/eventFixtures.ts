/**
 * The event-stream corpus: one publication, framed, read back, and compared.
 *
 * Every fixture states a complete publication body and how small the sender's windows are,
 * and every consumer answers with the same renderer-neutral projection: which frames went
 * out, which of them a client may resume from, and whether the payload survived the trip.
 * Expectations are written from the contract by hand — a captured frame list would agree
 * with whatever the sender happened to emit, which is precisely how the prototype's two
 * ends came to hold bounds that were compatible only by accident
 * (`docs/browser-review-seam-audit.md`, C4).
 *
 * Runs of chunk frames collapse to one entry so a fixture states a shape rather than a
 * byte count; how many chunks a payload needs is arithmetic, and pinning it would only
 * make the corpus brittle about sizes it is not about.
 */
import {
  REVIEW_PATCH_CONTENT_TYPE,
  reviewResourceId,
} from "../../packages/hunk/src/core/review/resources";
import { HUNK_REVIEW_PROTOCOL_VERSION } from "../../packages/hunk/src/session/reviewProtocol";
import type { HunkReviewPublicationBodyV1 } from "../../packages/hunk/src/session/reviewHttpProtocol";
import type { ReviewEventFixture } from "./types";

export const EVENT_FIXTURE_SESSION_ID = "session-conformance";

const GENERATION = "generation:conformance:1";

/** One publication body naming the given number of patch resources. */
function publicationBody(resourceCount: number, stateRevision = 4): HunkReviewPublicationBodyV1 {
  const fileKeys = Array.from(
    { length: resourceCount },
    (_unused, index) => `file:${index.toString(16).padStart(16, "0")}`,
  );
  return {
    protocolVersion: HUNK_REVIEW_PROTOCOL_VERSION,
    sessionId: EVENT_FIXTURE_SESSION_ID,
    publication: { generation: GENERATION, stateRevision },
    catalog: {
      generation: GENERATION,
      fileKeysByRuntimeId: Object.fromEntries(
        fileKeys.map((fileKey, index) => [`file-${index}`, fileKey]),
      ),
      resources: fileKeys.map((fileKey) => ({
        id: reviewResourceId({ kind: "patch", fileKey }),
        generation: GENERATION,
        fileKey,
        kind: "patch" as const,
        contentType: REVIEW_PATCH_CONTENT_TYPE,
      })),
    },
  };
}

export const REVIEW_EVENT_FIXTURES: ReviewEventFixture[] = [
  {
    id: "publication-in-one-frame",
    findings: ["C4"],
    description: "A payload inside one window is one frame carrying the body itself.",
    body: publicationBody(1),
    chunkBytes: 64 * 1024,
    expected: {
      frames: ["publication"],
      resumableFrames: 1,
      roundTrips: true,
    },
  },
  {
    id: "publication-split-across-chunks",
    findings: ["C4"],
    description: "A payload past one window becomes begin, chunks, end, with one id.",
    body: publicationBody(24),
    chunkBytes: 256,
    expected: {
      frames: ["publication-begin", "publication-chunk", "publication-end"],
      resumableFrames: 1,
      roundTrips: true,
    },
  },
  {
    // Adversarial: the boundary the two ends must agree on. A payload of exactly one
    // window's size is *not* chunked — the sender's `<=` and a reader's `<` would disagree
    // here and nowhere else, and the disagreement only ever shows up as a client that
    // silently drops one event.
    id: "publication-exactly-one-window",
    findings: ["C4"],
    description: "A payload the size of one window is still a single frame.",
    body: publicationBody(3),
    chunkBytes: "payload-size",
    expected: {
      frames: ["publication"],
      resumableFrames: 1,
      roundTrips: true,
    },
  },
  {
    // Adversarial: one byte over the window is the first size that must chunk.
    id: "publication-one-byte-over-a-window",
    findings: ["C4"],
    description: "A payload one byte past a window chunks rather than squeezing in.",
    body: publicationBody(3),
    chunkBytes: "payload-size-minus-one",
    expected: {
      frames: ["publication-begin", "publication-chunk", "publication-end"],
      resumableFrames: 1,
      roundTrips: true,
    },
  },
];
