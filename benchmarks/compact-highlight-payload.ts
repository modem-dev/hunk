// Compare the worker's current raw-HAST response shape with the compact typed-array PoC.
// This models response handling only: Pierre still generates the same HAST before the worker
// normalizes it, and the terminal paint seam remains a later milestone.
import { performance } from "node:perf_hooks";
import { cleanLastNewline, parseDiffFromFile } from "@pierre/diffs";
import type { DiffFile } from "../src/core/types";
import { loadHighlightedDiff, type HighlightedDiffCode } from "../src/ui/diff/diffRows";
import {
  compactHighlightRunsForLine,
  compactHighlightTransferList,
  compactHighlightedDiffByteLength,
  encodeCompactHighlightedDiff,
  validateCompactHighlightedDiff,
} from "../src/ui/diff/highlightCompact";
import { resolveTheme } from "../src/ui/themes";

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

const file = createLargeDiffFile(LINE_COUNT);
const theme = resolveTheme("github-dark-default", null);
const lineLengths = compactLineLengths(file);

// Warm Shiki/Pierre before timing response handling.
const warmResult = await loadHighlightedDiff(file, theme);
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
