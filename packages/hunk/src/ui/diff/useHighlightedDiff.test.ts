import { afterAll, describe, expect, test } from "bun:test";
import {
  createTestDiffFile,
  createTestSourceFetcher,
} from "../../../../../test/helpers/diff-helpers";
import type { DiffFile } from "../../core/changeset/model";
import { resolveTheme } from "../themes";
import { buildUnifiedRows, type HighlightedDiffCode } from "./diffRows";
import {
  hasPendingHighlightedDiffs,
  highlightedDiffCacheKey,
  prefetchHighlightedDiff,
  subscribeToHighlightedDiff,
  waitForHighlightedDiffIdle,
} from "./useHighlightedDiff";
import { disposeHighlightWorker, registerHighlightWorker } from "./worker";

/** Build one added file whose highlighting routes through the worker. */
function createLargeHighlightTestFile(id: string) {
  const lines = Array.from(
    { length: 40 },
    (_, index) => `export const line${index} = ${index};`,
  ).join("\n");
  return createTestDiffFile({ after: `${lines}\n`, before: "", id });
}

afterAll(() => {
  disposeHighlightWorker();
});

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
  test("reports idle only after every started highlight finishes", async () => {
    const file = createTestDiffFile({
      after: 'export const status = "pending";\n',
      before: 'export const status = "idle";\n',
      id: "highlight-idle",
      path: "highlight-idle.ts",
    });
    const theme = resolveTheme("github-dark-default", null);
    const pending = prefetchHighlightedDiff({ file, theme });

    expect(hasPendingHighlightedDiffs()).toBe(true);
    await waitForHighlightedDiffIdle();

    expect(hasPendingHighlightedDiffs()).toBe(false);
    await pending;
  });

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
    const rowText = (file: DiffFile, highlighted: HighlightedDiffCode) =>
      buildUnifiedRows(file, highlighted, theme)
        .flatMap((row) => (row.type === "unified-line" ? row.cell.spans : []))
        .map((span) => span.text)
        .join("");
    expect(rowText(first, firstHighlight)).toContain("one");
    expect(rowText(second, secondHighlight)).toContain("two");
    expect(rowText(second, secondHighlight)).not.toContain("one");
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

  test("routes interactive highlighting through the worker by default", async () => {
    const theme = resolveTheme("github-dark-default", null);
    const worker = registerFailingHighlightWorkerForTest();

    const offloaded = await prefetchHighlightedDiff({
      file: createLargeHighlightTestFile("default-worker-highlight"),
      theme,
    });
    expect(offloaded.retryable).toBe(true);
    expect(worker.calls).toBe(1);
  });

  test("does not cache retryable worker failures", async () => {
    const file = createLargeHighlightTestFile("retryable-worker-failure");
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

  test("stops re-requesting a worker highlight once the retry budget is spent", async () => {
    const file = createLargeHighlightTestFile("exhausted-worker-retries");
    const theme = resolveTheme("github-dark-default", null);

    // Viewport prefetch re-requests every file in its halo on each scroll, so a failure that keeps
    // repeating must settle on cached plain rows instead of restarting the highlight every time.
    for (const expectedCalls of [1, 1]) {
      const worker = registerFailingHighlightWorkerForTest();
      const result = await prefetchHighlightedDiff({ file, theme });
      expect(result.retryable).toBe(true);
      expect(worker.calls).toBe(expectedCalls);
    }

    const settledWorker = registerFailingHighlightWorkerForTest();
    const settled = await prefetchHighlightedDiff({ file, theme });
    expect(settled.retryable).toBeUndefined();
    expect(settledWorker.calls).toBe(0);
  });

  test("reclaims abandoned revision budgets while retaining the most recent failure", async () => {
    const base = createLargeHighlightTestFile("abandoned-revision-budget");
    const theme = resolveTheme("github-dark-default", null);

    /** Give each abandoned snapshot its own highlight identity without rebuilding its source. */
    function createTestRevision(index: number) {
      return { ...base, id: `abandoned-revision-budget-${index}` };
    }

    // Exceed the 1,024-key retry-history bound without ever revisiting the first failures.
    for (let index = 0; index < 1_100; index += 1) {
      registerFailingHighlightWorkerForTest();
      await prefetchHighlightedDiff({
        file: createTestRevision(index),
        theme,
      });
    }

    // The oldest key gets a fresh retry budget rather than retaining its abandoned first failure.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const worker = registerFailingHighlightWorkerForTest();
      await prefetchHighlightedDiff({ file: createTestRevision(0), theme });
      expect(worker.calls).toBe(1);
    }

    // A recent key still has its original failure and settles after just one additional attempt.
    registerFailingHighlightWorkerForTest();
    await prefetchHighlightedDiff({
      file: createTestRevision(1_099),
      theme,
    });
    const worker = registerFailingHighlightWorkerForTest();
    const settled = await prefetchHighlightedDiff({
      file: createTestRevision(1_099),
      theme,
    });
    expect(settled.retryable).toBeUndefined();
    expect(worker.calls).toBe(0);
  });

  test("wakes a reader holding provisional rows when the key finally caches a result", async () => {
    const file = createLargeHighlightTestFile("provisional-reader-wakeup");
    const theme = resolveTheme("github-dark-default", null);
    const cacheKey = highlightedDiffCacheKey(theme, file);

    registerFailingHighlightWorkerForTest();
    const first = await prefetchHighlightedDiff({ file, theme });
    expect(first.retryable).toBe(true);

    // A mounted file showing those provisional rows has no other signal: viewport prefetch fills
    // the shared cache without rendering anything.
    let notified = 0;
    const unsubscribe = subscribeToHighlightedDiff(cacheKey, () => {
      notified += 1;
    });

    try {
      registerFailingHighlightWorkerForTest();
      await prefetchHighlightedDiff({ file, theme });

      expect(notified).toBe(1);
    } finally {
      unsubscribe();
    }

    // Unsubscribed readers stop hearing about the key.
    await prefetchHighlightedDiff({ file, theme });
    expect(notified).toBe(1);
  });

  test("wakes a provisional reader when the retry completes before it subscribes", async () => {
    const file = createLargeHighlightTestFile("late-provisional-reader");
    const theme = resolveTheme("github-dark-default", null);
    registerFailingHighlightWorkerForTest();
    const first = await prefetchHighlightedDiff({ file, theme });
    expect(first.retryable).toBe(true);

    // Complete a successful retry in the window between the provisional render and its effect.
    const successful = await prefetchHighlightedDiff({ file, theme });
    expect(successful.retryable).toBeUndefined();
    expect(
      successful.compact?.payload.addition.lineOffsets.length ?? successful.additionLines.length,
    ).toBeGreaterThan(0);

    let notified = 0;
    const unsubscribe = subscribeToHighlightedDiff(highlightedDiffCacheKey(theme, file), () => {
      notified += 1;
    });
    try {
      expect(notified).toBe(1);
    } finally {
      unsubscribe();
    }
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
