#!/bin/bash
set -euo pipefail

baseline=${HUNK_AUTORESEARCH_BASELINE:-autoresearch.baseline.react-main.json}
out=${HUNK_AUTORESEARCH_OUT:-benchmarks/results/autoresearch-head.json}
samples=${HUNK_AUTORESEARCH_SAMPLES:-3}

if [[ ! -f "$baseline" ]]; then
  echo "Missing React baseline: $baseline" >&2
  exit 1
fi

mkdir -p "$(dirname "$out")"
rm -f "$out"

bun run bench -- --samples "$samples" --out "$out"

bun -e '
const [baselinePath, headPath] = Bun.argv.slice(2);
const base = await Bun.file(baselinePath).json();
const head = await Bun.file(headPath).json();
const baseByName = new Map(base.results.map((result) => [result.name, result]));
let regressionScore = 0;
let regressionsCount = 0;
let materialRegressionsCount = 0;
let comparableCount = 0;
let worstRatio = 0;
let worstName = "";
let logRatioSum = 0;
const ratios = new Map();
const solidSources = new Set(["highlight-prefetch", "large-stream", "interaction-latency", "non-ascii-stream"]);
let solidRegressionScore = 0;
let solidWorstRatio = 0;
let solidRegressionsCount = 0;
for (const result of head.results) {
  if (!result.comparable) continue;
  const baseResult = baseByName.get(result.name);
  if (!baseResult || !baseResult.comparable || baseResult.median <= 0) continue;
  const ratio = result.median / baseResult.median;
  ratios.set(result.name, ratio);
  comparableCount += 1;
  logRatioSum += Math.log(Math.max(ratio, Number.EPSILON));
  if (ratio > worstRatio) {
    worstRatio = ratio;
    worstName = result.name;
  }
  if (ratio > 1) {
    regressionsCount += 1;
    regressionScore += (ratio - 1) * 1000;
    if (solidSources.has(result.source)) {
      solidRegressionsCount += 1;
      solidRegressionScore += (ratio - 1) * 1000;
      solidWorstRatio = Math.max(solidWorstRatio, ratio);
    }
  }
  const threshold = result.threshold ?? baseResult.threshold;
  if (threshold) {
    const absoluteDelta = result.median - baseResult.median;
    if (absoluteDelta > 0 && absoluteDelta >= threshold.minAbsoluteRegression && ratio >= threshold.maxRegressionRatio) {
      materialRegressionsCount += 1;
    }
  }
}
const geomeanRatio = comparableCount === 0 ? 1 : Math.exp(logRatioSum / comparableCount);
const metric = (name) => head.results.find((result) => result.name === name)?.median ?? 0;
const ratio = (name) => ratios.get(name) ?? 0;
const emit = (name, value) => console.log(`METRIC ${name}=${Number.isFinite(value) ? value : 0}`);
console.log(`Worst comparable ratio: ${worstRatio.toFixed(4)} ${worstName}`);
emit("perf_score", regressionScore);
emit("worst_ratio", worstRatio);
emit("regressions_count", regressionsCount);
emit("material_regressions_count", materialRegressionsCount);
emit("geomean_ratio", geomeanRatio);
emit("solid_regression_score", solidRegressionScore);
emit("solid_worst_ratio", solidWorstRatio);
emit("solid_regressions_count", solidRegressionsCount);
emit("hunk_nav_press_median_ms", metric("interaction-latency/hunk_nav_press_median_ms"));
emit("hunk_nav_press_median_ratio", ratio("interaction-latency/hunk_nav_press_median_ms"));
emit("hunk_nav_press_p95_ms", metric("interaction-latency/hunk_nav_press_p95_ms"));
emit("hunk_nav_press_p95_ratio", ratio("interaction-latency/hunk_nav_press_p95_ms"));
emit("after_navigation_heap_used_bytes", metric("interaction-latency/after_navigation_heap_used_bytes"));
emit("after_navigation_heap_used_ratio", ratio("interaction-latency/after_navigation_heap_used_bytes"));
emit("first_frame_ms", metric("interaction-latency/first_frame_ms"));
emit("first_frame_ratio", ratio("interaction-latency/first_frame_ms"));
emit("scroll_tick_median_ms", metric("interaction-latency/scroll_tick_median_ms"));
emit("scroll_tick_median_ratio", ratio("interaction-latency/scroll_tick_median_ms"));
emit("large_stream_windowed_scroll_ticks_ms", metric("large-stream/windowed_scroll_ticks_ms"));
emit("large_stream_windowed_scroll_ticks_ratio", ratio("large-stream/windowed_scroll_ticks_ms"));
' "$baseline" "$out"
