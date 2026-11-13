/**
 * Event streams outlive the listener's connection idle timeout.
 *
 * A stream is quiet between publications, and Bun closes a connection idle for longer than
 * `idleTimeout` (10 s by default), which is shorter than the 15 s heartbeat. The listener here
 * uses a 1 s idle timeout (enforced by Bun at about 4 s) and a heartbeat far beyond it, so the only thing keeping the stream
 * open is the surface's `keepStreamOpen` seam — the same `server.timeout(request, 0)` the
 * daemon passes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { reviewProcessCapability } from "../../app/review/capability";
import {
  connectReviewSession,
  createTestPatchFile,
} from "../../../../../test/helpers/review-session-harness";
import { HUNK_REVIEW_CAPABILITY_HEADER, reviewHttpPath } from "../reviewHttpProtocol";
import { BrowserReviewServer } from "./browserReviewServer";

const SESSION_ID = "session-idle-1";
const running: Array<{ review: BrowserReviewServer; server: { stop: (force?: boolean) => void } }> =
  [];

afterEach(() => {
  for (const entry of running.splice(0)) {
    entry.review.close();
    entry.server.stop(true);
  }
});

/** Serve one session on a listener with a 1 s idle timeout, optionally exempting streams. */
function serveWithShortIdleTimeout(exemptStreams: boolean) {
  const harness = connectReviewSession([createTestPatchFile("alpha", 2)], {
    sessionId: SESSION_ID,
  });
  harness.register();
  let listener: ReturnType<typeof Bun.serve> | undefined;
  const review = new BrowserReviewServer(harness.state, {
    heartbeatMs: 60_000,
    ...(exemptStreams ? { keepStreamOpen: (request) => listener?.timeout(request, 0) } : {}),
  });
  listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 1,
    fetch: async (request) => (await review.handle(request)) ?? new Response(null, { status: 404 }),
  });
  running.push({ review, server: listener });
  return `http://127.0.0.1:${listener.port}`;
}

/** Open the event stream, consume its opening publication, and report whether it outlives `ms`. */
async function streamSurvives(origin: string, ms: number) {
  const response = await fetch(
    `${origin}${reviewHttpPath({ kind: "events", sessionId: SESSION_ID })}`,
    {
      headers: { [HUNK_REVIEW_CAPABILITY_HEADER]: reviewProcessCapability().token },
    },
  );
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const opening = await reader.read();
  expect(opening.done).toBe(false);
  const outcome = await Promise.race([
    reader.read().then(
      (chunk) => (chunk.done ? "closed" : "data"),
      () => "closed",
    ),
    Bun.sleep(ms).then(() => "open" as const),
  ]);
  await reader.cancel().catch(() => undefined);
  return outcome;
}

describe("browser review surface: event stream liveness", () => {
  test("an idle event stream stays open past the listener's idle timeout", async () => {
    // Bun enforces a 1 s idle timeout at roughly 4 s, so both streams wait 5 s, side by side:
    // the unexempted one guards the test itself by proving the timeout really cuts a stream.
    const [exempt, unexempt] = await Promise.all([
      streamSurvives(serveWithShortIdleTimeout(true), 5_000),
      streamSurvives(serveWithShortIdleTimeout(false), 5_000),
    ]);
    expect(unexempt).toBe("closed");
    expect(exempt).toBe("open");
  }, 15_000);
});
