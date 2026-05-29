#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type {
  BenchmarkComparisonResult,
  BenchmarkComparisonRow,
  BenchmarkMetricResult,
  BenchmarkRunResult,
} from "./lib/benchmark-result";

interface CompareOptions {
  base: string;
  head: string;
  out?: string;
  markdown?: string;
}

function readArgValue(args: string[], index: number) {
  const value = args[index + 1];
  if (!value) {
    throw new Error(`Missing value for ${args[index]}`);
  }
  return value;
}

function parseArgs(args: string[]): CompareOptions {
  const options: Partial<CompareOptions> = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;

    if (arg === "--base") {
      options.base = readArgValue(args, index);
      index += 1;
      continue;
    }

    if (arg === "--head") {
      options.head = readArgValue(args, index);
      index += 1;
      continue;
    }

    if (arg === "--out") {
      options.out = readArgValue(args, index);
      index += 1;
      continue;
    }

    if (arg === "--markdown") {
      options.markdown = readArgValue(args, index);
      index += 1;
      continue;
    }

    throw new Error(`Unknown benchmark compare argument: ${arg}`);
  }

  if (!options.base || !options.head) {
    throw new Error(
      "Usage: bun run benchmarks/compare.ts --base base.json --head head.json [--out compare.json] [--markdown summary.md]",
    );
  }

  return options as CompareOptions;
}

function readRun(path: string): BenchmarkRunResult {
  return JSON.parse(readFileSync(path, "utf8")) as BenchmarkRunResult;
}

function compareMetric(
  base: BenchmarkMetricResult | undefined,
  head: BenchmarkMetricResult | undefined,
) {
  if (!base && !head) {
    throw new Error("Cannot compare two missing metrics");
  }

  const metric = head ?? base!;
  const baseMedian = base?.median ?? 0;
  const headMedian = head?.median ?? 0;
  const absoluteDelta = headMedian - baseMedian;
  const relativeDelta = baseMedian === 0 ? 0 : absoluteDelta / baseMedian;

  let status: BenchmarkComparisonRow["status"] = "pass";
  if (!base) {
    status = "missing-base";
  } else if (!head) {
    status = "missing-head";
  } else if (!metric.comparable || metric.informational || metric.name.includes("competitor_")) {
    status = "informational";
  } else if (
    metric.threshold &&
    headMedian > baseMedian * metric.threshold.maxRegressionRatio &&
    absoluteDelta > metric.threshold.minAbsoluteRegression
  ) {
    status = "fail";
  }

  return {
    name: metric.name,
    unit: metric.unit,
    baseMedian,
    headMedian,
    absoluteDelta,
    relativeDelta,
    threshold: metric.threshold,
    status,
    source: metric.source,
  } satisfies BenchmarkComparisonRow;
}

function formatNumber(value: number, unit: BenchmarkComparisonRow["unit"]) {
  if (unit === "bytes") {
    const mib = value / (1024 * 1024);
    return `${mib.toFixed(1)} MiB`;
  }

  if (unit === "ms") {
    return `${value.toFixed(value >= 100 ? 1 : 2)} ms`;
  }

  if (unit === "boolean") {
    return value ? "yes" : "no";
  }

  return value.toFixed(Number.isInteger(value) ? 0 : 2);
}

function formatDelta(row: BenchmarkComparisonRow) {
  const sign = row.absoluteDelta >= 0 ? "+" : "";
  const relative = row.baseMedian === 0 ? "n/a" : `${sign}${(row.relativeDelta * 100).toFixed(1)}%`;
  return `${sign}${formatNumber(row.absoluteDelta, row.unit)} (${relative})`;
}

function formatThreshold(row: BenchmarkComparisonRow) {
  if (!row.threshold) {
    return "—";
  }

  return `+${((row.threshold.maxRegressionRatio - 1) * 100).toFixed(0)}% and +${formatNumber(row.threshold.minAbsoluteRegression, row.unit)}`;
}

function statusIcon(status: BenchmarkComparisonRow["status"]) {
  switch (status) {
    case "pass":
      return "✅";
    case "fail":
      return "❌";
    case "informational":
      return "ℹ️";
    case "missing-base":
    case "missing-head":
      return "⚠️";
  }
}

const keyBenchmarkNames = new Set([
  "bootstrap-load/git_bootstrap_ms",
  "bootstrap-load/file_pair_bootstrap_ms",
  "working-tree-load/small_worktree_load_ms",
  "working-tree-load/medium_worktree_load_ms",
  "working-tree-load/large_worktree_load_ms",
  "working-tree-load/untracked_many_small_load_ms",
  "working-tree-load/untracked_few_large_load_ms",
  "changeset-parse/many_small_files_parse_patch_ms",
  "changeset-parse/balanced_changeset_parse_patch_ms",
  "changeset-parse/large_single_file_parse_patch_ms",
  "render-layout/many_small_files_review_plan_ms",
  "render-layout/balanced_stream_review_plan_ms",
  "render-layout/large_single_file_review_plan_ms",
  "large-stream/cold_first_frame_ms",
  "large-stream/warm_first_frame_ms",
  "large-stream/windowed_scroll_ticks_ms",
  "large-stream-profile/section_geometry_ms",
  "large-stream-profile/review_plan_ms",
  "highlight-prefetch/selected_startup_ms",
  "highlight-prefetch/next_file_ready_ms",
  "memory/first_frame_ms",
  "memory/next_hunk_navigation_ms",
  "memory/after_first_frame_rss_bytes",
  "memory/after_navigation_rss_bytes",
]);

/** Keep PR comments readable while all metrics remain enforced and available as artifacts. */
function selectDisplayedComparableRows(rows: BenchmarkComparisonRow[]) {
  const displayed = new Map<string, BenchmarkComparisonRow>();

  for (const row of rows) {
    if (row.status === "fail" || row.status === "missing-head" || keyBenchmarkNames.has(row.name)) {
      displayed.set(row.name, row);
    }
  }

  return [...displayed.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function competitorTimingRows(rows: BenchmarkComparisonRow[]) {
  return rows.filter(
    (row) =>
      row.status === "informational" &&
      row.name.includes("/competitor_") &&
      row.name.endsWith("_ms"),
  );
}

function buildMarkdown(comparison: BenchmarkComparisonResult) {
  const comparableRows = comparison.rows.filter((row) => row.status !== "informational");
  const displayedComparableRows = selectDisplayedComparableRows(comparableRows);
  const hiddenComparableCount = comparableRows.length - displayedComparableRows.length;
  const displayedCompetitorRows = competitorTimingRows(comparison.rows);
  const lines = [
    "<!-- hunk-benchmark-comment -->",
    "## Hunk benchmark results",
    "",
    comparison.failed
      ? "❌ One or more benchmarks regressed beyond the configured threshold."
      : "✅ Benchmarks are within the configured thresholds.",
    "",
    `Base: \`${comparison.baseSha?.slice(0, 12) ?? "unknown"}\` · Head: \`${comparison.headSha?.slice(0, 12) ?? "unknown"}\``,
    "",
    "### Key Hunk benchmarks",
    "",
    "| Benchmark | Base median | PR median | Delta | Threshold | Status |",
    "|---|---:|---:|---:|---:|:---:|",
  ];

  for (const row of displayedComparableRows) {
    lines.push(
      `| ${row.name} | ${formatNumber(row.baseMedian, row.unit)} | ${formatNumber(row.headMedian, row.unit)} | ${formatDelta(row)} | ${formatThreshold(row)} | ${statusIcon(row.status)} |`,
    );
  }

  if (hiddenComparableCount > 0) {
    lines.push(
      "",
      `${hiddenComparableCount} additional comparable Hunk metrics were checked but hidden to keep this comment readable. See the workflow artifacts for full JSON and text output.`,
    );
  }

  if (displayedCompetitorRows.length > 0) {
    lines.push("", "### Informational competitor comparison", "");
    lines.push("| Benchmark | Base median | PR median | Delta | Status |");
    lines.push("|---|---:|---:|---:|:---:|");
    for (const row of displayedCompetitorRows) {
      lines.push(
        `| ${row.name} | ${formatNumber(row.baseMedian, row.unit)} | ${formatNumber(row.headMedian, row.unit)} | ${formatDelta(row)} | ${statusIcon(row.status)} |`,
      );
    }
  }

  lines.push("", "Raw JSON and text logs are available in the benchmark workflow artifacts.", "");
  return lines.join("\n");
}

const options = parseArgs(Bun.argv.slice(2));
const base = readRun(options.base);
const head = readRun(options.head);
const baseByName = new Map(base.results.map((result) => [result.name, result]));
const headByName = new Map(head.results.map((result) => [result.name, result]));
const names = new Set([...baseByName.keys(), ...headByName.keys()]);
const rows = [...names]
  .map((name) => compareMetric(baseByName.get(name), headByName.get(name)))
  .sort((left, right) => left.name.localeCompare(right.name));

const comparison: BenchmarkComparisonResult = {
  version: 1,
  generatedAt: new Date().toISOString(),
  baseSha: base.gitSha,
  headSha: head.gitSha,
  failed: rows.some((row) => row.status === "fail" || row.status === "missing-head"),
  rows,
};
const markdown = buildMarkdown(comparison);

console.log(markdown);

if (options.out) {
  const outPath = resolve(options.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(comparison, null, 2)}\n`);
}

if (options.markdown) {
  const markdownPath = resolve(options.markdown);
  mkdirSync(dirname(markdownPath), { recursive: true });
  writeFileSync(markdownPath, markdown);
}

if (comparison.failed) {
  process.exitCode = 1;
}
