// Benchmark the huge fixture tier: ~1k files / 300k+ diff lines plus one giant
// ~50k-line file. Measures cold first frame and interaction latency at the scale
// where "very large diffs feel slow" reports actually live.
//
// This tier is opt-in (run.ts --include-huge or HUNK_BENCH_INCLUDE_HUGE=1) because
// a single sample can take minutes on the unoptimized hot path.
import { performance } from "node:perf_hooks";
import { testRender } from "@opentui/react/test-utils";
import React from "react";
import { AppHost } from "../src/ui/AppHost";
import {
  createHugeStreamBootstrap,
  GIANT_SINGLE_FILE_LINES,
  HUGE_FILE_COUNT,
  HUGE_LINES_PER_FILE,
} from "./large-stream-fixture";
import {
  destroyRenderer,
  INTERACTION_VIEWPORT,
  measureKeyPressLatencies,
  measureScrollTickLatencies,
  printLatencyMetrics,
  printMemoryMetrics,
  renderPass,
} from "./lib/interaction";

const NAVIGATION_PRESSES = 4;
const SCROLL_TICKS = 6;

const fixtureStart = performance.now();
const bootstrap = createHugeStreamBootstrap();
console.log(`METRIC huge_fixture_build_ms=${(performance.now() - fixtureStart).toFixed(2)}`);

// One renderer for the whole script: mounting the huge stream twice would double
// an already multi-minute runtime without improving the measurements.
const setup = await testRender(React.createElement(AppHost, { bootstrap }), INTERACTION_VIEWPORT);

try {
  const firstFrameStart = performance.now();
  await renderPass(setup);
  console.log(
    `METRIC huge_cold_first_frame_ms=${(performance.now() - firstFrameStart).toFixed(2)}`,
  );
  printMemoryMetrics("huge_after_first_frame");

  // Settle startup async work before measuring interactions.
  await renderPass(setup, 2);

  const tickLatencies = await measureScrollTickLatencies(setup, SCROLL_TICKS);
  printLatencyMetrics("huge_scroll_tick", tickLatencies);

  const pressLatencies = await measureKeyPressLatencies(setup, "]", NAVIGATION_PRESSES);
  printLatencyMetrics("huge_hunk_nav_press", pressLatencies);
  printMemoryMetrics("huge_after_navigation");
} finally {
  await destroyRenderer(setup);
}

console.log(`METRIC navigation_presses=${NAVIGATION_PRESSES}`);
console.log(`METRIC scroll_ticks=${SCROLL_TICKS}`);
console.log(`METRIC files=${HUGE_FILE_COUNT + 1}`);
console.log(`METRIC lines_per_file=${HUGE_LINES_PER_FILE}`);
console.log(`METRIC giant_file_lines=${GIANT_SINGLE_FILE_LINES}`);
