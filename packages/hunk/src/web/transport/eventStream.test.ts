import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { LifecycleTimerClock } from "@hunk/session-broker-core/lifecycle";
import { encodeReviewEventFrame, planReviewEventFrames } from "../../session/reviewEventProtocol";
import { HUNK_REVIEW_PROTOCOL_VERSION } from "../../session/reviewProtocol";
import { ReviewApiError, type ReviewApiClient } from "./apiClient";
import { openReviewEventStream, type ReviewEventStreamStatus } from "./eventStream";

const ADDRESS = { generation: "generation:p1:0", stateRevision: 1 };

/** A clock that only fires timers when told to. */
function createTestClock() {
  const timers: Array<{ delayMs: number; callback: () => void; active: boolean }> = [];
  const clock: LifecycleTimerClock = {
    schedule(callback, delayMs) {
      const timer = { delayMs, callback, active: true };
      timers.push(timer);
      return () => {
        timer.active = false;
      };
    },
  };
  return {
    clock,
    delays: () => timers.map((timer) => timer.delayMs),
    fireNext() {
      const timer = timers.find((entry) => entry.active);
      if (timer) {
        timer.active = false;
        timer.callback();
      }
    },
  };
}

/** SSE text for one event. */
function frameTestEvent(type: "publication" | "disconnect", body: unknown) {
  const payload = new TextEncoder().encode(JSON.stringify(body));
  return planReviewEventFrames({
    type,
    address: ADDRESS,
    body,
    payload,
    contentDigest: createHash("sha256").update(payload).digest("hex"),
    encodeChunk: (bytes) => Buffer.from(bytes).toString("base64"),
  })
    .map(encodeReviewEventFrame)
    .join("");
}

/** A body that sends `text` and then ends. */
function createTestBody(text: string) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

const PUBLICATION = {
  protocolVersion: HUNK_REVIEW_PROTOCOL_VERSION,
  sessionId: "s",
  publication: ADDRESS,
  catalog: { generation: ADDRESS.generation, fileKeysByRuntimeId: {}, resources: [] },
};

/** A client whose stream opens play out the given script, one entry per attempt. */
function createTestClient(script: Array<string | ReviewApiError>) {
  let attempts = 0;
  const client = {
    async openEvents() {
      const step = script[attempts] ?? new ReviewApiError("network", "gone");
      attempts += 1;
      if (step instanceof ReviewApiError) throw step;
      return createTestBody(step);
    },
  } as unknown as ReviewApiClient;
  return { client, attempts: () => attempts };
}

/** Let pending promise work settle. */
async function settle() {
  for (let index = 0; index < 10; index += 1) await Bun.sleep(0);
}

describe("openReviewEventStream", () => {
  test("backs off between failed opens and starts over after an event arrives", async () => {
    const time = createTestClock();
    const { client, attempts } = createTestClient([
      new ReviewApiError("network", "down"),
      new ReviewApiError("network", "down"),
      frameTestEvent("publication", PUBLICATION),
      new ReviewApiError("network", "down"),
    ]);
    const events: unknown[] = [];
    const stream = openReviewEventStream({
      client,
      clock: time.clock,
      onEvent: (event) => events.push(event),
    });

    for (let step = 0; step < 3; step += 1) {
      await settle();
      time.fireNext();
    }
    await settle();
    stream.close();

    expect(attempts()).toBe(4);
    expect(events).toHaveLength(1);
    // 500 then 1000 for the two failures; the stream that delivered an event resets the
    // backoff, so its loss (the server ending it) waits 500 again and the next failure 1000.
    expect(time.delays()).toEqual([500, 1_000, 500, 1_000]);
  });

  test("stops for good when the session says goodbye", async () => {
    const time = createTestClock();
    const { client, attempts } = createTestClient([
      frameTestEvent("disconnect", { sessionId: "s" }),
    ]);
    const statuses: ReviewEventStreamStatus[] = [];

    openReviewEventStream({
      client,
      clock: time.clock,
      onEvent: () => undefined,
      onStatus: (s) => statuses.push(s),
    });
    await settle();

    expect(attempts()).toBe(1);
    expect(time.delays()).toEqual([]);
    expect(statuses.at(-1)).toEqual({ kind: "ended", reason: "disconnected" });
  });

  test("stops for good when the capability is refused", async () => {
    const time = createTestClock();
    const { client } = createTestClient([new ReviewApiError("unauthorized", "no")]);
    const statuses: ReviewEventStreamStatus[] = [];

    openReviewEventStream({
      client,
      clock: time.clock,
      onEvent: () => undefined,
      onStatus: (s) => statuses.push(s),
    });
    await settle();

    expect(time.delays()).toEqual([]);
    expect(statuses.at(-1)).toEqual({ kind: "ended", reason: "refused", code: "unauthorized" });
  });

  test("schedules nothing after close", async () => {
    const time = createTestClock();
    const { client, attempts } = createTestClient([new ReviewApiError("network", "down")]);
    const stream = openReviewEventStream({ client, clock: time.clock, onEvent: () => undefined });
    stream.close();
    await settle();
    time.fireNext();
    await settle();

    expect(attempts()).toBe(1);
  });
});
