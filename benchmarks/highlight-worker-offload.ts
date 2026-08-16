/**
 * Measures moving Pierre's whole-file highlight into a Bun Worker, and checks that the compact
 * reply the worker sends still reproduces the spans Hunk renders today.
 *
 * Wall time is not the interesting number. What freezes a terminal UI is how long the main thread
 * is blocked, so a 1ms interval runs throughout and records the largest gap between its ticks; an
 * idle pass first establishes what that probe reads when nothing is happening.
 *
 * Two reply shapes are compared. Pierre's HAST is what `loadHighlightedDiff` consumes today and
 * arrives ready to use. The compact shape is smaller on the wire but has to be rebuilt into the
 * HAST the row builders read, so that rebuild is timed inside the measured region — it is main
 * thread work a real integration cannot avoid.
 *
 * Methodology notes, because earlier revisions of this file got these wrong:
 * - Each size is measured over several repetitions and reported as a median with a range, since a
 *   single sample of the worst stall varies by 3x run to run.
 * - The two reply shapes alternate which goes first, because whichever runs second inherits warmer
 *   JIT and allocator state.
 * - The equivalence check round trips through the real worker, not a local copy of the encoder.
 *
 * Background and conclusions: `docs/highlight-worker-offload.md`.
 */
import {
  getHighlighterOptions,
  getSharedHighlighter,
  parseDiffFromFile,
  renderDiffWithHighlighter,
  type FileDiffMetadata,
} from "@pierre/diffs";
import { buildDiffFile } from "../src/core/diffFile";
import { buildSplitRows, type HighlightedDiffCode } from "../src/ui/diff/diffRows";
import { THEMES } from "../src/ui/themes";
import {
  decodeColumnarCode,
  decodeColumnarWindow,
  decodeCompactCode,
  decodeCompactWindow,
  type ColumnarCode,
  type CompactCode,
} from "./lib/compactHighlight";

/**
 * Read a positive integer from the environment, matching the `HUNK_BENCH_*` naming the other
 * benchmarks use. A malformed value fails here with the offending input rather than turning into
 * NaN and quietly producing a run that measures nothing.
 */
function positiveIntFromEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }

  return value;
}

/** Parse the comma-separated file sizes to measure, rejecting malformed entries. */
function sizesFromEnv(name: string, fallback: number[]) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }

  return raw.split(",").map((entry) => {
    const value = Number(entry.trim());
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${name} entries must be positive integers, got ${JSON.stringify(entry)}`);
    }
    return value;
  });
}

const SIZES = sizesFromEnv("HUNK_BENCH_LINES", [2000, 8000, 30000]);
const REPEATS = positiveIntFromEnv("HUNK_BENCH_REPEATS", 5);
const TAB_WIDTH = 4;
// A terminal draws tens of rows whatever the file size, so this is what a windowed consumer needs
// rebuilt before the next paint.
const VIEWPORT_ROWS = positiveIntFromEnv("HUNK_BENCH_VIEWPORT_ROWS", 60);

const renderOptions = {
  theme: "pierre-dark" as const,
  useTokenTransformer: false,
  tokenizeMaxLineLength: 1_000,
  lineDiffType: "word-alt" as const,
  maxLineDiffLength: 10_000,
};

/**
 * "compact-lazy" rebuilds only a viewport of rows on arrival instead of the whole file.
 * "columnar-lazy" additionally arrives as transferred buffers rather than a cloned object graph.
 */
type ReplyFormat = "hast" | "compact" | "compact-lazy" | "columnar-lazy";

interface WorkerReply {
  id: number;
  code: { deletionLines: unknown[]; additionLines: unknown[]; palette?: string[] };
  timings: { highlighterMs: number; renderMs: number; encodeMs: number };
}

/** Generate TypeScript whose comments and template literals span lines. */
function makeSource(lines: number, seed = 0) {
  const out: string[] = [];
  let index = seed;
  while (out.length < lines) {
    out.push(`/** Handler ${index}`);
    out.push(` * continues across lines`);
    out.push(` */`);
    out.push(`export function handler${index}(input: { id: string; count: number }): string {`);
    out.push(`  const label = \`item-\${input.id}`);
    out.push(`    -\${input.count}\`;`);
    out.push(`  if (input.count > ${index % 97}) {`);
    out.push(`    return label.toUpperCase(); // note ${index}`);
    out.push(`  }`);
    out.push(`  return label;`);
    out.push(`}`);
    out.push("");
    index += 1;
  }
  return out.slice(0, lines).join("\n") + "\n";
}

/** Records the largest gap between 1ms interval ticks, i.e. the longest main-thread stall. */
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
    stop() {
      clearInterval(timer);
    },
    read() {
      return worst;
    },
  };
}

/** Median of a sample set, so one unlucky run cannot set the headline number. */
function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

/** Format a sample set as "median (min–max)" so spread stays visible. */
function summarize(values: number[]) {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return `${median(values).toFixed(0).padStart(4)}ms (${lo.toFixed(0)}–${hi.toFixed(0)})`;
}

const probe = createStallProbe();
await Bun.sleep(50);

probe.reset();
await Bun.sleep(400);
console.log(`idle probe floor: ${probe.read().toFixed(1)}ms`);
console.log(`repetitions per measurement: ${REPEATS}\n`);

const highlighterOptions = getHighlighterOptions("typescript", { theme: "pierre-dark" });
const highlighter = await getSharedHighlighter({
  ...highlighterOptions,
  preferredHighlighter: "shiki-wasm",
});

// ".js" resolves to the TypeScript worker from source and to the compiled entrypoint inside a
// `bun build --compile` binary, so one specifier covers both.
const worker = new Worker(new URL("./highlight-worker.js", import.meta.url).href);
let nextRequestId = 1;

/** Send one highlight request and resolve when the worker replies. */
function highlightInWorker(metadata: FileDiffMetadata, format: ReplyFormat) {
  const id = nextRequestId++;
  return new Promise<WorkerReply>((resolve, reject) => {
    const onMessage = (event: MessageEvent<WorkerReply>) => {
      if (event.data.id !== id) return;
      worker.removeEventListener("message", onMessage as EventListener);
      resolve(event.data);
    };
    worker.addEventListener("message", onMessage as EventListener);
    worker.addEventListener("error", reject, { once: true });
    // The worker only distinguishes the two encodings; how much of a compact reply the main
    // thread rebuilds is the caller's choice.
    const wireFormat =
      format === "hast" ? "hast" : format === "columnar-lazy" ? "columnar" : "compact";
    worker.postMessage({
      id,
      metadata,
      language: "typescript",
      theme: "pierre-dark",
      format: wireFormat,
    });
  });
}

/**
 * Time one worker round trip end to end, including rebuilding a compact reply into the HAST the
 * row builders consume. That rebuild is main-thread work a real integration pays per file, so
 * leaving it outside the timed region would understate the compact path.
 */
async function measureWorker(metadata: FileDiffMetadata, format: ReplyFormat) {
  await Bun.sleep(50);
  probe.reset();
  const started = performance.now();
  const reply = await highlightInWorker(metadata, format);
  const decoded =
    format === "compact"
      ? decodeCompactCode(reply.code as CompactCode)
      : format === "compact-lazy"
        ? decodeCompactWindow(reply.code as CompactCode, VIEWPORT_ROWS)
        : format === "columnar-lazy"
          ? decodeColumnarWindow(reply.code as unknown as ColumnarCode, VIEWPORT_ROWS)
          : (reply.code as { deletionLines: unknown[]; additionLines: unknown[] });
  const wall = performance.now() - started;
  await Bun.sleep(50);
  const stall = probe.read();
  // Durations measured inside the worker are comparable even though the two threads have different
  // time origins. Whatever the round trip costs beyond them is message overhead plus the rebuild.
  const overhead =
    wall - reply.timings.renderMs - reply.timings.highlighterMs - reply.timings.encodeMs;

  return {
    reply,
    decoded,
    wall,
    stall,
    overhead,
    bytes: JSON.stringify(reply.code).length,
  };
}

/** Time one whole-file highlight on the main thread, the way Hunk does it today. */
async function measureMainThread(metadata: FileDiffMetadata) {
  await Bun.sleep(50);
  probe.reset();
  const started = performance.now();
  renderDiffWithHighlighter(metadata, highlighter, renderOptions);
  const wall = performance.now() - started;
  await Bun.sleep(50);
  return { wall, stall: probe.read() };
}

const bootStart = performance.now();
await highlightInWorker(
  parseDiffFromFile(
    { name: "warm.ts", contents: "" },
    { name: "warm.ts", contents: makeSource(50) },
  ),
  "compact",
);
console.log(
  `worker boot + Shiki init (one-time): ${(performance.now() - bootStart).toFixed(0)}ms\n`,
);

for (const lines of SIZES) {
  const source = makeSource(lines);
  const metadata = parseDiffFromFile(
    { name: "big.ts", contents: "", cacheKey: `${lines}-old` },
    { name: "big.ts", contents: source, cacheKey: `${lines}-new` },
  );

  console.log(`=== ${lines} lines, ${(source.length / 1024).toFixed(0)}KiB added ===`);

  // Shiki resolves grammars lazily, so warm before timing or the first pass absorbs that cost.
  renderDiffWithHighlighter(metadata, highlighter, renderOptions);
  await measureWorker(metadata, "hast");
  await measureWorker(metadata, "compact");
  await measureWorker(metadata, "compact-lazy");
  await measureWorker(metadata, "columnar-lazy");

  const samples = {
    mainWall: [] as number[],
    mainStall: [] as number[],
    hastWall: [] as number[],
    hastStall: [] as number[],
    compactWall: [] as number[],
    compactStall: [] as number[],
    lazyWall: [] as number[],
    lazyStall: [] as number[],
    columnarWall: [] as number[],
    columnarStall: [] as number[],
  };
  let hastBytes = 0;
  let compactBytes = 0;
  let paletteSize = 0;

  for (let repeat = 0; repeat < REPEATS; repeat += 1) {
    const main = await measureMainThread(metadata);
    samples.mainWall.push(main.wall);
    samples.mainStall.push(main.stall);

    // Alternate which reply shape runs first: whichever goes second inherits warmer state.
    const order: ReplyFormat[] =
      repeat % 2 === 0
        ? ["hast", "compact", "compact-lazy", "columnar-lazy"]
        : ["columnar-lazy", "compact-lazy", "compact", "hast"];
    for (const format of order) {
      const measured = await measureWorker(metadata, format);
      if (format === "hast") {
        samples.hastWall.push(measured.wall);
        samples.hastStall.push(measured.stall);
        hastBytes = measured.bytes;
      } else if (format === "compact-lazy") {
        samples.lazyWall.push(measured.wall);
        samples.lazyStall.push(measured.stall);
      } else if (format === "columnar-lazy") {
        samples.columnarWall.push(measured.wall);
        samples.columnarStall.push(measured.stall);
      } else {
        samples.compactWall.push(measured.wall);
        samples.compactStall.push(measured.stall);
        compactBytes = measured.bytes;
        paletteSize = (measured.reply.code.palette ?? []).length;
      }
    }
  }

  const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)}MiB`;
  console.log(
    `  main thread     : wall ${summarize(samples.mainWall)}   worst stall ${summarize(samples.mainStall)}`,
  );
  console.log(
    `  worker (hast)   : wall ${summarize(samples.hastWall)}   worst stall ${summarize(samples.hastStall)}   payload ${mib(hastBytes)}`,
  );
  console.log(
    `  worker (compact): wall ${summarize(samples.compactWall)}   worst stall ${summarize(samples.compactStall)}   payload ${mib(compactBytes)}   palette ${paletteSize}`,
  );
  console.log(
    `  worker (lazy)   : wall ${summarize(samples.lazyWall)}   worst stall ${summarize(samples.lazyStall)}   rebuilds ${VIEWPORT_ROWS} rows on arrival`,
  );
  console.log(
    `  worker (columnar): wall ${summarize(samples.columnarWall)}  worst stall ${summarize(samples.columnarStall)}   transferred buffers, ${VIEWPORT_ROWS} rows on arrival`,
  );
  console.log("");
}

// Does the compact payload still produce exactly what Hunk renders? Round trip through the real
// worker — not a local copy of the encoder — and run the real row builder over both results.
const equivalenceCases = [
  { name: "rewrite", old: makeSource(3000, 0), next: makeSource(3000, 7) },
  { name: "new file", old: "", next: makeSource(3000, 0) },
];

/** Reduce rows to their rendered spans so only visible output is compared. */
function spansOf(rows: ReturnType<typeof buildSplitRows>) {
  return rows.map((row) =>
    row.type === "split-line"
      ? { left: row.left.spans, right: row.right.spans }
      : { other: row.type },
  );
}

/** Total spans compared, so a trivially empty comparison cannot read as a pass. */
function countSpans(rows: ReturnType<typeof spansOf>) {
  return rows.reduce(
    (total, row) =>
      "left" in row ? total + (row.left?.length ?? 0) + (row.right?.length ?? 0) : total,
    0,
  );
}

for (const testCase of equivalenceCases) {
  const metadata = parseDiffFromFile(
    { name: "sample.ts", contents: testCase.old, cacheKey: `${testCase.name}-old` },
    { name: "sample.ts", contents: testCase.next, cacheKey: `${testCase.name}-new` },
  );

  const hastReply = await highlightInWorker(metadata, "hast");
  const compactReply = await highlightInWorker(metadata, "compact");
  const columnarReply = await highlightInWorker(metadata, "columnar-lazy");

  const file = buildDiffFile(metadata, "", 0, "benchmark", null, {});
  const theme = THEMES[0]!;

  const fromHast = spansOf(
    buildSplitRows(file, hastReply.code as unknown as HighlightedDiffCode, theme, TAB_WIDTH),
  );
  const fromCompact = spansOf(
    buildSplitRows(
      file,
      decodeCompactCode(compactReply.code as CompactCode) as unknown as HighlightedDiffCode,
      theme,
      TAB_WIDTH,
    ),
  );

  const fromColumnar = spansOf(
    buildSplitRows(
      file,
      decodeColumnarCode(
        columnarReply.code as unknown as ColumnarCode,
      ) as unknown as HighlightedDiffCode,
      theme,
      TAB_WIDTH,
    ),
  );

  const reference = JSON.stringify(fromHast);
  const compactIdentical = reference === JSON.stringify(fromCompact);
  const columnarIdentical = reference === JSON.stringify(fromColumnar);
  console.log(
    `round trip through the worker, ${testCase.name.padEnd(8)}: ` +
      `${String(fromHast.length).padStart(5)} rows, ${String(countSpans(fromHast)).padStart(6)} spans, ` +
      `compact identical=${compactIdentical}, columnar identical=${columnarIdentical}`,
  );
}

worker.terminate();
probe.stop();
