import { describe, expect, test } from "bun:test";
import { FEEDBACK_DESTINATION_HOST, type FeedbackPayload } from "./payload";
import {
  FEEDBACK_UNCONFIRMED_MESSAGE,
  feedbackEndpointUrl,
  sendFeedback,
  type FeedbackSendDeps,
} from "./send";

const payload: FeedbackPayload = {
  submission_id: "0192e2f0-1a2b-7c3d-8e4f-5a6b7c8d9e0f",
  message: "hi",
  source: "tui",
  release: "0.24.1",
  tags: { category: "user_feedback", os: "linux", surface: "cli" },
};

interface RecordedTestRequest {
  url: string;
  init: RequestInit | undefined;
}

/** Build send deps whose fetch answers from a script of responses, recording each request. */
function createTestSendDeps(
  responses: Array<Response | Error | (() => Promise<Response>)>,
  overrides: FeedbackSendDeps = {},
) {
  const requests: RecordedTestRequest[] = [];
  const sleeps: number[] = [];
  const deps: FeedbackSendDeps = {
    token: "feedback_0123456789abcdef0123456789abcdef",
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), init });
      const next = responses.shift();
      if (!next) {
        throw new Error("unexpected request");
      }

      if (next instanceof Error) {
        throw next;
      }

      return typeof next === "function" ? next() : next;
    },
    ...overrides,
  };

  return { deps, requests, sleeps };
}

/** Build one JSON response. */
function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("sendFeedback", () => {
  test("pins the disclosed host to the real request host", () => {
    expect(new URL(feedbackEndpointUrl()).host).toBe(FEEDBACK_DESTINATION_HOST);
  });

  test("makes no request when the build has no channel token", async () => {
    const { deps, requests } = createTestSendDeps([], { token: "" });

    expect((await sendFeedback(payload, deps)).kind).toBe("unavailable");
    expect(requests).toHaveLength(0);
  });

  test("posts the exact payload with only the documented headers", async () => {
    const { deps, requests } = createTestSendDeps([jsonResponse({ id: "evt_1" }, 202)]);

    expect(await sendFeedback(payload, deps)).toEqual({ kind: "sent", id: "evt_1" });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://ingest.modem.dev/feedback");
    expect(requests[0]!.init?.method).toBe("POST");
    expect(requests[0]!.init?.headers).toEqual({
      Authorization: "Bearer feedback_0123456789abcdef0123456789abcdef",
      "Content-Type": "application/json",
      "User-Agent": "hunk",
    });
    expect(JSON.parse(String(requests[0]!.init?.body))).toEqual(payload);
  });

  test("retries a 5xx once with the same body", async () => {
    const { deps, requests } = createTestSendDeps([
      jsonResponse({ error: "boom" }, 500),
      jsonResponse({ id: "evt_2" }, 202),
    ]);

    expect(await sendFeedback(payload, deps)).toEqual({ kind: "sent", id: "evt_2" });
    expect(requests.map((request) => request.init?.body)).toEqual([
      requests[0]!.init?.body,
      requests[0]!.init?.body,
    ]);
  });

  test("reports a failure after the 5xx retry is spent", async () => {
    const { deps, requests } = createTestSendDeps([jsonResponse({}, 500), jsonResponse({}, 503)]);

    expect(await sendFeedback(payload, deps)).toEqual({
      kind: "failed",
      message: "Modem couldn't record the feedback. Try again later.",
    });
    expect(requests).toHaveLength(2);
  });

  test("waits for Retry-After on 409 and retries up to twice", async () => {
    const { deps, requests, sleeps } = createTestSendDeps([
      jsonResponse({}, 409, { "retry-after": "1" }),
      jsonResponse({}, 409, { "retry-after": "2" }),
      jsonResponse({ id: "evt_3" }, 202),
    ]);

    expect(await sendFeedback(payload, deps)).toEqual({ kind: "sent", id: "evt_3" });
    expect(sleeps).toEqual([1_000, 2_000]);
    expect(requests).toHaveLength(3);
  });

  test("never retries other 4xx responses", async () => {
    const { deps, requests } = createTestSendDeps([
      jsonResponse({ error: "Invalid", details: ["message: too long"] }, 400),
    ]);

    const result = await sendFeedback(payload, deps);

    expect(result.kind).toBe("failed");
    expect(result.kind === "failed" && result.message).toContain("message: too long");
    expect(requests).toHaveLength(1);
  });

  test("maps 401 to unavailable with the GitHub issues fallback", async () => {
    const { deps } = createTestSendDeps([jsonResponse({ error: "Unauthorized" }, 401)]);

    const result = await sendFeedback(payload, deps);

    expect(result.kind).toBe("unavailable");
    expect(result.kind === "unavailable" && result.message).toContain(
      "https://github.com/modem-dev/hunk/issues",
    );
  });

  test("maps 429 to a rate-limit message without retrying", async () => {
    const { deps, requests } = createTestSendDeps([jsonResponse({}, 429)]);

    expect(await sendFeedback(payload, deps)).toEqual({
      kind: "failed",
      message: "Too much feedback right now. Try again in a minute.",
    });
    expect(requests).toHaveLength(1);
  });

  test("reports a dropped connection as unconfirmed after one retry", async () => {
    const { deps, requests } = createTestSendDeps([new Error("reset"), new Error("reset")]);

    expect(await sendFeedback(payload, deps)).toEqual({
      kind: "unconfirmed",
      message: FEEDBACK_UNCONFIRMED_MESSAGE,
    });
    expect(requests).toHaveLength(2);
  });

  test("reports a timeout as unconfirmed after one retry", async () => {
    let calls = 0;
    const deps: FeedbackSendDeps = {
      token: "feedback_0123456789abcdef0123456789abcdef",
      timeoutMs: 5,
      fetchImpl: async (_input, init) => {
        calls += 1;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("timed out")));
        });
      },
    };

    expect((await sendFeedback(payload, deps)).kind).toBe("unconfirmed");
    expect(calls).toBe(2);
  });

  test("treats the person's abort as unconfirmed and does not retry", async () => {
    const controller = new AbortController();
    let calls = 0;
    const deps: FeedbackSendDeps = {
      token: "feedback_0123456789abcdef0123456789abcdef",
      signal: controller.signal,
      fetchImpl: async (_input, init) => {
        calls += 1;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          controller.abort();
        });
      },
    };

    expect((await sendFeedback(payload, deps)).kind).toBe("unconfirmed");
    expect(calls).toBe(1);
  });
});
