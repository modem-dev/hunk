import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { BenchmarkMetricResult, BenchmarkRunResult } from "../benchmarks/lib/benchmark-result";
import {
  compareBenchmarkRuns,
  findPreviousReleaseBenchmark,
  isMaterialRegression,
} from "./compare-release-benchmarks";

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
