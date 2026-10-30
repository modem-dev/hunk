import { expect, test } from "bun:test";
import type { VcsHistorySource } from "../core/vcs/types";
import { createHistoryCursorLifecycle } from "./historyCursorLifecycle";
import { createTestDeferred } from "../../../../test/helpers/diff-helpers";

/** Reproduce a provider that closes automatically when cancellation releases its final read. */
test("close retains cleanup failure when an aborted read races EOF", async () => {
  const abort = new AbortController();
  let closed = false;
  let cleanupCalls = 0;
  const failure = new Error("Provider cleanup rejected");
  const source: VcsHistorySource = {
    async read({ signal }) {
      await new Promise<void>((resolve) =>
        signal!.addEventListener("abort", () => resolve(), { once: true }),
      );
      await source.close();
      return { commits: [], done: true };
    },
    async close() {
      if (closed) return;
      closed = true;
      cleanupCalls++;
      throw failure;
    },
  };
  const cursor = createHistoryCursorLifecycle(source, async () => source);
  const reading = source.read({ limit: 1, signal: abort.signal });

  abort.abort();
  const closing = cursor.close();
  const [cleanup, read] = await Promise.allSettled([closing, reading]);

  expect(cleanup).toEqual({ status: "rejected", reason: failure });
  expect(read.status).toBe("fulfilled");
  expect(cleanupCalls).toBe(1);
  expect(cursor.close()).toBe(closing);
});

for (const settlesBeforeQuit of [false, true]) {
  test(`close reports retired cursor cleanup failure ${settlesBeforeQuit ? "before" : "during"} quit`, async () => {
    const cleanup = createTestDeferred<void>();
    const cleanupStarted = createTestDeferred<void>();
    const failure = new Error("Retired cursor cleanup rejected");
    let previousCloses = 0;
    let replacementCloses = 0;
    const previous: VcsHistorySource = {
      async read() {
        return { commits: [], done: true };
      },
      close() {
        previousCloses++;
        cleanupStarted.resolve();
        return cleanup.promise;
      },
    };
    const replacement: VcsHistorySource = {
      async read() {
        return { commits: [], done: true };
      },
      async close() {
        replacementCloses++;
      },
    };
    const cursor = createHistoryCursorLifecycle(previous, async () => replacement);
    const refresh = cursor.reopenSource();
    const refreshResult = Promise.allSettled([refresh]);
    await cleanupStarted.promise;

    if (settlesBeforeQuit) {
      cleanup.reject(failure);
      expect(await refreshResult).toEqual([{ status: "rejected", reason: failure }]);
    }
    let settled = false;
    const closing = cursor.close();
    const closeResult = Promise.allSettled([closing]).then((result) => {
      settled = true;
      return result;
    });
    expect(cursor.close()).toBe(closing);
    if (!settlesBeforeQuit) {
      await Promise.resolve();
      expect(settled).toBe(false);
      cleanup.reject(failure);
    }

    expect(await closeResult).toEqual([{ status: "rejected", reason: failure }]);
    expect(await refreshResult).toEqual([{ status: "rejected", reason: failure }]);
    expect(previousCloses).toBe(1);
    expect(replacementCloses).toBe(1);
  });
}
