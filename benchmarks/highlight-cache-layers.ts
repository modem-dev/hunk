// Compare a resident main-process cache hit with a worker-LRU revisit after main-cache eviction.
import { performance } from "node:perf_hooks";
import { parseDiffFromFile } from "@pierre/diffs";
import type { DiffFile } from "../packages/hunk/src/core/changeset/model";
import { resolveTheme } from "../packages/hunk/src/ui/themes";
import { disposeHighlightWorker } from "../packages/hunk/src/ui/diff/worker/highlightWorkerClient";
import { prefetchHighlightedDiff } from "../packages/hunk/src/ui/diff/useHighlightedDiff";

const lineCount = 8_000;
const theme = resolveTheme("github-dark-default", null);

/** Builds one unique large diff that always qualifies for worker highlighting. */
function createFile(index: number): DiffFile {
  const additions = Array.from(
    { length: lineCount },
    (_, line) => `export const marker${index}_${line} = ${line};`,
  ).join("\n");
  const path = `src/benchmark-${index}.ts`;
  const metadata = parseDiffFromFile(
    { name: path, contents: "export const prior = 1;\n", cacheKey: `before:${index}` },
    {
      name: path,
      contents: `export const prior = ${index};\n${additions}\n`,
      cacheKey: `after:${index}`,
    },
    { context: 3 },
    true,
  );

  return {
    id: `benchmark:${index}`,
    path,
    patch: "",
    language: "typescript",
    stats: { additions: lineCount, deletions: 1 },
    metadata,
    agent: null,
  };
}

/** Measures production prefetch orchestration for one large diff. */
async function timeHighlight(file: DiffFile) {
  const start = performance.now();
  await prefetchHighlightedDiff({ file, offloadLargeDiff: true, theme });
  return performance.now() - start;
}

try {
  const files = Array.from({ length: 8 }, (_, index) => createFile(index));
  const first = files[0];
  if (!first) {
    throw new Error("Expected benchmark files.");
  }

  const coldMs = await timeHighlight(first);
  const mainCacheHitMs = await timeHighlight(first);

  // Eight 8k-line entries exceed the 60k-line main-cache budget but fit in the 8 MiB compact
  // worker cache, making the next request a worker-LRU revisit.
  for (const file of files.slice(1)) {
    await timeHighlight(file);
  }
  const workerCacheHitAfterMainEvictionMs = await timeHighlight(first);

  console.log(`METRIC cold_ms=${coldMs.toFixed(2)}`);
  console.log(`METRIC main_cache_hit_ms=${mainCacheHitMs.toFixed(2)}`);
  console.log(
    `METRIC worker_cache_hit_after_main_eviction_ms=${workerCacheHitAfterMainEvictionMs.toFixed(2)}`,
  );
  console.log(`METRIC files=${files.length}`);
  console.log(`METRIC changed_lines=${lineCount}`);
} finally {
  disposeHighlightWorker();
}
