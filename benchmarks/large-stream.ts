// Benchmark split-mode startup and scroll behaviour on very large review streams.
import { performance } from "perf_hooks";
import React from "react";
import { testRender } from "@opentui/react/test-utils";
import { AppHost } from "../src/ui/AppHost";
import { VIEWPORT_READ_COALESCE_MS } from "../src/ui/lib/viewportTiming";
import {
  createLargeSplitStreamBootstrap,
  DEFAULT_FILE_COUNT,
  DEFAULT_LINES_PER_FILE,
} from "./large-stream-fixture";

const VIEWPORT = {
  width: 240,
  height: 28,
} as const;
const SCROLL_TICKS = 4;
const SCROLL_TARGET = {
  x: 170,
  y: 12,
} as const;
const SELECTED_HIGHLIGHT_MARKER = "stream1_40";

type BenchmarkRenderer = Awaited<ReturnType<typeof testRender>>;

async function createBenchmarkRenderer() {
  const setup = await testRender(
    React.createElement(AppHost, {
      bootstrap: createLargeSplitStreamBootstrap(),
    }),
    VIEWPORT,
  );

  // This script measures OpenTUI render-loop cost, not React test assertions. Keeping React's
  // act environment enabled makes queued timer/microtask work drain through the test scheduler and
  // can dominate the benchmark with harness time instead of frame time.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

  return setup;
}

function frameHasHighlightedMarker(
  frame: { lines: Array<{ spans: Array<{ text: string }> }> },
  marker: string,
) {
  return frame.lines.some((line) => {
    const text = line.spans.map((span) => span.text).join("");

    if (!text.includes(marker)) {
      return false;
    }

    return line.spans.some(
      (span) => span.text.includes(marker) && span.text.trim().length < text.trim().length,
    );
  });
}

async function renderPass(setup: BenchmarkRenderer, passes = 1) {
  for (let index = 0; index < passes; index += 1) {
    await setup.renderOnce();
  }
}

/** Lets DiffPane's timer-coalesced viewport read update React state. */
async function flushCoalescedViewportRead() {
  await Bun.sleep(VIEWPORT_READ_COALESCE_MS + 1);
}

async function flushSelectedHighlight(setup: BenchmarkRenderer) {
  for (let iteration = 0; iteration < 200; iteration += 1) {
    await renderPass(setup);

    if (frameHasHighlightedMarker(setup.captureSpans(), SELECTED_HIGHLIGHT_MARKER)) {
      return;
    }
  }
}

async function destroyRenderer(setup: BenchmarkRenderer) {
  setup.renderer.destroy();
}

async function measureFirstFrameMs() {
  const setup = await createBenchmarkRenderer();
  const start = performance.now();

  try {
    await renderPass(setup);
    return performance.now() - start;
  } finally {
    await flushSelectedHighlight(setup);
    await destroyRenderer(setup);
  }
}

async function measureScrollTicksMs() {
  const setup = await createBenchmarkRenderer();

  try {
    await renderPass(setup, 2);
    const start = performance.now();

    for (let index = 0; index < SCROLL_TICKS; index += 1) {
      setup.mockMouse.scroll(SCROLL_TARGET.x, SCROLL_TARGET.y, "down");
      await flushCoalescedViewportRead();
      await setup.renderOnce();
    }

    return performance.now() - start;
  } finally {
    await flushSelectedHighlight(setup);
    await destroyRenderer(setup);
  }
}

const coldFirstFrameMs = await measureFirstFrameMs();
const warmFirstFrameMs = await measureFirstFrameMs();
const windowedScrollMs = await measureScrollTicksMs();

console.log(`METRIC cold_first_frame_ms=${coldFirstFrameMs.toFixed(2)}`);
console.log(`METRIC warm_first_frame_ms=${warmFirstFrameMs.toFixed(2)}`);
console.log(`METRIC windowed_scroll_ticks_ms=${windowedScrollMs.toFixed(2)}`);
console.log(`METRIC scroll_ticks=${SCROLL_TICKS}`);
console.log(`METRIC files=${DEFAULT_FILE_COUNT}`);
console.log(`METRIC lines_per_file=${DEFAULT_LINES_PER_FILE}`);
