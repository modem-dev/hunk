// Measure a cold compact-worker highlight against a worker-local result-cache hit.
import { performance } from "node:perf_hooks";
import { parseDiffFromFile } from "@pierre/diffs";
import {
  disposeHighlightWorker,
  highlightDiffInWorker,
} from "../packages/hunk/src/ui/diff/worker/highlightWorkerClient";
import { compactHighlightedDiffByteLength } from "../packages/hunk/src/ui/diff/worker/highlightCompact";

const lineCount = 8_000;
const additions = Array.from(
  { length: lineCount },
  (_, index) => `export const marker${index} = ${index};`,
).join("\n");
const metadata = parseDiffFromFile(
  { name: "large.ts", contents: "export const prior = 1;\n", cacheKey: "measure:before" },
  {
    name: "large.ts",
    contents: `export const prior = 2;\n${additions}\n`,
    cacheKey: "measure:after",
  },
  { context: 3 },
  true,
);

/** Submit the same immutable metadata so the second call exercises the worker-owned LRU. */
function requestHighlight() {
  return highlightDiffInWorker({
    aliasContext: true,
    appearance: "dark",
    language: "typescript",
    metadata,
    theme: "pierre-dark",
  });
}

try {
  const coldStart = performance.now();
  const cold = await requestHighlight();
  const coldMs = performance.now() - coldStart;

  const warmStart = performance.now();
  const warm = await requestHighlight();
  const warmMs = performance.now() - warmStart;

  if (cold.addition.starts.length !== warm.addition.starts.length) {
    throw new Error("Worker cache returned a compact payload with different syntax runs.");
  }

  console.log(`METRIC cold_ms=${coldMs.toFixed(2)}`);
  console.log(`METRIC worker_cache_hit_ms=${warmMs.toFixed(2)}`);
  console.log(`METRIC compact_payload_bytes=${compactHighlightedDiffByteLength(cold)}`);
  console.log(`METRIC changed_lines=${lineCount}`);
} finally {
  disposeHighlightWorker();
}
