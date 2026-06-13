// Shared helpers for interaction-latency benchmarks driven by the OpenTUI test renderer.
import { performance } from "node:perf_hooks";
import type { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { percentile } from "./benchmark-result";

export type TestRendererSetup = Awaited<ReturnType<typeof testRender>>;

/** Standard test-renderer viewport shared by the interaction benchmarks. */
export const INTERACTION_VIEWPORT = { width: 240, height: 28 } as const;

/** Default mouse position for wheel-scroll measurements (inside the diff pane). */
export const SCROLL_TARGET = { x: 170, y: 12 } as const;

/** Drive one or more full render passes through the test renderer. */
export async function renderPass(setup: TestRendererSetup, passes = 1) {
  for (let index = 0; index < passes; index += 1) {
    await act(async () => {
      await setup.renderOnce();
      await Bun.sleep(0);
    });
  }
}

/** Destroy the test renderer inside act so pending React work settles. */
export async function destroyRenderer(setup: TestRendererSetup) {
  await act(async () => {
    setup.renderer.destroy();
  });
}

/** Measure per-press latency (key dispatch + render + flush) for a navigation key. */
export async function measureKeyPressLatencies(
  setup: TestRendererSetup,
  key: string,
  presses: number,
) {
  const latencies: number[] = [];

  for (let index = 0; index < presses; index += 1) {
    const start = performance.now();
    await act(async () => {
      await setup.mockInput.typeText(key);
      await setup.renderOnce();
      await Bun.sleep(0);
    });
    latencies.push(performance.now() - start);
  }

  return latencies;
}

/** Measure per-tick latency (scroll event + render + flush) for mouse wheel scrolls. */
export async function measureScrollTickLatencies(
  setup: TestRendererSetup,
  ticks: number,
  target: { x: number; y: number } = SCROLL_TARGET,
) {
  const latencies: number[] = [];

  for (let index = 0; index < ticks; index += 1) {
    const start = performance.now();
    await act(async () => {
      await setup.mockMouse.scroll(target.x, target.y, "down");
      await setup.renderOnce();
      await Bun.sleep(0);
    });
    latencies.push(performance.now() - start);
  }

  return latencies;
}

/** Print `METRIC <name>_median_ms` / `METRIC <name>_p95_ms` lines for one latency distribution. */
export function printLatencyMetrics(name: string, latencies: number[]) {
  console.log(`METRIC ${name}_median_ms=${percentile(latencies, 50).toFixed(2)}`);
  console.log(`METRIC ${name}_p95_ms=${percentile(latencies, 95).toFixed(2)}`);
}

/** Print RSS/heap METRIC lines mirroring memory.ts labels, after forcing GC for stability. */
export function printMemoryMetrics(prefix: string) {
  // Force a full GC so the ceiling reflects retained memory, not collection timing noise.
  Bun.gc(true);
  const usage = process.memoryUsage();
  console.log(`METRIC ${prefix}_rss_bytes=${usage.rss}`);
  console.log(`METRIC ${prefix}_heap_used_bytes=${usage.heapUsed}`);
}
