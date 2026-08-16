import { describe, expect, test } from "bun:test";
import { createTestDiffFile, createTestSourceFetcher } from "../../../test/helpers/diff-helpers";
import { resolveTheme } from "../themes";
import { HIGHLIGHT_WORKER_MIN_LINES } from "./diffRows";
import { prefetchHighlightedDiff, highlightedDiffCacheKey } from "./useHighlightedDiff";
import { registerHighlightWorker } from "./worker";

/** Register a worker double that fails every request and reports how often a retry reaches it. */
function registerFailingHighlightWorkerForTest() {
  const state = { calls: 0 };
  const worker = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    onerror: null as ((event: ErrorEvent) => void) | null,
    postMessage() {
      state.calls += 1;
      this.onerror?.({ message: "test worker failure" } as ErrorEvent);
    },
    terminate() {
      return Promise.resolve(0);
    },
    unref() {},
  };
  registerHighlightWorker(worker as unknown as Worker);
  return state;
}

describe("highlighted diff cache", () => {
  test("invalidates source-backed partial highlights when an unversioned provider changes", () => {
    const base = createTestDiffFile({ id: "cache", path: "cache.ts" });
    const firstFetcher = createTestSourceFetcher(() => "first source\n");
    const secondFetcher = createTestSourceFetcher(() => "second source\n");
    const first = {
      ...base,
      metadata: { ...base.metadata, isPartial: true },
      sourceFetcher: firstFetcher,
    };
    const second = { ...first, sourceFetcher: secondFetcher };
    const theme = resolveTheme("github-dark-default", null);

    expect(highlightedDiffCacheKey(theme, first)).toBe(highlightedDiffCacheKey(theme, first));
    expect(highlightedDiffCacheKey(theme, first)).not.toBe(highlightedDiffCacheKey(theme, second));
    expect(
      highlightedDiffCacheKey(theme, {
        ...first,
        metadata: { ...first.metadata, isPartial: false },
      }),
    ).toBe(
      highlightedDiffCacheKey(theme, {
        ...second,
        metadata: { ...second.metadata, isPartial: false },
      }),
    );
  });

  test("does not cache retryable worker failures", async () => {
    const lines = Array.from(
      { length: HIGHLIGHT_WORKER_MIN_LINES },
      (_, index) => `export const line${index} = ${index};`,
    ).join("\n");
    const file = createTestDiffFile({
      after: `${lines}\n`,
      before: "",
      id: "retryable-worker-failure",
    });
    const theme = resolveTheme("github-dark-default", null);
    const firstWorker = registerFailingHighlightWorkerForTest();

    const first = await prefetchHighlightedDiff({ file, theme });
    expect(first.retryable).toBe(true);
    expect(firstWorker.calls).toBe(1);

    // Registering another recovered/recreated worker should receive a new request instead of a
    // shared-cache hit for the first worker's plain-row fallback.
    const secondWorker = registerFailingHighlightWorkerForTest();
    const second = await prefetchHighlightedDiff({ file, theme });
    expect(second.retryable).toBe(true);
    expect(secondWorker.calls).toBe(1);
  });

  test("reuses source-backed highlights for equivalent versioned providers", () => {
    const base = createTestDiffFile({ id: "cache", path: "cache.ts" });
    const firstFetcher = Object.assign(
      createTestSourceFetcher(() => "same source\n"),
      {
        cacheKey: "snapshot-1",
      },
    );
    const secondFetcher = Object.assign(
      createTestSourceFetcher(() => "same source\n"),
      {
        cacheKey: "snapshot-1",
      },
    );
    const changedFetcher = Object.assign(
      createTestSourceFetcher(() => "changed source\n"),
      {
        cacheKey: "snapshot-2",
      },
    );
    const file = {
      ...base,
      metadata: { ...base.metadata, isPartial: true },
      sourceFetcher: firstFetcher,
    };
    const theme = resolveTheme("github-dark-default", null);

    expect(highlightedDiffCacheKey(theme, file)).toBe(
      highlightedDiffCacheKey(theme, { ...file, sourceFetcher: secondFetcher }),
    );
    expect(highlightedDiffCacheKey(theme, file)).not.toBe(
      highlightedDiffCacheKey(theme, { ...file, sourceFetcher: changedFetcher }),
    );
  });
});
