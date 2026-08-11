// Benchmark first-class interaction latency: per-press `]` hunk navigation and
// per-tick scrolling on the large review stream, plus RSS/heap ceilings before
// and after navigation (the default-suite slice of memory.ts).
import { performance } from "node:perf_hooks";
import { testRender } from "@opentui/react/test-utils";
import React from "react";
import { createReviewSessionRuntime } from "../src/app/reviewSessionRuntime";
import { AppHost } from "../src/ui/AppHost";
import {
  createLargeSplitStreamBootstrap,
  DEFAULT_FILE_COUNT,
  DEFAULT_LINES_PER_FILE,
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

// Nearest-rank p95 needs enough observations that it does not collapse to one maximum stall.
const LEGACY_NAVIGATION_PRESSES = 6;
const LEGACY_SCROLL_TICKS = 8;
const NAVIGATION_OBSERVATIONS = 60;
const SCROLL_OBSERVATIONS = 60;

/** Measure `]` per-press latency plus memory ceilings on a fresh renderer. */
async function measureNavigation() {
  const bootstrap = createLargeSplitStreamBootstrap();
  const terminalStartupStart = performance.now();
  const runtime = createReviewSessionRuntime(bootstrap);
  const setup = await testRender(
    React.createElement(AppHost, { bootstrap, runtime }),
    INTERACTION_VIEWPORT,
  );

  try {
    const firstFrameStart = performance.now();
    await renderPass(setup);
    console.log(`METRIC first_frame_ms=${(performance.now() - firstFrameStart).toFixed(2)}`);
    console.log(
      `METRIC runtime_mount_first_frame_ms=${(performance.now() - terminalStartupStart).toFixed(2)}`,
    );
    printMemoryMetrics("after_first_frame");

    // Settle initial async work (selection reveal, highlight kick-off) so the
    // press latencies measure navigation, not startup spillover.
    await renderPass(setup, 2);

    const legacyPressLatencies = await measureKeyPressLatencies(
      setup,
      "]",
      LEGACY_NAVIGATION_PRESSES,
    );
    printLatencyMetrics("hunk_nav_press", legacyPressLatencies);
    printMemoryMetrics("after_navigation");
    const remainingPressLatencies = await measureKeyPressLatencies(
      setup,
      "]",
      NAVIGATION_OBSERVATIONS - LEGACY_NAVIGATION_PRESSES,
    );
    printLatencyMetrics("hunk_nav_60_press", [...legacyPressLatencies, ...remainingPressLatencies]);
  } finally {
    await destroyRenderer(setup);
  }
}

/** Measure per-scroll-tick latency on a fresh renderer (no navigation state). */
async function measureScrolling() {
  const setup = await testRender(
    React.createElement(AppHost, { bootstrap: createLargeSplitStreamBootstrap() }),
    INTERACTION_VIEWPORT,
  );

  try {
    await renderPass(setup, 2);
    const legacyTickLatencies = await measureScrollTickLatencies(setup, LEGACY_SCROLL_TICKS);
    printLatencyMetrics("scroll_tick", legacyTickLatencies);
    const remainingTickLatencies = await measureScrollTickLatencies(
      setup,
      SCROLL_OBSERVATIONS - LEGACY_SCROLL_TICKS,
    );
    printLatencyMetrics("scroll_60_tick", [...legacyTickLatencies, ...remainingTickLatencies]);
  } finally {
    await destroyRenderer(setup);
  }
}

await measureNavigation();
await measureScrolling();

console.log(`METRIC navigation_presses=${LEGACY_NAVIGATION_PRESSES}`);
console.log(`METRIC scroll_ticks=${LEGACY_SCROLL_TICKS}`);
console.log(`METRIC navigation_observations=${NAVIGATION_OBSERVATIONS}`);
console.log(`METRIC scroll_observations=${SCROLL_OBSERVATIONS}`);
console.log(`METRIC files=${DEFAULT_FILE_COUNT}`);
console.log(`METRIC lines_per_file=${DEFAULT_LINES_PER_FILE}`);
