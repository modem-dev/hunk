/**
 * Serves one real review session's HTTP API for browser-client tests.
 *
 * A real producer and broker state (through `connectReviewSession`) behind the real
 * `BrowserReviewServer` on a loopback listener; the returned `fetch` resolves the page's
 * relative paths against that listener, the way a browser resolves them against its location.
 */
import { reviewProcessCapability } from "../../packages/hunk/src/app/review/capability";
import type { DiffFile } from "../../packages/hunk/src/core/changeset/model";
import {
  BrowserReviewServer,
  type BrowserReviewServerOptions,
} from "../../packages/hunk/src/session/broker/browserReviewServer";
import { ReviewApiClient, type ReviewFetch } from "../../packages/hunk/src/web/transport/apiClient";
import { connectReviewSession } from "./review-session-harness";

export const TEST_WEB_REVIEW_SESSION_ID = "session-web-1";

/** Start one served review; call `stop` in `afterEach`. */
export function serveTestWebReview(
  files: DiffFile[],
  options: BrowserReviewServerOptions & { sessionId?: string } = {},
) {
  const sessionId = options.sessionId ?? TEST_WEB_REVIEW_SESSION_ID;
  const harness = connectReviewSession(files, { sessionId });
  harness.register();
  const review = new BrowserReviewServer(harness.state, options);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: async (request) => (await review.handle(request)) ?? new Response(null, { status: 404 }),
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const requests: string[] = [];
  const fetchFromPage: ReviewFetch = (input, init) => {
    const url = new URL(input, origin);
    requests.push(url.pathname + url.search);
    return fetch(url, init);
  };
  const capability = reviewProcessCapability().token;
  return {
    harness,
    origin,
    sessionId,
    capability,
    requests,
    fetch: fetchFromPage,
    client: (overrides: { capability?: string } = {}) =>
      new ReviewApiClient({
        sessionId,
        capability: overrides.capability ?? capability,
        fetch: fetchFromPage,
      }),
    stop() {
      review.close();
      server.stop(true);
    },
  };
}
