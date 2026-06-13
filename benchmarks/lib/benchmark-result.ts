export interface BenchmarkThreshold {
  maxRegressionRatio: number;
  minAbsoluteRegression: number;
}

export interface BenchmarkMetricResult {
  name: string;
  unit: "ms" | "bytes" | "count" | "ratio" | "boolean";
  samples: number[];
  median: number;
  p75: number;
  p95: number;
  min: number;
  max: number;
  threshold?: BenchmarkThreshold;
  comparable: boolean;
  source: string;
}

export interface BenchmarkRuntimeInfo {
  bunVersion?: string;
  platform: string;
  arch: string;
}

export interface BenchmarkRunResult {
  version: 1;
  generatedAt: string;
  gitSha?: string;
  packageVersion?: string;
  runtime?: BenchmarkRuntimeInfo;
  samplesPerBenchmark: number;
  results: BenchmarkMetricResult[];
}

export interface BenchmarkComparisonRow {
  name: string;
  unit: BenchmarkMetricResult["unit"];
  baseMedian: number;
  headMedian: number;
  absoluteDelta: number;
  relativeDelta: number;
  threshold?: BenchmarkThreshold;
  status: "pass" | "fail" | "missing-base" | "missing-head" | "informational";
  source: string;
}

export interface BenchmarkComparisonResult {
  version: 1;
  generatedAt: string;
  baseSha?: string;
  headSha?: string;
  failed: boolean;
  rows: BenchmarkComparisonRow[];
}

/** Return percentile values using nearest-rank indexing over sorted samples. */
export function percentile(samples: number[], percentileValue: number) {
  if (samples.length === 0) {
    return 0;
  }

  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1),
  );
  return sorted[index]!;
}

/** Infer display and comparison metadata from the metric name emitted by a script. */
export function classifyMetric(
  name: string,
): Pick<BenchmarkMetricResult, "unit" | "comparable" | "threshold"> {
  if (name.startsWith("competitor_")) {
    return { unit: "ms", comparable: false };
  }

  if (name.endsWith("_ms")) {
    return {
      unit: "ms",
      comparable: true,
      threshold: { maxRegressionRatio: 1.15, minAbsoluteRegression: 5 },
    };
  }

  if (
    name.startsWith("is_") ||
    name.endsWith("_ready_before_move") ||
    name.endsWith("_available")
  ) {
    return { unit: "boolean", comparable: false };
  }

  if (name.includes("rss") || name.includes("heap")) {
    return {
      unit: "bytes",
      comparable: true,
      threshold: { maxRegressionRatio: 1.2, minAbsoluteRegression: 8 * 1024 * 1024 },
    };
  }

  if (name.endsWith("_bytes")) {
    return { unit: "bytes", comparable: false };
  }

  return { unit: "count", comparable: false };
}

/** Build an aggregated result from raw numeric samples. */
export function aggregateMetric(
  source: string,
  name: string,
  samples: number[],
): BenchmarkMetricResult {
  const classification = classifyMetric(name);
  const sorted = [...samples].sort((left, right) => left - right);

  return {
    name: `${source}/${name}`,
    source,
    samples,
    median: percentile(sorted, 50),
    p75: percentile(sorted, 75),
    p95: percentile(sorted, 95),
    min: sorted[0] ?? 0,
    max: sorted.at(-1) ?? 0,
    ...classification,
  };
}
