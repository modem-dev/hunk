#!/usr/bin/env bun

import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  BenchmarkComparisonResult,
  BenchmarkComparisonRow,
  BenchmarkMetricResult,
  BenchmarkRunResult,
  BenchmarkThreshold,
} from "../benchmarks/lib/benchmark-result";

interface ParsedVersion {
  raw: string;
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

interface CompareOptions {
  releaseDir: string;
  version: string;
  head?: string;
  base?: string;
  out?: string;
  summary?: string;
}

const BENCHMARK_FILE_PATTERN = /^bench-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.json$/;
const repoRoot = path.resolve(import.meta.dir, "..");

/** Resolve the directory that stores committed release benchmark snapshots. */
export function releaseBenchmarkDir(root = repoRoot) {
  return path.join(root, "benchmarks", "release");
}

/** Parse the package version used by release benchmark filenames. */
export async function readPackageVersion(root = repoRoot) {
  const packageJson = JSON.parse(await Bun.file(path.join(root, "package.json")).text()) as {
    version: string;
  };
  return packageJson.version;
}

/** Parse the semver subset used by Hunk release tags and benchmark files. */
export function parseReleaseVersion(version: string): ParsedVersion {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (!match) {
    throw new Error(`Invalid release benchmark version: ${version}`);
  }

  return {
    raw: version,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
  };
}

/** Compare two release versions with stable releases ordered after their prereleases. */
export function compareReleaseVersions(left: string, right: string) {
  const parsedLeft = parseReleaseVersion(left);
  const parsedRight = parseReleaseVersion(right);

  for (const key of ["major", "minor", "patch"] as const) {
    const delta = parsedLeft[key] - parsedRight[key];
    if (delta !== 0) {
      return delta;
    }
  }

  if (!parsedLeft.prerelease && !parsedRight.prerelease) {
    return 0;
  }

  if (!parsedLeft.prerelease) {
    return 1;
  }

  if (!parsedRight.prerelease) {
    return -1;
  }

  return parsedLeft.prerelease.localeCompare(parsedRight.prerelease, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

/** Return the committed benchmark path for one package version. */
export function releaseBenchmarkPath(version: string, directory = releaseBenchmarkDir()) {
  parseReleaseVersion(version);
  return path.join(directory, `bench-${version}.json`);
}

/** Find the latest stable benchmark snapshot lower than the release candidate version. */
export function findPreviousReleaseBenchmark(version: string, directory = releaseBenchmarkDir()) {
  const current = parseReleaseVersion(version);
  if (!existsSync(directory)) {
    return undefined;
  }

  const candidates = readdirSync(directory)
    .map((fileName) => {
      const match = BENCHMARK_FILE_PATTERN.exec(fileName);
      if (!match) {
        return undefined;
      }

      const candidateVersion = parseReleaseVersion(match[1]!);
      if (candidateVersion.prerelease) {
        return undefined;
      }

      if (compareReleaseVersions(candidateVersion.raw, current.raw) >= 0) {
        return undefined;
      }

      return {
        version: candidateVersion.raw,
        path: path.join(directory, fileName),
      };
    })
    .filter((candidate): candidate is { version: string; path: string } => Boolean(candidate))
    .sort((left, right) => compareReleaseVersions(right.version, left.version));

  return candidates[0];
}

/** Read and lightly validate one benchmark JSON file. */
export async function loadBenchmarkRun(filePath: string): Promise<BenchmarkRunResult> {
  const result = JSON.parse(await Bun.file(filePath).text()) as BenchmarkRunResult;
  if (result.version !== 1 || !Array.isArray(result.results)) {
    throw new Error(`Invalid benchmark result file: ${filePath}`);
  }
  return result;
}

/** Determine whether a comparable metric exceeded its material-regression threshold. */
export function isMaterialRegression(
  baseMedian: number,
  headMedian: number,
  threshold: BenchmarkThreshold,
) {
  const absoluteDelta = headMedian - baseMedian;
  if (absoluteDelta <= 0) {
    return false;
  }

  if (absoluteDelta < threshold.minAbsoluteRegression) {
    return false;
  }

  if (baseMedian === 0) {
    return headMedian > 0;
  }

  return headMedian / baseMedian >= threshold.maxRegressionRatio;
}

function relativeDelta(baseMedian: number, headMedian: number) {
  if (baseMedian === 0) {
    return headMedian === 0 ? 0 : Number.POSITIVE_INFINITY;
  }
  return headMedian / baseMedian - 1;
}

function comparableThreshold(
  baseResult: BenchmarkMetricResult | undefined,
  headResult: BenchmarkMetricResult | undefined,
) {
  if (headResult?.threshold) {
    return headResult.threshold;
  }
  return baseResult?.threshold;
}

/** Compare two benchmark snapshots and mark only material regressions as failures. */
export function compareBenchmarkRuns(
  base: BenchmarkRunResult,
  head: BenchmarkRunResult,
): BenchmarkComparisonResult {
  const baseByName = new Map(base.results.map((result) => [result.name, result]));
  const headByName = new Map(head.results.map((result) => [result.name, result]));
  const names = [...new Set([...baseByName.keys(), ...headByName.keys()])].sort();
  const rows: BenchmarkComparisonRow[] = names.map((name) => {
    const baseResult = baseByName.get(name);
    const headResult = headByName.get(name);
    const resultForMetadata = headResult ?? baseResult;
    const threshold = comparableThreshold(baseResult, headResult);

    if (!baseResult && headResult) {
      return {
        name,
        unit: headResult.unit,
        baseMedian: 0,
        headMedian: headResult.median,
        absoluteDelta: headResult.median,
        relativeDelta: Number.POSITIVE_INFINITY,
        threshold,
        status: headResult.comparable ? "missing-base" : "informational",
        source: headResult.source,
      };
    }

    if (baseResult && !headResult) {
      return {
        name,
        unit: baseResult.unit,
        baseMedian: baseResult.median,
        headMedian: 0,
        absoluteDelta: -baseResult.median,
        relativeDelta: -1,
        threshold,
        status: baseResult.comparable ? "missing-head" : "informational",
        source: baseResult.source,
      };
    }

    const checkedBase = baseResult!;
    const checkedHead = headResult!;
    const absoluteDelta = checkedHead.median - checkedBase.median;
    const row: BenchmarkComparisonRow = {
      name,
      unit: checkedHead.unit,
      baseMedian: checkedBase.median,
      headMedian: checkedHead.median,
      absoluteDelta,
      relativeDelta: relativeDelta(checkedBase.median, checkedHead.median),
      threshold,
      status: "informational",
      source: resultForMetadata!.source,
    };

    if (!checkedHead.comparable || !threshold) {
      return row;
    }

    return {
      ...row,
      status: isMaterialRegression(checkedBase.median, checkedHead.median, threshold)
        ? "fail"
        : "pass",
    };
  });

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    baseSha: base.gitSha,
    headSha: head.gitSha,
    failed: rows.some((row) => row.status === "fail" || row.status === "missing-head"),
    rows,
  };
}

function formatNumber(value: number) {
  if (!Number.isFinite(value)) {
    return "∞";
  }

  if (Math.abs(value) >= 100) {
    return value.toFixed(1);
  }

  return value.toFixed(2);
}

function formatDeltaPercent(value: number) {
  if (!Number.isFinite(value)) {
    return "+∞";
  }

  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(1)}%`;
}

function formatUnit(unit: BenchmarkMetricResult["unit"]) {
  return unit === "bytes" ? "B" : unit;
}

function formatThresholdValue(value: number, unit: BenchmarkMetricResult["unit"]) {
  if (unit === "bytes") {
    return `${formatNumber(value / (1024 * 1024))} MiB`;
  }

  if (unit === "ms") {
    return `${formatNumber(value)} ms`;
  }

  return `${formatNumber(value)} ${formatUnit(unit)}`;
}

function formatThreshold(
  threshold: BenchmarkThreshold | undefined,
  unit: BenchmarkMetricResult["unit"],
) {
  if (!threshold) {
    return "—";
  }

  return `+${((threshold.maxRegressionRatio - 1) * 100).toFixed(0)}% and +${formatThresholdValue(
    threshold.minAbsoluteRegression,
    unit,
  )}`;
}

/** Render a compact Markdown report suitable for GitHub Actions summaries. */
export function formatComparisonMarkdown(
  comparison: BenchmarkComparisonResult,
  options: { baseLabel: string; headLabel: string },
) {
  const failedRows = comparison.rows.filter(
    (row) => row.status === "fail" || row.status === "missing-head",
  );
  const lines = [
    "## Release benchmark gate",
    "",
    comparison.failed
      ? `❌ ${failedRows.length} material benchmark regression${failedRows.length === 1 ? "" : "s"} found.`
      : "✅ No material benchmark regressions found.",
    "",
    `Base: \`${options.baseLabel}\`  `,
    `Head: \`${options.headLabel}\``,
    "",
    "| Status | Metric | Base median | Head median | Δ | Threshold |",
    "| --- | --- | ---: | ---: | ---: | --- |",
  ];

  for (const row of comparison.rows) {
    const unit = formatUnit(row.unit);
    const status = row.status === "fail" || row.status === "missing-head" ? "❌" : "✅";
    lines.push(
      `| ${status} ${row.status} | \`${row.name}\` | ${formatNumber(row.baseMedian)} ${unit} | ${formatNumber(
        row.headMedian,
      )} ${unit} | ${formatDeltaPercent(row.relativeDelta)} | ${formatThreshold(row.threshold, row.unit)} |`,
    );
  }

  return `${lines.join("\n")}\n`;
}

function readArgValue(args: string[], index: number) {
  const value = args[index + 1];
  if (!value) {
    throw new Error(`Missing value for ${args[index]}`);
  }
  return value;
}

async function parseArgs(args: string[]): Promise<CompareOptions> {
  const packageVersion = await readPackageVersion();
  const options: CompareOptions = {
    releaseDir: releaseBenchmarkDir(),
    version: packageVersion,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;

    if (arg === "--release-dir") {
      options.releaseDir = path.resolve(readArgValue(args, index));
      index += 1;
      continue;
    }

    if (arg === "--version") {
      options.version = readArgValue(args, index);
      index += 1;
      continue;
    }

    if (arg === "--head") {
      options.head = path.resolve(readArgValue(args, index));
      index += 1;
      continue;
    }

    if (arg === "--base") {
      options.base = path.resolve(readArgValue(args, index));
      index += 1;
      continue;
    }

    if (arg === "--out") {
      options.out = path.resolve(readArgValue(args, index));
      index += 1;
      continue;
    }

    if (arg === "--summary") {
      options.summary = path.resolve(readArgValue(args, index));
      index += 1;
      continue;
    }

    throw new Error(`Unknown release benchmark comparison argument: ${arg}`);
  }

  parseReleaseVersion(options.version);
  return options;
}

/** Run the release benchmark comparison CLI. */
export async function main(args = Bun.argv.slice(2)) {
  const options = await parseArgs(args);
  const headPath = options.head ?? releaseBenchmarkPath(options.version, options.releaseDir);
  if (!existsSync(headPath)) {
    throw new Error(
      `Missing release benchmark ${headPath}. Run bun run bench:release before tagging this release.`,
    );
  }

  const baseCandidate = options.base
    ? { version: path.basename(options.base), path: options.base }
    : findPreviousReleaseBenchmark(options.version, options.releaseDir);
  if (!baseCandidate) {
    throw new Error(
      `Missing previous release benchmark in ${options.releaseDir}. Backfill at least one lower stable release benchmark before releasing.`,
    );
  }

  const [base, head] = await Promise.all([
    loadBenchmarkRun(baseCandidate.path),
    loadBenchmarkRun(headPath),
  ]);
  const comparison = compareBenchmarkRuns(base, head);

  if (options.out) {
    mkdirSync(path.dirname(options.out), { recursive: true });
    writeFileSync(options.out, `${JSON.stringify(comparison, null, 2)}\n`);
  }

  const markdown = formatComparisonMarkdown(comparison, {
    baseLabel: options.base ?? baseCandidate.version,
    headLabel: path.basename(headPath),
  });
  process.stdout.write(markdown);

  if (options.summary) {
    appendFileSync(options.summary, `\n${markdown}`);
  }

  if (comparison.failed) {
    throw new Error(
      "Release benchmark gate failed. Resolve the regression or use an explicit manual override.",
    );
  }

  console.log(`Release benchmark gate passed on ${os.platform()}/${os.arch()}.`);
}

if (import.meta.main) {
  await main();
}
