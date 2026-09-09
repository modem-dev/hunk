// Compare the worker's current raw-HAST response shape with the compact typed-array PoC.
// This models response handling only: Pierre still generates the same HAST before the worker
// normalizes it, and the terminal paint seam remains a later milestone.
import { performance } from "node:perf_hooks";
import { cleanLastNewline, parseDiffFromFile } from "@pierre/diffs";
import type { DiffFile } from "../packages/hunk/src/core/changeset/model";
import {
  buildSplitRows,
  loadHighlightedDiff,
  type HighlightedDiffCode,
} from "../packages/hunk/src/ui/diff/diffRows";
import {
  compactHighlightRunsForLine,
  compactHighlightTransferList,
  compactHighlightedDiffByteLength,
  encodeCompactHighlightedDiff,
  validateCompactHighlightedDiff,
} from "../packages/hunk/src/ui/diff/worker";
import { resolveTheme } from "../packages/hunk/src/ui/themes";

const LINE_COUNT = Number(process.env.HUNK_COMPACT_HIGHLIGHT_LINES ?? 8_000);
const SAMPLES = Number(process.env.HUNK_COMPACT_HIGHLIGHT_SAMPLES ?? 7);

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function percentile(values: number[], percentileValue: number) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)]!;
}

function metric(name: string, value: number) {
  console.log(`METRIC ${name}=${value.toFixed(2)}`);
}

/** Measure the largest interval delay while an operation runs on the terminal event loop. */
function createStallProbe() {
  let last = performance.now();
  let worst = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
  }, 1);

  return {
    reset() {
      last = performance.now();
      worst = 0;
    },
    read() {
      return worst;
    },
    stop() {
      clearInterval(timer);
    },
  };
}

/** Build one added TypeScript file within Hunk's current 10k-line highlighting ceiling. */
function createLargeDiffFile(lines: number): DiffFile {
  const contents =
    Array.from(
      { length: lines },
      (_, index) => `export const item${index} = { id: ${index}, label: \`item-${index}\` };`,
    ).join("\n") + "\n";
  const metadata = parseDiffFromFile(
    { name: "compact.ts", contents: "", cacheKey: "compact-before" },
    { name: "compact.ts", contents, cacheKey: "compact-after" },
    { context: 3 },
    true,
  );

  return {
    id: "compact-benchmark",
    path: "compact.ts",
    patch: "",
    language: "typescript",
    stats: { additions: lines, deletions: 0 },
    metadata,
    agent: null,
  };
}

/** Return the JSON byte size as a stable, inspectable proxy for raw HAST response volume. */
function jsonByteLength(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/** Return the raw source lengths used to validate compact UTF-16 ranges. */
function compactLineLengths(file: DiffFile) {
  return {
    deletion: file.metadata.deletionLines.map((line) => cleanLastNewline(line).length),
    addition: file.metadata.additionLines.map((line) => cleanLastNewline(line).length),
  };
}

/** Decode every compact line to model the work a future paint resolver will perform. */
function decodeAllCompactLines(payload: ReturnType<typeof encodeCompactHighlightedDiff>) {
  for (const side of ["deletion", "addition"] as const) {
    const lineCount = payload[side].lineOffsets.length - 1;
    for (let lineIndex = 0; lineIndex < lineCount; lineIndex += 1) {
      compactHighlightRunsForLine(payload, side, lineIndex);
    }
  }
}

/** Measure the production load plus first split-row materialization for one worker mode. */
async function measureHighlightOperation({
  file,
  theme,
  offloadLargeDiff,
}: {
  file: DiffFile;
  theme: ReturnType<typeof resolveTheme>;
  offloadLargeDiff: boolean;
}) {
  const wall: number[] = [];
  const stalls: number[] = [];
  const probe = createStallProbe();

  try {
    for (let sample = 0; sample < SAMPLES; sample += 1) {
      await Bun.sleep(40);
      probe.reset();
      const started = performance.now();
      const highlighted = await loadHighlightedDiff(
        file,
        theme,
        offloadLargeDiff ? { offloadLargeDiff: true } : undefined,
      );
      buildSplitRows(file, highlighted, theme);
      wall.push(performance.now() - started);
      // Let the interval observe work that ended just before this await.
      await Bun.sleep(25);
      stalls.push(probe.read());
    }
  } finally {
    probe.stop();
  }

  return {
    wallMedian: median(wall),
    wallP95: percentile(wall, 0.95),
    stallMedian: median(stalls),
    stallP95: percentile(stalls, 0.95),
  };
}

const file = createLargeDiffFile(LINE_COUNT);
const theme = resolveTheme("github-dark-default", null);
const lineLengths = compactLineLengths(file);

// Warm Shiki/Pierre and the reusable worker before timing response handling or operations.
const warmResult = await loadHighlightedDiff(file, theme);
await loadHighlightedDiff(file, theme, { offloadLargeDiff: true });
const rawHastBytes = jsonByteLength(warmResult);
const rawCloneMs: number[] = [];
const compactEncodeMs: number[] = [];
const compactTransferMs: number[] = [];
const compactDecodeMs: number[] = [];
const compactBytes: number[] = [];

for (let sample = 0; sample < SAMPLES; sample += 1) {
  const highlighted: HighlightedDiffCode =
    sample === 0 ? warmResult : await loadHighlightedDiff(file, theme);

  let started = performance.now();
  structuredClone(highlighted);
  rawCloneMs.push(performance.now() - started);

  started = performance.now();
  const compact = encodeCompactHighlightedDiff(highlighted, theme.appearance);
  compactEncodeMs.push(performance.now() - started);
  compactBytes.push(compactHighlightedDiffByteLength(compact));

  started = performance.now();
  const received = structuredClone(compact, { transfer: compactHighlightTransferList(compact) });
  compactTransferMs.push(performance.now() - started);

  validateCompactHighlightedDiff(received, lineLengths);
  started = performance.now();
  decodeAllCompactLines(received);
  compactDecodeMs.push(performance.now() - started);
}

metric("lines", LINE_COUNT);
metric("samples", SAMPLES);
metric("raw_hast_json_bytes", rawHastBytes);
metric("raw_hast_clone_ms_median", median(rawCloneMs));
metric("raw_hast_clone_ms_p95", percentile(rawCloneMs, 0.95));
metric("compact_payload_bytes_median", median(compactBytes));
metric("compact_encode_ms_median", median(compactEncodeMs));
metric("compact_encode_ms_p95", percentile(compactEncodeMs, 0.95));
metric("compact_transfer_ms_median", median(compactTransferMs));
metric("compact_transfer_ms_p95", percentile(compactTransferMs, 0.95));
metric("compact_decode_all_ms_median", median(compactDecodeMs));
metric("compact_decode_all_ms_p95", percentile(compactDecodeMs, 0.95));
metric("compact_response_byte_ratio", median(compactBytes) / rawHastBytes);

const inlineOperation = await measureHighlightOperation({ file, theme, offloadLargeDiff: false });
const compactWorkerOperation = await measureHighlightOperation({
  file,
  theme,
  offloadLargeDiff: true,
});
metric("inline_operation_wall_ms_median", inlineOperation.wallMedian);
metric("inline_operation_wall_ms_p95", inlineOperation.wallP95);
metric("inline_operation_stall_ms_median", inlineOperation.stallMedian);
metric("inline_operation_stall_ms_p95", inlineOperation.stallP95);
metric("compact_worker_operation_wall_ms_median", compactWorkerOperation.wallMedian);
metric("compact_worker_operation_wall_ms_p95", compactWorkerOperation.wallP95);
metric("compact_worker_operation_stall_ms_median", compactWorkerOperation.stallMedian);
metric("compact_worker_operation_stall_ms_p95", compactWorkerOperation.stallP95);
