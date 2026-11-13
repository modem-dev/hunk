/**
 * The browser client's event reader as an event consumer.
 *
 * The other half of C4: the server side is registered as the HTTP surface, and this is the
 * page reading that same surface — the real `BrowserReviewServer` on a real listener, opened
 * through the page's `ReviewApiClient`, split by its SSE parser, and decoded by its
 * `ReviewEventDecoder` with Web Crypto verification. A reader that had grown its own frame
 * names, envelopes, or idea of which frame completes an event disagrees with the reference
 * consumer on these fixtures.
 */
import { reviewProcessCapability } from "../../../packages/hunk/src/app/review/capability";
import { BrowserReviewServer } from "../../../packages/hunk/src/session/broker/browserReviewServer";
import { HunkSessionBrokerState } from "../../../packages/hunk/src/session/broker/state";
import { ReviewApiClient } from "../../../packages/hunk/src/web/transport/apiClient";
import {
  ReviewEventDecoder,
  ServerSentEventParser,
  type ServerSentEventRecord,
} from "../../../packages/hunk/src/web/transport/eventReader";
import { EVENT_FIXTURE_SESSION_ID } from "../eventFixtures";
import { collapseChunkRun, resolveFixtureChunkBytes } from "../eventFraming";
import type { ReviewEventConsumer, ReviewEventFixture } from "../types";
import { mirrorFixture } from "./browserReviewSurface";

/** Read SSE records from the page's stream until one carries an id, then stop. */
async function readOneEventRecords(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const text = new TextDecoder();
  const parser = new ServerSentEventParser();
  const records: ServerSentEventRecord[] = [];
  try {
    while (!records.some((record) => record.id !== undefined)) {
      const { value, done } = await reader.read();
      if (done) break;
      records.push(...parser.push(text.decode(value, { stream: true })));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return records;
}

export const browserEventReaderConsumer: ReviewEventConsumer = {
  name: "browser client event reader",
  phase: "M4",
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
    const origin = `http://127.0.0.1:${server.port}`;

    try {
      const client = new ReviewApiClient({
        sessionId: EVENT_FIXTURE_SESSION_ID,
        capability: reviewProcessCapability().token,
        fetch: (input, init) => fetch(new URL(input, origin), init),
      });
      const records = await readOneEventRecords(await client.openEvents());
      const decoder = new ReviewEventDecoder();
      let decoded: unknown;
      let roundTrips = true;
      try {
        for (const record of records) {
          decoded = (await decoder.decode(record)) ?? decoded;
        }
      } catch {
        roundTrips = false;
      }
      return {
        frames: collapseChunkRun(records.map((record) => record.event)),
        resumableFrames: records.filter((record) => record.id !== undefined).length,
        roundTrips:
          roundTrips &&
          JSON.stringify((decoded as { body?: unknown } | undefined)?.body) === serialized,
      };
    } finally {
      review.close();
      server.stop(true);
      state.shutdown();
    }
  },
};
