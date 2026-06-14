// Track retained memory while repeatedly resizing a mounted Hunk review stream.
import { testRender } from "@opentui/solid";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createComponent } from "solid-js";
import { AppHost } from "../src/ui/AppHost";
import { createLargeSplitStreamBootstrap } from "./large-stream-fixture";

type MemorySample = {
  label: string;
  step: number;
  width: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
};

type CliOptions = {
  fileCount: number;
  linesPerFile: number;
  height: number;
  widths: number[];
  cycles: number;
  gc: boolean;
  maxHeapGrowthMb: number;
  maxRssGrowthMb: number;
  jsonOut?: string;
};

const defaultOptions: CliOptions = {
  fileCount: 180,
  linesPerFile: 120,
  height: 28,
  widths: [160, 200, 240, 280, 220, 180],
  cycles: 2,
  gc: true,
  maxHeapGrowthMb: 384,
  maxRssGrowthMb: 1024,
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

function parseWidths(value: string | undefined) {
  if (!value) {
    throw new Error("Missing value for --widths.");
  }

  const widths = value.split(",").map((part) => {
    const width = Number(part.trim());
    if (!Number.isFinite(width) || width < 40) {
      throw new Error("Expected --widths to be comma-separated terminal widths >= 40.");
    }
    return Math.trunc(width);
  });

  if (widths.length === 0) {
    throw new Error("Expected --widths to include at least one width.");
  }

  return widths;
}

/** Parse a small flag set without pulling benchmark-only dependencies into the app. */
function parseArgs(argv: string[]): CliOptions {
  const options = { ...defaultOptions, widths: [...defaultOptions.widths] };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") {
      console.log(
        `Usage: bun run benchmarks/resize-memory.ts [options]\n\nOptions:\n  --file-count <n>          One-hunk files in the synthetic review (default ${defaultOptions.fileCount})\n  --lines-per-file <n>      Lines per synthetic file (default ${defaultOptions.linesPerFile})\n  --height <n>              Test renderer height (default ${defaultOptions.height})\n  --widths <csv>            Comma-separated resize widths (default ${defaultOptions.widths.join(",")})\n  --cycles <n>              Number of times to repeat the width sequence (default ${defaultOptions.cycles})\n  --no-gc                   Do not force Bun.gc before samples\n  --max-heap-growth-mb <n>  Fail if retained heap grows beyond this (default ${defaultOptions.maxHeapGrowthMb})\n  --max-rss-growth-mb <n>   Fail if RSS grows beyond this (default ${defaultOptions.maxRssGrowthMb})\n  --json-out <path>         Write full sample summary JSON\n`,
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
      case "--height":
        options.height = parseNumberOption(arg, next());
        break;
      case "--widths":
        options.widths = parseWidths(next());
        break;
      case "--cycles":
        options.cycles = parseNumberOption(arg, next());
        break;
      case "--no-gc":
        options.gc = false;
        break;
      case "--max-heap-growth-mb":
        options.maxHeapGrowthMb = parseNumberOption(arg, next());
        break;
      case "--max-rss-growth-mb":
        options.maxRssGrowthMb = parseNumberOption(arg, next());
        break;
      case "--json-out":
        options.jsonOut = next();
        if (!options.jsonOut) {
          throw new Error("Missing value for --json-out.");
        }
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  options.fileCount = Math.max(1, Math.trunc(options.fileCount));
  options.linesPerFile = Math.max(1, Math.trunc(options.linesPerFile));
  options.height = Math.max(10, Math.trunc(options.height));
  options.cycles = Math.max(1, Math.trunc(options.cycles));
  return options;
}

function maybeGc(enabled: boolean) {
  if (enabled) {
    Bun.gc(true);
  }
}

function sampleMemory(label: string, step: number, width: number, options: CliOptions) {
  maybeGc(options.gc);
  const usage = process.memoryUsage();
  return {
    label,
    step,
    width,
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    heapTotalBytes: usage.heapTotal,
    externalBytes: usage.external,
    arrayBuffersBytes: usage.arrayBuffers,
  } satisfies MemorySample;
}

function formatBytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function percentile(values: number[], p: number) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index]!;
}

async function renderOnce(setup: Awaited<ReturnType<typeof testRender>>) {
  await setup.renderOnce();
  await Bun.sleep(0);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const samples: MemorySample[] = [];
  const resizeDurationsMs: number[] = [];
  const startedAt = performance.now();
  const bootstrap = createLargeSplitStreamBootstrap({
    fileCount: options.fileCount,
    linesPerFile: options.linesPerFile,
  });
  const firstWidth = options.widths[0]!;

  console.log(
    `resize memory fixture files=${options.fileCount} lines=${options.linesPerFile} ` +
      `widths=${options.widths.join(",")} cycles=${options.cycles} gc=${options.gc ? "on" : "off"}`,
  );
  samples.push(sampleMemory("after_bootstrap", 0, firstWidth, options));

  const setup = await testRender(() => createComponent(AppHost, { bootstrap }), {
    width: firstWidth,
    height: options.height,
  });

  try {
    await renderOnce(setup);
    samples.push(sampleMemory("after_first_frame", 0, firstWidth, options));
    console.log(
      `resize=${(0).toString().padStart(3)} width=${firstWidth} ` +
        `heap=${formatBytes(samples.at(-1)!.heapUsedBytes)} rss=${formatBytes(samples.at(-1)!.rssBytes)}`,
    );

    let step = 0;
    for (let cycle = 0; cycle < options.cycles; cycle += 1) {
      for (const width of options.widths) {
        step += 1;
        const resizeStart = performance.now();
        setup.resize(width, options.height);
        await renderOnce(setup);
        await renderOnce(setup);
        resizeDurationsMs.push(performance.now() - resizeStart);

        const nextSample = sampleMemory("resize", step, width, options);
        samples.push(nextSample);
        console.log(
          `resize=${step.toString().padStart(3)} width=${width} ` +
            `heap=${formatBytes(nextSample.heapUsedBytes)} rss=${formatBytes(nextSample.rssBytes)} ` +
            `external=${formatBytes(nextSample.externalBytes)}`,
        );
      }
    }
  } finally {
    setup.renderer.destroy();
  }

  const baseline = samples.find((sample) => sample.label === "after_first_frame") ?? samples[0]!;
  const resizeSamples = samples.filter((sample) => sample.label === "resize");
  const peakHeap = Math.max(
    ...resizeSamples.map((sample) => sample.heapUsedBytes),
    baseline.heapUsedBytes,
  );
  const peakRss = Math.max(...resizeSamples.map((sample) => sample.rssBytes), baseline.rssBytes);
  const finalSample = samples.at(-1)!;
  const heapGrowthBytes = finalSample.heapUsedBytes - baseline.heapUsedBytes;
  const rssGrowthBytes = finalSample.rssBytes - baseline.rssBytes;
  const peakHeapGrowthBytes = peakHeap - baseline.heapUsedBytes;
  const peakRssGrowthBytes = peakRss - baseline.rssBytes;
  const resizeTotalMs = resizeDurationsMs.reduce((sum, value) => sum + value, 0);
  const resizeP95Ms = percentile(resizeDurationsMs, 95);
  const elapsedMs = performance.now() - startedAt;

  console.log(`METRIC files=${options.fileCount}`);
  console.log(`METRIC lines_per_file=${options.linesPerFile}`);
  console.log(`METRIC resize_count=${resizeDurationsMs.length}`);
  console.log(`METRIC resize_total_ms=${resizeTotalMs.toFixed(2)}`);
  console.log(`METRIC resize_p95_ms=${resizeP95Ms.toFixed(2)}`);
  console.log(`METRIC baseline_heap_used_bytes=${baseline.heapUsedBytes}`);
  console.log(`METRIC final_heap_used_bytes=${finalSample.heapUsedBytes}`);
  console.log(`METRIC peak_heap_used_bytes=${peakHeap}`);
  console.log(`METRIC heap_growth_bytes=${heapGrowthBytes}`);
  console.log(`METRIC peak_heap_growth_bytes=${peakHeapGrowthBytes}`);
  console.log(`METRIC baseline_rss_bytes=${baseline.rssBytes}`);
  console.log(`METRIC final_rss_bytes=${finalSample.rssBytes}`);
  console.log(`METRIC peak_rss_bytes=${peakRss}`);
  console.log(`METRIC rss_growth_bytes=${rssGrowthBytes}`);
  console.log(`METRIC peak_rss_growth_bytes=${peakRssGrowthBytes}`);
  console.log(`METRIC elapsed_ms=${elapsedMs.toFixed(2)}`);

  const maxHeapGrowthBytes = options.maxHeapGrowthMb * 1024 * 1024;
  const maxRssGrowthBytes = options.maxRssGrowthMb * 1024 * 1024;
  const failures: string[] = [];
  if (peakHeapGrowthBytes > maxHeapGrowthBytes) {
    failures.push(
      `peak heap growth ${formatBytes(peakHeapGrowthBytes)} exceeded ${options.maxHeapGrowthMb} MiB`,
    );
  }
  if (peakRssGrowthBytes > maxRssGrowthBytes) {
    failures.push(
      `peak RSS growth ${formatBytes(peakRssGrowthBytes)} exceeded ${options.maxRssGrowthMb} MiB`,
    );
  }

  if (options.jsonOut) {
    const outPath = resolve(options.jsonOut);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(
      outPath,
      `${JSON.stringify(
        {
          options,
          metrics: {
            elapsedMs,
            resizeTotalMs,
            resizeP95Ms,
            heapGrowthBytes,
            peakHeapGrowthBytes,
            rssGrowthBytes,
            peakRssGrowthBytes,
          },
          samples,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`Wrote ${outPath}`);
  }

  if (failures.length > 0) {
    throw new Error(`resize memory budget failed: ${failures.join("; ")}`);
  }
}

await main();
