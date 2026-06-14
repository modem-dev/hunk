// Benchmark first-frame and scroll-tick latency on a stream whose diff *content*
// contains CJK, emoji, and box-drawing characters. Non-ASCII content bypasses
// measureTextWidth's ASCII fast path, so this exercises the string-width cost on
// real line content rather than just chrome glyphs.
import { performance } from "node:perf_hooks";
import { testRender } from "@opentui/solid";
import { createComponent } from "solid-js";
import { AppHost } from "../src/ui/AppHost";
import { createLargeSplitStreamBootstrap } from "./large-stream-fixture";
import {
  destroyRenderer,
  INTERACTION_VIEWPORT,
  measureScrollTickLatencies,
  printLatencyMetrics,
  renderPass,
} from "./lib/interaction";

// Moderate scale: the point is content shape, not stream size.
const FILE_COUNT = 120;
const LINES_PER_FILE = 120;
const SCROLL_TICKS = 8;

function createNonAsciiBootstrap() {
  return createLargeSplitStreamBootstrap({
    fileCount: FILE_COUNT,
    linesPerFile: LINES_PER_FILE,
    contentVariant: "non-ascii",
  });
}

/** Measure cold first frame on the non-ASCII content stream. */
async function measureFirstFrameMs() {
  const setup = await testRender(
    () => createComponent(AppHost, { bootstrap: createNonAsciiBootstrap() }),
    INTERACTION_VIEWPORT,
  );
  const start = performance.now();

  try {
    await renderPass(setup);
    return performance.now() - start;
  } finally {
    await destroyRenderer(setup);
  }
}

/** Measure per-scroll-tick latency on the non-ASCII content stream. */
async function measureScrolling() {
  const setup = await testRender(
    () => createComponent(AppHost, { bootstrap: createNonAsciiBootstrap() }),
    INTERACTION_VIEWPORT,
  );

  try {
    await renderPass(setup, 2);
    const tickLatencies = await measureScrollTickLatencies(setup, SCROLL_TICKS);
    printLatencyMetrics("non_ascii_scroll_tick", tickLatencies);
  } finally {
    await destroyRenderer(setup);
  }
}

const coldFirstFrameMs = await measureFirstFrameMs();
console.log(`METRIC non_ascii_cold_first_frame_ms=${coldFirstFrameMs.toFixed(2)}`);
await measureScrolling();

console.log(`METRIC scroll_ticks=${SCROLL_TICKS}`);
console.log(`METRIC files=${FILE_COUNT}`);
console.log(`METRIC lines_per_file=${LINES_PER_FILE}`);
