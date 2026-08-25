/**
 * Helpers every event consumer projects through, so the corpus compares like with like.
 *
 * Two mechanical things: turning a fixture's relative window size into bytes, and
 * collapsing a run of chunk frames into one entry so a fixture states a shape rather than
 * a byte count. Neither decides anything about the protocol; both exist so two consumers
 * cannot differ merely in how they report what they did.
 */
import type { ReviewEventFixture } from "./types";

/** The window size one fixture asks for, given the payload it is about. */
export function resolveFixtureChunkBytes(fixture: ReviewEventFixture, payloadBytes: number) {
  if (fixture.chunkBytes === "payload-size") {
    return payloadBytes;
  }
  if (fixture.chunkBytes === "payload-size-minus-one") {
    return Math.max(1, payloadBytes - 1);
  }
  return fixture.chunkBytes;
}

/** Collapse consecutive identical frame names, which is only ever the chunk run. */
export function collapseChunkRun(names: readonly string[]) {
  return names.filter((name, index) => name !== names[index - 1]);
}
