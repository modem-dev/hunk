import { afterEach, describe, expect, test } from "bun:test";
import { reviewProcessCapability } from "../app/review/capability";
import { REVIEW_RESOURCE_CHUNK_BYTES } from "../core/review/resources";
import { BrowserReviewServer } from "../session/broker/browserReviewServer";
import { reviewErrorMessage } from "../session/reviewErrorCatalog";
import { HUNK_REVIEW_CAPABILITY_HEADER, reviewUrl } from "../session/reviewHttpProtocol";
import {
  connectReviewSession,
  createTestPatchFile,
} from "../../../../test/helpers/review-session-harness";
import { loadReviewShell } from "./reviewShellClient";

const SESSION_ID = "session-shell-1";
const originalFetch = globalThis.fetch;
const running: Array<() => void> = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const stop of running.splice(0)) {
    stop();
  }
});

/** Serve one registered session's review API and route the page's relative fetches to it. */
function serveTestReview(
  files = [createTestPatchFile("alpha", 4), createTestPatchFile("beta", 2)],
) {
  const harness = connectReviewSession(files, { sessionId: SESSION_ID });
  harness.register();
  const review = new BrowserReviewServer(harness.state);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => (await review.handle(request)) ?? new Response(null, { status: 404 }),
  });
  running.push(() => {
    review.close();
    server.stop(true);
  });

  const origin = `http://127.0.0.1:${server.port}`;
  const requests: Request[] = [];
  // The page fetches same-origin relative paths; a browser resolves them against its location.
  globalThis.fetch = Object.assign(
    (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(new URL(String(input), origin), init);
      requests.push(request.clone());
      return originalFetch(request);
    },
    { preconnect: originalFetch.preconnect },
  );
  return { files, origin, requests };
}

/** The page location a person lands on when opening the review URL. */
function testPageLocation(origin: string, capability = reviewProcessCapability().token) {
  const url = new URL(reviewUrl(origin, SESSION_ID, capability));
  return { pathname: url.pathname, hash: url.hash };
}

describe("review shell client", () => {
  test("connects, counts the files, and reads the first file's patch", async () => {
    const { files, origin, requests } = serveTestReview();

    const result = await loadReviewShell(testPageLocation(origin));

    expect(result).toEqual({
      status: "connected",
      sessionId: SESSION_ID,
      fileCount: 2,
      firstPatch: files[0]!.patch,
    });
    // The capability travels only in its header: never in a path or a query string.
    const capability = reviewProcessCapability().token;
    for (const request of requests) {
      expect(request.url).not.toContain(capability);
      expect(request.headers.get(HUNK_REVIEW_CAPABILITY_HEADER)).toBe(capability);
    }
  });

  test("reads a patch longer than one response window", async () => {
    const long = createTestPatchFile("long", 8_000);
    expect(long.patch.length).toBeGreaterThan(REVIEW_RESOURCE_CHUNK_BYTES);
    const { origin } = serveTestReview([long]);

    const result = await loadReviewShell(testPageLocation(origin));

    expect(result.status === "connected" && result.firstPatch).toBe(long.patch);
  });

  test("reports a refused capability with the shared catalog sentence", async () => {
    const { origin } = serveTestReview();

    const result = await loadReviewShell(testPageLocation(origin, "A".repeat(43)));

    expect(result).toEqual({ status: "failed", message: reviewErrorMessage("unauthorized") });
  });

  test("refuses to start without a capability in the fragment", async () => {
    const { origin, requests } = serveTestReview();
    const location = testPageLocation(origin);

    const result = await loadReviewShell({ pathname: location.pathname, hash: "" });

    expect(result).toEqual({ status: "failed", message: reviewErrorMessage("unauthorized") });
    expect(requests).toEqual([]);
  });

  test("explains an unreachable daemon without throwing", async () => {
    globalThis.fetch = Object.assign(
      async () => {
        throw new TypeError("fetch failed");
      },
      { preconnect: originalFetch.preconnect },
    );

    const result = await loadReviewShell(testPageLocation("http://127.0.0.1:9"));

    expect(result.status).toBe("failed");
  });
});
