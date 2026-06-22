// Track retained memory while repeatedly navigating a mounted Hunk review stream.
import { testRender } from "@opentui/react/test-utils";
import { performance } from "node:perf_hooks";
import React from "react";
import { act } from "react";
import { AppHost } from "../src/ui/AppHost";
import { createLargeSplitStreamBootstrap } from "./large-stream-fixture";

type MemorySample = {
  label: string;
  navigation: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
};

type CliOptions = {
  navigations: number;
  warmupNavigations: number;
  sampleEvery: number;
  fileCount: number;
  linesPerFile: number;
  width: number;
  height: number;
  gc: boolean;
  mode: "bounce" | "forward";
  maxHeapGrowthMb: number;
  maxHeapSlopeKb: number;
  maxRssGrowthMb: number;
  jsonOut?: string;
};

const defaultOptions: CliOptions = {
  navigations: 180,
  warmupNavigations: 60,
  sampleEvery: 10,
  fileCount: 90,
  linesPerFile: 120,
  width: 240,
  height: 28,
  gc: true,
  mode: "bounce",
  maxHeapGrowthMb: 192,
  maxHeapSlopeKb: 2048,
  maxRssGrowthMb: 384,
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

/** Parse a small flag set without pulling benchmark-only dependencies into the app. */
function parseArgs(argv: string[]): CliOptions {
  const options = { ...defaultOptions };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") {
      console.log(
        `Usage: bun run benchmarks/navigation-memory.ts [options]\n\nOptions:\n  --navigations <n>         Key-driven hunk navigations (default ${defaultOptions.navigations})\n  --warmup-navigations <n>  Navigations ignored for trend analysis (default ${defaultOptions.warmupNavigations})\n  --sample-every <n>        Sample every N navigations (default ${defaultOptions.sampleEvery})\n  --file-count <n>          One-hunk files in the synthetic review (default ${defaultOptions.fileCount})\n  --lines-per-file <n>      Lines per synthetic file (default ${defaultOptions.linesPerFile})\n  --width <n>               Test renderer width (default ${defaultOptions.width})\n  --height <n>              Test renderer height (default ${defaultOptions.height})\n  --mode <bounce|forward>   Bounce avoids end-of-review no-ops (default ${defaultOptions.mode})\n  --no-gc                   Do not force Bun.gc before samples\n  --max-heap-growth-mb <n>  Fail if post-warmup heap grows beyond this (default ${defaultOptions.maxHeapGrowthMb})\n  --max-heap-slope-kb <n>   Fail if post-warmup heap slope exceeds this per navigation (default ${defaultOptions.maxHeapSlopeKb})\n  --max-rss-growth-mb <n>   Fail if post-warmup RSS grows beyond this (default ${defaultOptions.maxRssGrowthMb})\n  --json-out <path>         Write full sample summary JSON\n`,
      );
      process.exit(0);
    }

    const next = () => argv[++index];
    switch (arg) {
      case "--navigations":
        options.navigations = parseNumberOption(arg, next());
        break;
      case "--warmup-navigations":
        options.warmupNavigations = parseNumberOption(arg, next());
        break;
      case "--sample-every":
        options.sampleEvery = parseNumberOption(arg, next());
        break;
      case "--file-count":
        options.fileCount = parseNumberOption(arg, next());
        break;
      case "--lines-per-file":
        options.linesPerFile = parseNumberOption(arg, next());
        break;
      case "--width":
        options.width = parseNumberOption(arg, next());
        break;
      case "--height":
        options.height = parseNumberOption(arg, next());
        break;
      case "--mode": {
        const mode = next();
        if (mode !== "bounce" && mode !== "forward") {
          throw new Error("Expected --mode to be either bounce or forward.");
        }
        options.mode = mode;
        break;
      }
      case "--no-gc":
        options.gc = false;
        break;
      case "--max-heap-growth-mb":
        options.maxHeapGrowthMb = parseNumberOption(arg, next());
        break;
      case "--max-heap-slope-kb":
        options.maxHeapSlopeKb = parseNumberOption(arg, next());
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

  options.navigations = Math.trunc(options.navigations);
  options.warmupNavigations = Math.trunc(
    Math.min(options.warmupNavigations, Math.max(0, options.navigations - 1)),
  );
  options.sampleEvery = Math.max(1, Math.trunc(options.sampleEvery));
  options.fileCount = Math.max(1, Math.trunc(options.fileCount));
  options.linesPerFile = Math.max(1, Math.trunc(options.linesPerFile));
  options.width = Math.max(40, Math.trunc(options.width));
  options.height = Math.max(10, Math.trunc(options.height));
  return options;
}

function maybeGc(enabled: boolean) {
  if (enabled) {
    Bun.gc(true);
  }
}

function sampleMemory(label: string, navigation: number, options: CliOptions): MemorySample {
  maybeGc(options.gc);
  const usage = process.memoryUsage();
  return {
    label,
    navigation,
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    heapTotalBytes: usage.heapTotal,
    externalBytes: usage.external,
    arrayBuffersBytes: usage.arrayBuffers,
  };
}

function formatBytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function linearSlope(samples: MemorySample[], field: "heapUsedBytes" | "rssBytes") {
  if (samples.length < 2) {
    return 0;
  }

  const meanX = samples.reduce((sum, sample) => sum + sample.navigation, 0) / samples.length;
  const meanY = samples.reduce((sum, sample) => sum + sample[field], 0) / samples.length;
  const numerator = samples.reduce(
    (sum, sample) => sum + (sample.navigation - meanX) * (sample[field] - meanY),
    0,
  );
  const denominator = samples.reduce((sum, sample) => sum + (sample.navigation - meanX) ** 2, 0);
  return denominator === 0 ? 0 : numerator / denominator;
}

/** Resolve the next keyboard action and logical position for one hunk-per-file navigation. */
function nextNavigationKey(
  position: number,
  direction: number,
  options: CliOptions,
): { key: "]" | "["; position: number; direction: number } {
  if (options.mode === "forward") {
    return { key: "]", position: Math.min(options.fileCount - 1, position + 1), direction: 1 };
  }

  let nextDirection = direction;
  if (position >= options.fileCount - 1) {
    nextDirection = -1;
  } else if (position <= 0) {
    nextDirection = 1;
  }

  return {
    key: nextDirection > 0 ? "]" : "[",
    position: Math.max(0, Math.min(options.fileCount - 1, position + nextDirection)),
    direction: nextDirection,
  };
}

async function renderOnce(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await setup.renderOnce();
    await Bun.sleep(0);
  });
}

async function pressNavigationKey(setup: Awaited<ReturnType<typeof testRender>>, key: "]" | "[") {
  await act(async () => {
    await setup.mockInput.typeText(key);
    await setup.renderOnce();
    await Bun.sleep(0);
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const samples: MemorySample[] = [];
  const startedAt = performance.now();
  const bootstrap = createLargeSplitStreamBootstrap({
    fileCount: options.fileCount,
    linesPerFile: options.linesPerFile,
  });
  console.log(
    `navigation memory fixture files=${options.fileCount} lines=${options.linesPerFile} ` +
      `navigations=${options.navigations} mode=${options.mode} gc=${options.gc ? "on" : "off"}`,
  );
  samples.push(sampleMemory("after_bootstrap", 0, options));

  const setup = await testRender(React.createElement(AppHost, { bootstrap }), {
    width: options.width,
    height: options.height,
  });

  try {
    await renderOnce(setup);
    samples.push(sampleMemory("after_first_frame", 0, options));
    console.log(
      `navigation=${(0).toString().padStart(4)} heap=${formatBytes(samples.at(-1)!.heapUsedBytes)} ` +
        `rss=${formatBytes(samples.at(-1)!.rssBytes)}`,
    );

    let position = 0;
    let direction = 1;
    for (let navigation = 1; navigation <= options.navigations; navigation += 1) {
      const next = nextNavigationKey(position, direction, options);
      position = next.position;
      direction = next.direction;
      await pressNavigationKey(setup, next.key);

      if (navigation % options.sampleEvery === 0 || navigation === options.navigations) {
        const nextSample = sampleMemory("navigation", navigation, options);
        samples.push(nextSample);
        console.log(
          `navigation=${navigation.toString().padStart(4)} heap=${formatBytes(nextSample.heapUsedBytes)} ` +
            `rss=${formatBytes(nextSample.rssBytes)} external=${formatBytes(nextSample.externalBytes)}`,
        );
      }
    }
  } finally {
    await act(async () => {
      setup.renderer.destroy();
      await Bun.sleep(0);
    });
    samples.push(sampleMemory("after_destroy", options.navigations, options));
  }

  const navigationSamples = samples.filter(
    (entry) => entry.label === "navigation" && entry.navigation >= options.warmupNavigations,
  );
  const first =
    navigationSamples[0] ?? samples.find((entry) => entry.label === "after_first_frame")!;
  const last = navigationSamples.at(-1) ?? samples.at(-1)!;
  const heapGrowthBytes = last.heapUsedBytes - first.heapUsedBytes;
  const rssGrowthBytes = last.rssBytes - first.rssBytes;
  const heapSlopeBytesPerNavigation = linearSlope(navigationSamples, "heapUsedBytes");
  const rssSlopeBytesPerNavigation = linearSlope(navigationSamples, "rssBytes");
  const maxHeapBytes = Math.max(...samples.map((entry) => entry.heapUsedBytes));
  const maxRssBytes = Math.max(...samples.map((entry) => entry.rssBytes));
  const elapsedMs = performance.now() - startedAt;
  const passed =
    heapGrowthBytes <= options.maxHeapGrowthMb * 1024 * 1024 &&
    heapSlopeBytesPerNavigation <= options.maxHeapSlopeKb * 1024 &&
    rssGrowthBytes <= options.maxRssGrowthMb * 1024 * 1024;

  const summary = {
    options,
    elapsedMs,
    sampleCount: samples.length,
    analyzedNavigationSamples: navigationSamples.length,
    firstAnalyzedHeapBytes: first.heapUsedBytes,
    lastAnalyzedHeapBytes: last.heapUsedBytes,
    heapGrowthBytes,
    rssGrowthBytes,
    heapSlopeBytesPerNavigation,
    rssSlopeBytesPerNavigation,
    maxHeapBytes,
    maxRssBytes,
    passed,
    samples,
  };

  console.log("\nNavigation memory summary");
  console.log(`  analyzed samples:       ${navigationSamples.length}`);
  console.log(`  first heap:             ${formatBytes(first.heapUsedBytes)}`);
  console.log(`  last heap:              ${formatBytes(last.heapUsedBytes)}`);
  console.log(`  heap growth:            ${formatBytes(heapGrowthBytes)}`);
  console.log(`  heap slope:             ${formatBytes(heapSlopeBytesPerNavigation)} / navigation`);
  console.log(`  RSS growth:             ${formatBytes(rssGrowthBytes)}`);
  console.log(`  RSS slope:              ${formatBytes(rssSlopeBytesPerNavigation)} / navigation`);
  console.log(`  max heap:               ${formatBytes(maxHeapBytes)}`);
  console.log(`  max RSS:                ${formatBytes(maxRssBytes)}`);
  console.log(`  elapsed:                ${(elapsedMs / 1000).toFixed(1)}s`);
  console.log(`METRIC navigation_heap_growth_bytes=${heapGrowthBytes}`);
  console.log(`METRIC navigation_heap_slope_bytes_per_navigation=${heapSlopeBytesPerNavigation}`);
  console.log(`METRIC navigation_rss_growth_bytes=${rssGrowthBytes}`);
  console.log(`METRIC navigation_rss_slope_bytes_per_navigation=${rssSlopeBytesPerNavigation}`);
  console.log(`METRIC navigation_max_heap_bytes=${maxHeapBytes}`);
  console.log(`METRIC navigation_max_rss_bytes=${maxRssBytes}`);

  if (options.jsonOut) {
    await Bun.write(options.jsonOut, JSON.stringify(summary, null, 2));
    console.log(`wrote ${options.jsonOut}`);
  }

  if (!passed) {
    console.error("Navigation memory growth exceeded configured threshold.");
    process.exit(1);
  }
}

await main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
