// Measure in-app interaction latency with fast highlighting on or off (HUNK_BENCH_FAST=1).
import { performance } from "node:perf_hooks";
import { testRender } from "@opentui/react/test-utils";
import React from "react";
import { AppHost } from "../src/ui/AppHost";
import { createLargeSplitStreamBootstrap } from "./large-stream-fixture";
import {
  INTERACTION_VIEWPORT, renderPass, destroyRenderer,
  measureKeyPressLatencies, measureScrollTickLatencies, printLatencyMetrics,
} from "./lib/interaction";

const fast = process.env.HUNK_BENCH_FAST === "1";

function bootstrap() {
  const b = createLargeSplitStreamBootstrap();
  return fast
    ? { ...b, input: { ...b.input, options: { ...b.input.options, fast: true } } }
    : b;
}

const setup = await testRender(React.createElement(AppHost, { bootstrap: bootstrap() }), INTERACTION_VIEWPORT);
try {
  const t = performance.now();
  await renderPass(setup);
  console.log(`METRIC first_frame_ms=${(performance.now() - t).toFixed(2)}`);
  await renderPass(setup, 2);
  printLatencyMetrics("hunk_nav_press", await measureKeyPressLatencies(setup, "]", 6));
  printLatencyMetrics("scroll_tick", await measureScrollTickLatencies(setup, 8));
} finally {
  await destroyRenderer(setup);
}
console.log(`METRIC fast_enabled=${fast ? 1 : 0}`);
