import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { BenchmarkMetricResult, BenchmarkRunResult } from "../benchmarks/lib/benchmark-result";
import {
  compareBenchmarkRuns,
  findPreviousReleaseBenchmark,
  formatComparisonMarkdown,
  isMaterialRegression,
} from "./compare-release-benchmarks";
import { parseRunReleaseBenchmarkArgs } from "./run-release-benchmark";

let tempRoot: string | undefined;

function createTempReleaseDir() {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "hunk-release-benchmarks-"));
  const releaseDir = path.join(tempRoot, "benchmarks", "release");
  mkdirSync(releaseDir, { recursive: true });
  return releaseDir;
}

function metric(overrides: Partial<BenchmarkMetricResult>): BenchmarkMetricResult {
  return {
    name: "large-stream/cold_first_frame_ms",
    source: "large-stream",
    unit: "ms",
    samples: [100, 101, 99],
    median: 100,
    p75: 101,
    p95: 101,
    min: 99,
    max: 101,
    comparable: true,
    threshold: { maxRegressionRatio: 1.15, minAbsoluteRegression: 5 },
    ...overrides,
  };
}

function runResult(results: BenchmarkMetricResult[]): BenchmarkRunResult {
  return {
    version: 1,
    generatedAt: "2026-06-13T00:00:00.000Z",
    gitSha: "abc1234",
    samplesPerBenchmark: 3,
    results,
  };
}

afterEach(() => {
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

describe("findPreviousReleaseBenchmark", () => {
  test("selects the latest lower stable release benchmark", () => {
    const releaseDir = createTempReleaseDir();
    for (const version of ["0.14.1", "0.15.0", "0.15.3-beta.1", "0.15.3"]) {
      writeFileSync(path.join(releaseDir, `bench-${version}.json`), "{}\n");
    }

    expect(findPreviousReleaseBenchmark("0.15.4", releaseDir)).toMatchObject({
      version: "0.15.3",
    });
  });
});

describe("isMaterialRegression", () => {
  test("requires both relative and absolute timing thresholds", () => {
    const threshold = { maxRegressionRatio: 1.15, minAbsoluteRegression: 5 };

    expect(isMaterialRegression(100, 116, threshold)).toBe(true);
    expect(isMaterialRegression(100, 104, threshold)).toBe(false);
    expect(isMaterialRegression(10, 12, threshold)).toBe(false);
    expect(isMaterialRegression(100, 90, threshold)).toBe(false);
  });
});

describe("parseRunReleaseBenchmarkArgs", () => {
  test("keeps an explicit output path when --version appears later", async () => {
    const outPath = path.join(os.tmpdir(), "custom-release-benchmark.json");

    await expect(
      parseRunReleaseBenchmarkArgs(["--out", outPath, "--version", "0.16.0"]),
    ).resolves.toMatchObject({
      version: "0.16.0",
      out: outPath,
    });
  });
});

describe("compareBenchmarkRuns", () => {
  test("fails material comparable regressions", () => {
    const comparison = compareBenchmarkRuns(
      runResult([metric({ median: 100 })]),
      runResult([metric({ median: 120 })]),
    );

    expect(comparison.failed).toBe(true);
    expect(comparison.rows[0]?.status).toBe("fail");
  });

  test("passes comparable changes inside the material threshold", () => {
    const comparison = compareBenchmarkRuns(
      runResult([metric({ median: 100 })]),
      runResult([metric({ median: 110 })]),
    );

    expect(comparison.failed).toBe(false);
    expect(comparison.rows[0]?.status).toBe("pass");
  });

  test("treats new comparable metrics as informational until a baseline exists", () => {
    const comparison = compareBenchmarkRuns(runResult([]), runResult([metric({ median: 100 })]));

    expect(comparison.failed).toBe(false);
    expect(comparison.rows[0]?.status).toBe("missing-base");
  });

  test("fails when a previously comparable metric disappears", () => {
    const comparison = compareBenchmarkRuns(runResult([metric({ median: 100 })]), runResult([]));

    expect(comparison.failed).toBe(true);
    expect(comparison.rows[0]?.status).toBe("missing-head");
  });
});

describe("formatComparisonMarkdown", () => {
  test("shows absolute threshold units", () => {
    const comparison = compareBenchmarkRuns(
      runResult([
        metric({ median: 100 }),
        metric({
          name: "memory/rss_bytes",
          source: "memory",
          unit: "bytes",
          median: 100 * 1024 * 1024,
          threshold: { maxRegressionRatio: 1.2, minAbsoluteRegression: 8 * 1024 * 1024 },
        }),
      ]),
      runResult([
        metric({ median: 110 }),
        metric({
          name: "memory/rss_bytes",
          source: "memory",
          unit: "bytes",
          median: 105 * 1024 * 1024,
          threshold: { maxRegressionRatio: 1.2, minAbsoluteRegression: 8 * 1024 * 1024 },
        }),
      ]),
    );

    const markdown = formatComparisonMarkdown(comparison, {
      baseLabel: "0.15.1",
      headLabel: "0.15.2",
    });

    expect(markdown).toContain("+15% and +5.00 ms");
    expect(markdown).toContain("+20% and +8.00 MiB");
  });
});
