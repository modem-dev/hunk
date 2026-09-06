/**
 * The shared event contract as a conformance consumer.
 *
 * It answers the corpus by doing what a sender does — plan the frames — and then what a
 * reader does — reassemble and verify them — through the same module. That makes it the
 * reference every other tier is compared against: a surface that framed events its own way
 * would disagree with this consumer on the fixtures the C4 finding contributed.
 */
import { nodeReviewDigest } from "../../../packages/hunk/src/core/reviewDigest";
import {
  parseReviewEventBegin,
  parseReviewEventChunk,
  parseReviewEventEnd,
  parseReviewEventFrame,
  planReviewEventFrames,
  ReviewEventAssembler,
} from "../../../packages/hunk/src/session/reviewEventProtocol";
import type { ReviewEventConsumer, ReviewEventFixture } from "../types";
import { collapseChunkRun, resolveFixtureChunkBytes } from "../eventFraming";

export const reviewEventProtocolConsumer: ReviewEventConsumer = {
  name: "review event protocol",
  phase: "Phase 4",
  async frame(fixture: ReviewEventFixture) {
    const payload = new TextEncoder().encode(JSON.stringify(fixture.body));
    const frames = planReviewEventFrames({
      type: "publication",
      address: fixture.body.publication,
      body: fixture.body,
      payload,
      contentDigest: nodeReviewDigest(payload),
      encodeChunk: (bytes) => Buffer.from(bytes).toString("base64"),
      chunkBytes: resolveFixtureChunkBytes(fixture, payload.byteLength),
    });

    const serialized = JSON.stringify(fixture.body);
    const roundTrips =
      frames.length === 1
        ? JSON.stringify(parseReviewEventFrame(frames[0]!.data)?.payload) === serialized
        : readChunked(frames, serialized);

    return {
      frames: collapseChunkRun(frames.map((frame) => frame.event)),
      resumableFrames: frames.filter((frame) => frame.id !== undefined).length,
      roundTrips,
    };
  },
};

/** Reassemble a chunked event the way a client does, and compare what came back. */
function readChunked(frames: ReturnType<typeof planReviewEventFrames>, expected: string) {
  const begin = parseReviewEventBegin(frames[0]!.data);
  const end = parseReviewEventEnd(frames.at(-1)!.data);
  if (!begin || !end) {
    return false;
  }
  const assembler = new ReviewEventAssembler({ begin, digest: nodeReviewDigest });
  for (const frame of frames.slice(1, -1)) {
    const chunk = parseReviewEventChunk(frame.data);
    if (!chunk || !assembler.accept(chunk, new Uint8Array(Buffer.from(chunk.data, "base64"))).ok) {
      return false;
    }
  }
  const assembled = assembler.finish(end);
  return assembled.ok && new TextDecoder().decode(assembled.bytes) === expected;
}
