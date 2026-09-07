import { describe, expect, test } from "bun:test";
import {
  createTestDiffFile,
  createTestSourceFetcher,
} from "../../../../../test/helpers/diff-helpers";
import { resolveTheme } from "../themes";
import { HIGHLIGHT_WORKER_MIN_LINES } from "./diffRows";
import { prefetchHighlightedDiff, highlightedDiffCacheKey } from "./useHighlightedDiff";
import { registerHighlightWorker } from "./worker";

/** Build one file large enough to qualify for worker highlighting. */
function createLargeHighlightTestFile(id: string) {
  const lines = Array.from(
    { length: HIGHLIGHT_WORKER_MIN_LINES },
    (_, index) => `export const line${index} = ${index};`,
  ).join("\n");
  return createTestDiffFile({ after: `${lines}\n`, before: "", id });
}

/** Build equal-length patches whose only difference sits outside the former sampled regions. */
function createAdversarialPatch(marker: string) {
  return `${"x".repeat(96)}${marker}${"x".repeat(415)}`;
}

/** Reproduce the former sampled patch identity to prove the regression fixture collides there. */
function sampledPatchFingerprintForTest(patch: string) {
  const mid = Math.floor(patch.length / 2);
  return `${patch.length}:${patch.slice(0, 64)}:${patch.slice(mid, mid + 64)}:${patch.slice(-64)}`;
}

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
  test("does not reuse stale highlighted text for patches that collide under sampling", async () => {
    const firstPatch = createAdversarialPatch("a");
    const secondPatch = createAdversarialPatch("b");
    const first = {
      ...createTestDiffFile({
        after: 'const marker = "one";\n',
        before: 'const marker = "base";\n',
        id: "adversarial-patch-cache",
        path: "adversarial.ts",
      }),
      patch: firstPatch,
    };
    const second = {
      ...createTestDiffFile({
        after: 'const marker = "two";\n',
        before: 'const marker = "base";\n',
        id: "adversarial-patch-cache",
        path: "adversarial.ts",
      }),
      patch: secondPatch,
    };
    const patchOnlyChange = { ...first, patch: secondPatch };
    const theme = resolveTheme("github-dark-default", null);

    expect(sampledPatchFingerprintForTest(firstPatch)).toBe(
      sampledPatchFingerprintForTest(secondPatch),
    );
    // Keep metadata identical here so only the formerly unsampled patch content can change the key.
    expect(highlightedDiffCacheKey(theme, first)).not.toBe(
      highlightedDiffCacheKey(theme, patchOnlyChange),
    );
    expect(highlightedDiffCacheKey(theme, first)).not.toBe(highlightedDiffCacheKey(theme, second));

    const firstHighlight = await prefetchHighlightedDiff({ file: first, theme });
    const secondHighlight = await prefetchHighlightedDiff({ file: second, theme });
    expect(secondHighlight).not.toBe(firstHighlight);
    expect(JSON.stringify(firstHighlight.additionLines)).toContain("one");
    expect(JSON.stringify(secondHighlight.additionLines)).toContain("two");
    expect(JSON.stringify(secondHighlight.additionLines)).not.toContain("one");
  });

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

  test("keeps inline highlighting as the default and offloads only when requested", async () => {
    const theme = resolveTheme("github-dark-default", null);
    const worker = registerFailingHighlightWorkerForTest();

    const inline = await prefetchHighlightedDiff({
      file: createLargeHighlightTestFile("default-inline-highlight"),
      theme,
    });
    expect(inline.retryable).toBeUndefined();
    expect(worker.calls).toBe(0);

    const offloaded = await prefetchHighlightedDiff({
      file: createLargeHighlightTestFile("fast-worker-highlight"),
      offloadLargeDiff: true,
      theme,
    });
    expect(offloaded.retryable).toBe(true);
    expect(worker.calls).toBe(1);
  });

  test("does not cache retryable worker failures", async () => {
    const file = createLargeHighlightTestFile("retryable-worker-failure");
    const theme = resolveTheme("github-dark-default", null);
    const firstWorker = registerFailingHighlightWorkerForTest();

    const first = await prefetchHighlightedDiff({ file, offloadLargeDiff: true, theme });
    expect(first.retryable).toBe(true);
    expect(firstWorker.calls).toBe(1);

    // Registering another recovered/recreated worker should receive a new request instead of a
    // shared-cache hit for the first worker's plain-row fallback.
    const secondWorker = registerFailingHighlightWorkerForTest();
    const second = await prefetchHighlightedDiff({ file, offloadLargeDiff: true, theme });
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
