/**
 * The HTTP review surface as an event consumer.
 *
 * It answers the corpus the only way a transport can be asked: mirror the fixture's
 * publication in a real broker state, open a real event stream against a real listener,
 * and report what came down it. Nothing about the framing is reimplemented here — the
 * reader below decodes SSE records and hands the payloads to the shared parsers, so a
 * surface that had grown its own frame names, its own envelopes, or its own idea of which
 * frame is resumable disagrees with the reference consumer on these fixtures rather than
 * on a client's screen (`docs/browser-review-seam-audit.md`, C4).
 */
import { SESSION_BROKER_REGISTRATION_VERSION } from "@hunk/session-broker-core";
import { reviewProcessCapability } from "../../../packages/hunk/src/app/review/capability";
import { nodeReviewDigest } from "../../../packages/hunk/src/core/reviewDigest";
import { BrowserReviewServer } from "../../../packages/hunk/src/session/broker/browserReviewServer";
import { HunkSessionBrokerState } from "../../../packages/hunk/src/session/broker/state";
import {
  parseReviewEventBegin,
  parseReviewEventChunk,
  parseReviewEventEnd,
  parseReviewEventFrame,
  ReviewEventAssembler,
} from "../../../packages/hunk/src/session/reviewEventProtocol";
import {
  HUNK_REVIEW_CAPABILITY_HEADER,
  reviewHttpPath,
} from "../../../packages/hunk/src/session/reviewHttpProtocol";
import { EVENT_FIXTURE_SESSION_ID } from "../eventFixtures";
import { collapseChunkRun, resolveFixtureChunkBytes } from "../eventFraming";
import type { ReviewEventConsumer, ReviewEventFixture } from "../types";

/** One decoded SSE record. */
interface DecodedFrame {
  id?: string;
  event: string;
  data: unknown;
}

/**
 * Register the fixture's publication with a real broker state.
 *
 * The registration and snapshot go through the daemon's own parsers, so a fixture the
 * broker would refuse cannot be smuggled past them by constructing state directly.
 */
function mirrorFixture(state: HunkSessionBrokerState, fixture: ReviewEventFixture) {
  const socket = { send: () => undefined };
  state.registerSession(
    socket,
    {
      registrationVersion: SESSION_BROKER_REGISTRATION_VERSION,
      sessionId: EVENT_FIXTURE_SESSION_ID,
      pid: process.pid,
      cwd: "/repo",
      launchedAt: new Date().toISOString(),
      info: {
        inputKind: "vcs",
        title: "conformance",
        sourceLabel: "/repo",
        files: [],
        reviewCatalog: fixture.body.catalog,
        reviewCapabilityDigest: reviewProcessCapability().digest,
      },
    },
    {
      updatedAt: new Date().toISOString(),
      state: {
        selectedHunkIndex: 0,
        showAgentNotes: false,
        liveCommentCount: 0,
        liveComments: [],
        reviewPublication: fixture.body.publication,
      },
    },
  );
}

/** Read SSE records until one complete event has arrived, then stop. */
async function readOneEvent(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: DecodedFrame[] = [];
  let buffer = "";
  let complete = false;
  while (!complete) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const lines = buffer.slice(0, boundary).split("\n");
      buffer = buffer.slice(boundary + 2);
      const id = lines.find((line) => line.startsWith("id: "))?.slice(4);
      const event = lines.find((line) => line.startsWith("event: "))?.slice(7);
      const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
      if (event && data !== undefined) {
        frames.push({ ...(id ? { id } : {}), event, data: JSON.parse(data) as unknown });
        // Only a frame that completes an event carries an id, which is how a reader knows
        // where an event ends without knowing whether it was chunked.
        complete ||= id !== undefined;
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
  await reader.cancel();
  return frames;
}

/** Whether the frames read back reassemble to the body the fixture published. */
function roundTripsTo(frames: DecodedFrame[], expected: string) {
  if (frames.length === 1) {
    return JSON.stringify(parseReviewEventFrame(frames[0]!.data)?.payload) === expected;
  }
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

export const browserReviewSurfaceEventConsumer: ReviewEventConsumer = {
  name: "browser review HTTP surface",
  phase: "Phase 4",
  async frame(fixture: ReviewEventFixture) {
    const serialized = JSON.stringify(fixture.body);
    const state = new HunkSessionBrokerState();
    mirrorFixture(state, fixture);
    const review = new BrowserReviewServer(state, {
      eventChunkBytes: resolveFixtureChunkBytes(
        fixture,
        new TextEncoder().encode(serialized).byteLength,
      ),
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch: async (request) =>
        (await review.handle(request)) ?? new Response(null, { status: 404 }),
    });

    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}${reviewHttpPath({
          kind: "events",
          sessionId: EVENT_FIXTURE_SESSION_ID,
        })}`,
        { headers: { [HUNK_REVIEW_CAPABILITY_HEADER]: reviewProcessCapability().token } },
      );
      const frames = await readOneEvent(response);
      return {
        frames: collapseChunkRun(frames.map((frame) => frame.event)),
        resumableFrames: frames.filter((frame) => frame.id !== undefined).length,
        roundTrips: roundTripsTo(frames, serialized),
      };
    } finally {
      review.close();
      server.stop(true);
      state.shutdown();
    }
  },
};
