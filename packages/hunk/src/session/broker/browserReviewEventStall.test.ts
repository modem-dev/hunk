/**
 * Event streams that stop reading, or outlive their authorization, end at a heartbeat.
 *
 * Driven through `handle()` directly with a response body nobody reads, so the stream's queue
 * fills exactly as it does behind a reader that stopped; no socket buffers stand in between.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { reviewProcessCapability } from "../../app/review/capability";
import { createTestDiffFile } from "../../../../../test/helpers/diff-helpers";
import { connectReviewSession } from "../../../../../test/helpers/review-session-harness";
import { HUNK_REVIEW_CAPABILITY_HEADER, reviewHttpPath } from "../reviewHttpProtocol";
import { BrowserReviewServer } from "./browserReviewServer";

const SESSION_ID = "session-stall-1";
const HEARTBEAT_MS = 20;
const servers: BrowserReviewServer[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** Serve one registered session with a fast heartbeat. */
function startTestStallServer() {
  const harness = connectReviewSession([createTestDiffFile()], { sessionId: SESSION_ID });
  harness.register();
  harness.publishSnapshot();
  const review = new BrowserReviewServer(harness.state, { heartbeatMs: HEARTBEAT_MS });
  servers.push(review);
  return { harness, review };
}

/** Open one event stream through the surface itself. */
async function openTestStream(review: BrowserReviewServer) {
  const response = await review.handle(
    new Request(
      `http://127.0.0.1:4000${reviewHttpPath({ kind: "events", sessionId: SESSION_ID })}`,
      {
        headers: {
          host: "127.0.0.1:4000",
          [HUNK_REVIEW_CAPABILITY_HEADER]: reviewProcessCapability().token,
        },
      },
    ),
  );
  expect(response?.status).toBe(200);
  return response!;
}

/** Wait until a condition holds, polling across heartbeats. */
async function waitForTest(condition: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await Bun.sleep(HEARTBEAT_MS / 2);
  }
}

describe("browser review event streams: stalled readers", () => {
  test("ends a stream whose reader stopped, within a few heartbeats", async () => {
    const { review } = startTestStallServer();
    await openTestStream(review);
    expect(review.getStreamCount()).toBe(1);

    // Nobody reads the body: the opening publication and every heartbeat stay queued.
    await waitForTest(() => review.getStreamCount() === 0);
  });

  test("keeps a stream whose reader keeps reading", async () => {
    const { review } = startTestStallServer();
    const response = await openTestStream(review);
    const reader = response.body!.getReader();
    let reading = true;
    void (async () => {
      while (reading) {
        const chunk = await reader.read();
        if (chunk.done) return;
      }
    })();

    await Bun.sleep(HEARTBEAT_MS * 10);
    expect(review.getStreamCount()).toBe(1);
    reading = false;
    await reader.cancel();
  });

  test("ends a stream at the next heartbeat once its capability no longer matches", async () => {
    const { harness, review } = startTestStallServer();
    const response = await openTestStream(review);
    const reader = response.body!.getReader();
    void (async () => {
      for (;;) {
        const chunk = await reader.read().catch(() => ({ done: true }));
        if (chunk.done) return;
      }
    })();
    expect(review.getStreamCount()).toBe(1);

    // The session re-registered under another capability, with no publication to announce it.
    const real = harness.state.getReviewCapabilityDigest.bind(harness.state);
    harness.state.getReviewCapabilityDigest = (sessionId: string) =>
      sessionId === SESSION_ID ? "0".repeat(64) : real(sessionId);

    await waitForTest(() => review.getStreamCount() === 0);
  });
});
