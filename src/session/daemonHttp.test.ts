import { describe, expect, test } from "bun:test";
import { requestSessionDaemonHttp, withSessionDaemonHttpTimeout } from "./daemonHttp";

function createLatePromise<ResultType>(value: ResultType, delayMs = 100) {
  return new Promise<ResultType>((resolve) => {
    const timeout = setTimeout(() => resolve(value), delayMs);
    timeout.unref?.();
  });
}

describe("session daemon HTTP timeout wrapper", () => {
  test("times out tasks that ignore abort signals", async () => {
    await expect(
      withSessionDaemonHttpTimeout({
        operation: "finish a stubborn request",
        timeoutMs: 10,
        task: async () => createLatePromise("late"),
      }),
    ).rejects.toThrow(
      "Timed out waiting for the Hunk session daemon to finish a stubborn request.",
    );
  });

  test("keeps the timeout active while callers parse the response body", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("ok")) as unknown as typeof fetch;

    try {
      await expect(
        requestSessionDaemonHttp({
          config: {
            host: "127.0.0.1",
            port: 47657,
            httpOrigin: "http://127.0.0.1:47657",
            wsOrigin: "ws://127.0.0.1:47657",
          },
          path: "/session-api",
          operation: "parse a stuck body",
          timeoutMs: 10,
          parse: async () => createLatePromise("late"),
        }),
      ).rejects.toThrow("Timed out waiting for the Hunk session daemon to parse a stuck body.");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
