#!/usr/bin/env bun
import os from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { aggregateMetric, type BenchmarkRunResult } from "./lib/benchmark-result";

const defaultScripts = [
  "bootstrap-load.ts",
  "working-tree-load.ts",
  "changeset-parse.ts",
  "render-layout.ts",
  "highlight-prefetch.ts",
  "large-stream.ts",
  "interaction-latency.ts",
  "non-ascii-stream.ts",
];

interface RunOptions {
  samples: number;
  out?: string;
  includeCompetitors: boolean;
  includeHuge: boolean;
  scripts: string[];
}

function readArgValue(args: string[], index: number) {
  const value = args[index + 1];
  if (!value) {
    throw new Error(`Missing value for ${args[index]}`);
  }
  return value;
}

function parseArgs(args: string[]): RunOptions {
  const options: RunOptions = {
    samples: Number(process.env.HUNK_BENCHMARK_SAMPLES ?? 3),
    includeCompetitors: false,
    // Opt-in: a single huge-stream sample can take minutes on slow builds.
    includeHuge: process.env.HUNK_BENCH_INCLUDE_HUGE === "1",
    scripts: [],
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;

    if (arg === "--samples") {
      options.samples = Number(readArgValue(args, index));
      index += 1;
      continue;
    }

    if (arg === "--out") {
      options.out = readArgValue(args, index);
      index += 1;
      continue;
    }

    if (arg === "--include-competitors") {
      options.includeCompetitors = true;
      continue;
    }

    if (arg === "--include-huge") {
      options.includeHuge = true;
      continue;
    }

    if (arg === "--script") {
      options.scripts.push(readArgValue(args, index));
      index += 1;
      continue;
    }

    throw new Error(`Unknown benchmark runner argument: ${arg}`);
  }

  if (!Number.isFinite(options.samples) || options.samples < 1) {
    throw new Error("--samples must be a positive number");
  }

  return options;
}

function gitSha() {
  const proc = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  });

  if (proc.exitCode !== 0) {
    return undefined;
  }

  return Buffer.from(proc.stdout).toString("utf8").trim();
}

async function packageVersion() {
  try {
    const packageJson = JSON.parse(await Bun.file("package.json").text()) as { version?: string };
    return packageJson.version;
  } catch {
    return undefined;
  }
}

function parseMetrics(output: string) {
  const metrics = new Map<string, number>();
  const metricPattern = /^METRIC\s+([A-Za-z0-9_.:-]+)=(-?\d+(?:\.\d+)?)$/;

  for (const line of output.split(/\r?\n/)) {
    const match = metricPattern.exec(line.trim());
    if (!match) {
      continue;
    }

    metrics.set(match[1]!, Number(match[2]!));
  }

  return metrics;
}

async function runScript(script: string) {
  const proc = Bun.spawn(["bun", "run", `benchmarks/${script}`], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, CI: process.env.CI ?? "1" },
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (stderr.trim()) {
    console.warn(stderr.trim());
  }

  if (exitCode !== 0) {
    throw new Error(`${script} failed with exit code ${exitCode}\n${stderr}`);
  }

  process.stdout.write(stdout);
  return parseMetrics(stdout);
}

function formatValue(value: number) {
  if (Math.abs(value) >= 100) {
    return value.toFixed(1);
  }
  return value.toFixed(2);
}

const options = parseArgs(Bun.argv.slice(2));
const scripts = options.scripts.length > 0 ? options.scripts : [...defaultScripts];
if (options.includeHuge) {
  scripts.push("huge-stream.ts");
}
if (options.includeCompetitors) {
  scripts.push("competitors.ts");
}

const samplesByMetric = new Map<string, { source: string; metric: string; samples: number[] }>();

for (const script of scripts) {
  const source = script.replace(/\.ts$/, "");
  console.log(`\n## ${source}`);

  for (let sample = 1; sample <= options.samples; sample += 1) {
    console.log(`\n# sample ${sample}/${options.samples}`);
    const metrics = await runScript(script);

    for (const [metric, value] of metrics) {
      const key = `${source}/${metric}`;
      const entry = samplesByMetric.get(key) ?? { source, metric, samples: [] };
      entry.samples.push(value);
      samplesByMetric.set(key, entry);
    }
  }
}

const results = [...samplesByMetric.values()]
  .map(({ source, metric, samples }) => aggregateMetric(source, metric, samples))
  .sort((left, right) => left.name.localeCompare(right.name));

const runResult: BenchmarkRunResult = {
  version: 1,
  generatedAt: new Date().toISOString(),
  gitSha: gitSha(),
  packageVersion: await packageVersion(),
  runtime: {
    bunVersion: Bun.version,
    platform: os.platform(),
    arch: os.arch(),
  },
  samplesPerBenchmark: options.samples,
  results,
};

console.log("\n## Aggregated benchmark medians");
for (const result of results) {
  const suffix = result.unit === "ms" ? "ms" : result.unit === "bytes" ? " bytes" : "";
  console.log(
    `${result.name}: median=${formatValue(result.median)}${suffix} p95=${formatValue(result.p95)}${suffix}`,
  );
}

if (options.out) {
  const outPath = resolve(options.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(runResult, null, 2)}\n`);
  console.log(`\nWrote ${outPath}`);
}
