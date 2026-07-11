// Track retained memory for the all-files geometry cache used by review scrolling/navigation.
import { performance } from "node:perf_hooks";
import { measureDiffSectionGeometry } from "../src/ui/diff/diffSectionGeometry";
import { resolveTheme } from "../src/ui/themes";
import {
  createLargeSplitStreamBootstrap,
  DEFAULT_FILE_COUNT,
  DEFAULT_LINES_PER_FILE,
} from "./large-stream-fixture";

type MemorySample = {
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
};

type CliOptions = {
  fileCount: number;
  linesPerFile: number;
  width: number;
  gc: boolean;
};

const defaultOptions: CliOptions = {
  fileCount: DEFAULT_FILE_COUNT,
  linesPerFile: DEFAULT_LINES_PER_FILE,
  width: 240,
  gc: true,
};

function parseNumberOption(name: string, value: string | undefined) {
  if (value === undefined) {
    throw new Error(`Missing value for ${name}.`);
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Expected ${name} to be a non-negative number.`);
  }

  return parsed;
}

/** Parse benchmark-only flags without pulling a CLI dependency into local diagnostics. */
function parseArgs(argv: string[]): CliOptions {
  const options = { ...defaultOptions };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") {
      console.log(
        `Usage: bun run benchmarks/geometry-memory.ts [options]\n\nOptions:\n  --file-count <n>      Synthetic review files (default ${defaultOptions.fileCount})\n  --lines-per-file <n>  Source lines per synthetic file (default ${defaultOptions.linesPerFile})\n  --width <n>           Geometry measurement width (default ${defaultOptions.width})\n  --no-gc               Do not force Bun.gc before memory samples\n`,
      );
      process.exit(0);
    }

    const next = () => argv[++index];
    switch (arg) {
      case "--file-count":
        options.fileCount = parseNumberOption(arg, next());
        break;
      case "--lines-per-file":
        options.linesPerFile = parseNumberOption(arg, next());
        break;
      case "--width":
        options.width = parseNumberOption(arg, next());
        break;
      case "--no-gc":
        options.gc = false;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  options.fileCount = Math.max(1, Math.trunc(options.fileCount));
  options.linesPerFile = Math.max(1, Math.trunc(options.linesPerFile));
  options.width = Math.max(40, Math.trunc(options.width));
  return options;
}

function maybeGc(enabled: boolean) {
  if (enabled) {
    Bun.gc(true);
  }
}

function sampleMemory(options: CliOptions): MemorySample {
  maybeGc(options.gc);
  const usage = process.memoryUsage();
  return {
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    heapTotalBytes: usage.heapTotal,
    externalBytes: usage.external,
    arrayBuffersBytes: usage.arrayBuffers,
  };
}

function printMemory(prefix: string, sample: MemorySample) {
  console.log(`METRIC ${prefix}_rss_bytes=${sample.rssBytes}`);
  console.log(`METRIC ${prefix}_heap_used_bytes=${sample.heapUsedBytes}`);
  console.log(`METRIC ${prefix}_heap_total_bytes=${sample.heapTotalBytes}`);
  console.log(`METRIC ${prefix}_external_bytes=${sample.externalBytes}`);
  console.log(`METRIC ${prefix}_array_buffers_bytes=${sample.arrayBuffersBytes}`);
}

const options = parseArgs(process.argv.slice(2));
const theme = resolveTheme("midnight", null);
const bootstrapStart = performance.now();
const bootstrap = createLargeSplitStreamBootstrap({
  fileCount: options.fileCount,
  linesPerFile: options.linesPerFile,
});

console.log(
  `geometry memory fixture files=${options.fileCount} lines=${options.linesPerFile} ` +
    `width=${options.width} gc=${options.gc ? "on" : "off"}`,
);
console.log(`METRIC bootstrap_fixture_ms=${(performance.now() - bootstrapStart).toFixed(2)}`);

const afterBootstrap = sampleMemory(options);
printMemory("after_bootstrap", afterBootstrap);

let bodyRows = 0;
let rowBounds = 0;
let materializedPlannedRows = 0;
const geometryStart = performance.now();
const geometries = bootstrap.changeset.files.map((file) => {
  const geometry = measureDiffSectionGeometry(file, "split", true, theme, [], options.width);
  bodyRows += geometry.bodyHeight;
  rowBounds += geometry.rowBounds.length;
  return geometry;
});

const geometryMs = performance.now() - geometryStart;
const afterGeometry = sampleMemory(options);
printMemory("after_geometry", afterGeometry);

// Materialize the lazy planned-row streams as an upper-bound diagnostic for copy-selection style
// consumers. Normal review scrolling/navigation should not pay this retained-memory cost.
const materializeStart = performance.now();
for (const geometry of geometries) {
  materializedPlannedRows += geometry.plannedRows.length;
}
const materializeMs = performance.now() - materializeStart;
const afterMaterializedRows = sampleMemory(options);
printMemory("after_materialized_planned_rows", afterMaterializedRows);

console.log(`METRIC geometry_ms=${geometryMs.toFixed(2)}`);
console.log(`METRIC geometry_body_rows=${bodyRows}`);
console.log(`METRIC geometry_row_bounds=${rowBounds}`);
console.log(
  `METRIC geometry_heap_growth_bytes=${afterGeometry.heapUsedBytes - afterBootstrap.heapUsedBytes}`,
);
console.log(`METRIC geometry_rss_growth_bytes=${afterGeometry.rssBytes - afterBootstrap.rssBytes}`);
console.log(`METRIC materialize_planned_rows_ms=${materializeMs.toFixed(2)}`);
console.log(`METRIC materialized_planned_rows=${materializedPlannedRows}`);
console.log(
  `METRIC materialized_planned_rows_heap_growth_bytes=${
    afterMaterializedRows.heapUsedBytes - afterGeometry.heapUsedBytes
  }`,
);
console.log(
  `METRIC materialized_planned_rows_rss_growth_bytes=${
    afterMaterializedRows.rssBytes - afterGeometry.rssBytes
  }`,
);
console.log(`METRIC files=${options.fileCount}`);
console.log(`METRIC lines_per_file=${options.linesPerFile}`);
