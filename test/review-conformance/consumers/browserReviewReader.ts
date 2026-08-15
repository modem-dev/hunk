/**
 * The browser client's event reader as an event consumer.
 *
 * The surface answers this corpus by framing a publication; the client answers it by
 * reading one back. Running both against the same fixtures is what closes C4: a client
 * that had re-declared frame names, envelopes, or which frame is resumable would disagree
 * with the protocol here rather than in a browser
 * (`docs/browser-review-seam-audit.md`, C4).
 *
 * The client is the real one, reading a real stream from a real listener. What the adapter
 * adds is an observer: the response body is duplicated on its way into the client, so the
 * frames can be counted without the client being asked to report them — it has no reason
 * to, and a reader that reported its own framing would be describing itself.
 */
import { SESSION_BROKER_REGISTRATION_VERSION } from "@hunk/session-broker-core";
import { reviewProcessCapability } from "../../../src/app/review/capability";
import { WebReviewServer } from "../../../src/session/broker/webReviewServer";
import { HunkSessionBrokerState } from "../../../src/session/broker/state";
import { ReviewEventSseDecoder } from "../../../src/session/reviewEventProtocol";
import { BrowserReviewApiClient } from "../../../src/web/reviewApiClient";
import { EVENT_FIXTURE_SESSION_ID } from "../eventFixtures";
import { collapseChunkRun, resolveFixtureChunkBytes } from "../eventFraming";
import type { ReviewEventConsumer, ReviewEventFixture } from "../types";

/** Register the fixture's publication with a real broker state, through its own parsers. */
function mirrorFixture(state: HunkSessionBrokerState, fixture: ReviewEventFixture) {
  state.registerSession(
    { send: () => undefined },
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

/** Read the observed stream text with the protocol's own record decoder. */
function observedRecords(text: string) {
  return new ReviewEventSseDecoder().push(text).map((record) => ({
    event: record.event,
    // Only a record that completes an event carries an id, which is the protocol's rule
    // rather than this adapter's reading of one.
    resumable: record.id !== undefined,
  }));
}

export const browserReviewReaderEventConsumer: ReviewEventConsumer = {
  name: "browser review client reader",
  phase: "Phase 5 PR 1",
  async frame(fixture: ReviewEventFixture) {
    const serialized = JSON.stringify(fixture.body);
    const state = new HunkSessionBrokerState();
    mirrorFixture(state, fixture);
    const review = new WebReviewServer(state, {
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

    let observed = "";
    const client = new BrowserReviewApiClient({
      origin: `http://127.0.0.1:${server.port}`,
      sessionId: EVENT_FIXTURE_SESSION_ID,
      capability: reviewProcessCapability().token,
      fetch: (async (input: string, init: RequestInit) => {
        const response = await fetch(input, init);
        if (!response.body) {
          return response;
        }
        // Tee rather than intercept: the client reads one branch and the adapter the
        // other, so what is counted is exactly what the client parsed.
        const [toClient, toObserver] = response.body.tee();
        void (async () => {
          const decoder = new TextDecoder();
          for await (const chunk of toObserver as unknown as AsyncIterable<Uint8Array>) {
            observed += decoder.decode(chunk, { stream: true });
          }
        })().catch(() => {
          // The observer branch ends when the client aborts the stream, which is how a
          // reader that has what it came for stops reading.
        });
        return new Response(toClient, { headers: response.headers, status: response.status });
      }) as unknown as typeof globalThis.fetch,
    });

    try {
      const abort = new AbortController();
      let delivered: unknown;
      await client.streamEvents(
        {
          onPublication: (body) => {
            delivered = body;
            // One complete event is the whole question; the stream stays open otherwise.
            abort.abort();
          },
        },
        abort.signal,
      );
      const records = observedRecords(observed);
      return {
        frames: collapseChunkRun(records.map((record) => record.event)),
        resumableFrames: records.filter((record) => record.resumable).length,
        roundTrips: JSON.stringify(delivered) === serialized,
      };
    } finally {
      review.close();
      server.stop(true);
      state.shutdown();
    }
  },
};
