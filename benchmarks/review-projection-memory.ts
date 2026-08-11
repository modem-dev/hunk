import { heapStats } from "bun:jsc";
import { createReviewSessionRuntime } from "../src/app/reviewSessionRuntime";
import {
  createLargeSplitStreamBootstrap,
  DEFAULT_FILE_COUNT,
  DEFAULT_LINES_PER_FILE,
} from "./large-stream-fixture";

interface Options {
  fileCount: number;
  linesPerFile: number;
  gc: boolean;
}

/** Parse one positive integer benchmark option. */
function positiveInteger(name: string, value: string | undefined) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be positive.`);
  return parsed;
}

/** Parse projection-memory benchmark options without production CLI dependencies. */
function parseArgs(argv: string[]): Options {
  const options: Options = {
    fileCount: DEFAULT_FILE_COUNT,
    linesPerFile: DEFAULT_LINES_PER_FILE,
    gc: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--file-count") options.fileCount = positiveInteger(arg, argv[++index]);
    else if (arg === "--lines-per-file") options.linesPerFile = positiveInteger(arg, argv[++index]);
    else if (arg === "--no-gc") options.gc = false;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: bun run benchmarks/review-projection-memory.ts [--file-count N] [--lines-per-file N] [--no-gc]",
      );
      process.exit(0);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

/** Force collection before retained-memory samples when supported. */
function maybeGc(enabled: boolean) {
  if (enabled) Bun.gc(true);
}

/** Sample process and JavaScriptCore retained memory. */
function sample(enabled: boolean) {
  maybeGc(enabled);
  const heap = heapStats();
  return {
    rssBytes: process.memoryUsage.rss(),
    heapBytes: heap.heapSize,
    extraBytes: heap.extraMemorySize,
  };
}

/** Print metrics in the format consumed by the repository benchmark runner. */
function printSample(prefix: string, value: ReturnType<typeof sample>) {
  console.log(`METRIC ${prefix}_rss_bytes=${value.rssBytes}`);
  console.log(`METRIC ${prefix}_jsc_heap_size_bytes=${value.heapBytes}`);
  console.log(`METRIC ${prefix}_jsc_extra_memory_size_bytes=${value.extraBytes}`);
}

const options = parseArgs(process.argv.slice(2));
console.log(
  `review projection memory fixture files=${options.fileCount} lines=${options.linesPerFile} gc=${options.gc ? "on" : "off"}`,
);
const bootstrap = createLargeSplitStreamBootstrap(options);
const afterBootstrap = sample(options.gc);
printSample("after_bootstrap", afterBootstrap);

const projectionStart = performance.now();
const runtime = createReviewSessionRuntime(bootstrap);
const projectionMs = performance.now() - projectionStart;
const projection = runtime.getSnapshot().projection;
const canonicalDescriptors = projection.document.resources.filter(
  (resource) => resource.kind === "canonical-file",
);
const initialCanonicalMeasuredCount = canonicalDescriptors.filter(
  (resource) => resource.byteLength !== undefined || resource.digest !== undefined,
).length;
const initialCanonicalMaterializedCount = canonicalDescriptors.filter(
  (resource) => projection.resourceContents[resource.id] !== undefined,
).length;
if (initialCanonicalMeasuredCount !== 0 || initialCanonicalMaterializedCount !== 0) {
  throw new Error("Terminal startup eagerly prepared canonical browser resources.");
}
const afterProjection = sample(options.gc);
printSample("after_projection", afterProjection);

const firstStart = performance.now();
const firstEncoded = runtime.getResource(canonicalDescriptors[0]!.id)!;
const firstEncodeMs = performance.now() - firstStart;
const afterFirst = sample(options.gc);
printSample("after_first_lazy_encode", afterFirst);

let canonicalEncodedBytes = Buffer.byteLength(firstEncoded, "utf8");
const allStart = performance.now();
for (const descriptor of canonicalDescriptors.slice(1)) {
  canonicalEncodedBytes += Buffer.byteLength(runtime.getResource(descriptor.id)!, "utf8");
}
const allEncodeMs = performance.now() - allStart;
const afterAll = sample(options.gc);
printSample("after_all_lazy_encode", afterAll);

console.log(`METRIC projection_ms=${projectionMs.toFixed(2)}`);
console.log(`METRIC first_lazy_encode_ms=${firstEncodeMs.toFixed(2)}`);
console.log(`METRIC remaining_lazy_encode_ms=${allEncodeMs.toFixed(2)}`);
console.log(`METRIC canonical_encoded_bytes=${canonicalEncodedBytes}`);
console.log(
  `METRIC retained_encoded_cache_bytes=${runtime.getEncodedResourceCacheStats().totalBytes}`,
);
console.log(`METRIC initial_canonical_measured_count=${initialCanonicalMeasuredCount}`);
console.log(`METRIC initial_canonical_materialized_count=${initialCanonicalMaterializedCount}`);
console.log(
  `METRIC projection_rss_growth_bytes=${afterProjection.rssBytes - afterBootstrap.rssBytes}`,
);
console.log(
  `METRIC projection_jsc_heap_growth_bytes=${afterProjection.heapBytes - afterBootstrap.heapBytes}`,
);
console.log(
  `METRIC all_lazy_encode_jsc_heap_growth_bytes=${afterAll.heapBytes - afterProjection.heapBytes}`,
);

runtime.dispose();
