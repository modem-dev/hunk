// Benchmark first-class interaction latency: per-press `]` hunk navigation and
// per-tick scrolling on the large review stream, plus RSS/heap ceilings before
// and after navigation (the default-suite slice of memory.ts).
import { performance } from "node:perf_hooks";
import { testRender } from "@opentui/react/test-utils";
import React from "react";
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

const NAVIGATION_PRESSES = 6;
const SCROLL_TICKS = 8;

/** Measure `]` per-press latency plus memory ceilings on a fresh renderer. */
async function measureNavigation() {
  const setup = await testRender(
    React.createElement(AppHost, { bootstrap: createLargeSplitStreamBootstrap() }),
    INTERACTION_VIEWPORT,
  );

  try {
    const firstFrameStart = performance.now();
    await renderPass(setup);
    console.log(`METRIC first_frame_ms=${(performance.now() - firstFrameStart).toFixed(2)}`);
    printMemoryMetrics("after_first_frame");

    // Settle initial async work (selection reveal, highlight kick-off) so the
    // press latencies measure navigation, not startup spillover.
    await renderPass(setup, 2);

    const pressLatencies = await measureKeyPressLatencies(setup, "]", NAVIGATION_PRESSES);
    printLatencyMetrics("hunk_nav_press", pressLatencies);
    printMemoryMetrics("after_navigation");
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
    const tickLatencies = await measureScrollTickLatencies(setup, SCROLL_TICKS);
    printLatencyMetrics("scroll_tick", tickLatencies);
  } finally {
    await destroyRenderer(setup);
  }
}

await measureNavigation();
await measureScrolling();

console.log(`METRIC navigation_presses=${NAVIGATION_PRESSES}`);
console.log(`METRIC scroll_ticks=${SCROLL_TICKS}`);
console.log(`METRIC files=${DEFAULT_FILE_COUNT}`);
console.log(`METRIC lines_per_file=${DEFAULT_LINES_PER_FILE}`);
