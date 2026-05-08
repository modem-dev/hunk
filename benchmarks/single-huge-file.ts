// Benchmark split-mode startup and scroll behaviour on a single very large file.
import { performance } from "perf_hooks";
import React from "react";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { AppHost } from "../src/ui/AppHost";
import { createLargeSplitStreamBootstrap } from "./large-stream-fixture";

const VIEWPORT = {
  width: 240,
  height: 28,
} as const;
const SCROLL_TICKS = 18;
const SCROLL_TARGET = {
  x: 170,
  y: 12,
} as const;

type BenchmarkRenderer = Awaited<ReturnType<typeof testRender>>;

async function renderPass(setup: BenchmarkRenderer, passes = 1) {
  for (let index = 0; index < passes; index += 1) {
    await act(async () => {
      await setup.renderOnce();
      await Bun.sleep(0);
    });
  }
}

async function destroyRenderer(setup: BenchmarkRenderer) {
  await act(async () => {
    setup.renderer.destroy();
  });
}

async function measureScrollTicksMs(fileCount: number, linesPerFile: number) {
  const setup = await testRender(
    React.createElement(AppHost, {
      bootstrap: createLargeSplitStreamBootstrap({ fileCount, linesPerFile }),
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
    await destroyRenderer(setup);
  }
}

const multiFileScrollMs = await measureScrollTicksMs(100, 100);
const singleHugeFileScrollMs = await measureScrollTicksMs(1, 200000);

console.log(`METRIC multi_file_scroll_ticks_ms=${multiFileScrollMs.toFixed(2)}`);
console.log(`METRIC single_huge_file_scroll_ticks_ms=${singleHugeFileScrollMs.toFixed(2)}`);
console.log(`METRIC scroll_ticks=${SCROLL_TICKS}`);
