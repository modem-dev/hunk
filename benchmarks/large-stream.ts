// Benchmark split-mode startup and scroll behaviour on very large review streams,
// including note-enabled cases that disable the placeholder windowing path.
import { performance } from "perf_hooks";
import React from "react";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { AppHost } from "../src/ui/App";
import {
  createLargeSplitStreamBootstrap,
  DEFAULT_FILE_COUNT,
  DEFAULT_LINES_PER_FILE,
  DEFAULT_NOTES_PER_FILE,
} from "./large-stream-fixture";

const VIEWPORT = {
  width: 240,
  height: 28,
} as const;
const SCROLL_TICKS = 18;
const SCROLL_TARGET = {
  x: 170,
  y: 12,
} as const;
const SELECTED_HIGHLIGHT_MARKER = "stream1_40";

type BenchmarkRenderer = Awaited<ReturnType<typeof testRender>>;

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
    await act(async () => {
      await setup.renderOnce();
      await Bun.sleep(0);
    });
  }
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
  await act(async () => {
    setup.renderer.destroy();
  });
}

async function measureFirstFrameMs(notesPerFile: number) {
  const setup = await testRender(
    React.createElement(AppHost, {
      bootstrap: createLargeSplitStreamBootstrap({ notesPerFile }),
    }),
    VIEWPORT,
  );
  const start = performance.now();

  try {
    await renderPass(setup);
    return performance.now() - start;
  } finally {
    await flushSelectedHighlight(setup);
    await destroyRenderer(setup);
  }
}

async function measureScrollTicksMs(notesPerFile: number) {
  const setup = await testRender(
    React.createElement(AppHost, {
      bootstrap: createLargeSplitStreamBootstrap({ notesPerFile }),
    }),
    VIEWPORT,
  );

  try {
    await renderPass(setup, 2);
    const start = performance.now();

    for (let index = 0; index < SCROLL_TICKS; index += 1) {
      await act(async () => {
        await setup.mockMouse.scroll(SCROLL_TARGET.x, SCROLL_TARGET.y, "down");
        await setup.renderOnce();
        await Bun.sleep(0);
      });
    }

    return performance.now() - start;
  } finally {
    await flushSelectedHighlight(setup);
    await destroyRenderer(setup);
  }
}

const coldFirstFrameMs = await measureFirstFrameMs(0);
const warmFirstFrameMs = await measureFirstFrameMs(0);
const noteFirstFrameMs = await measureFirstFrameMs(DEFAULT_NOTES_PER_FILE);
const windowedScrollMs = await measureScrollTicksMs(0);
const noteScrollMs = await measureScrollTicksMs(DEFAULT_NOTES_PER_FILE);

console.log(`METRIC cold_first_frame_ms=${coldFirstFrameMs.toFixed(2)}`);
console.log(`METRIC warm_first_frame_ms=${warmFirstFrameMs.toFixed(2)}`);
console.log(`METRIC note_first_frame_ms=${noteFirstFrameMs.toFixed(2)}`);
console.log(`METRIC windowed_scroll_ticks_ms=${windowedScrollMs.toFixed(2)}`);
console.log(`METRIC note_scroll_ticks_ms=${noteScrollMs.toFixed(2)}`);
console.log(`METRIC scroll_ticks=${SCROLL_TICKS}`);
console.log(`METRIC files=${DEFAULT_FILE_COUNT}`);
console.log(`METRIC lines_per_file=${DEFAULT_LINES_PER_FILE}`);
console.log(`METRIC notes_per_file=${DEFAULT_NOTES_PER_FILE}`);
