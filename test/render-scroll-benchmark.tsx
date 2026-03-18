import { testRender } from "@opentui/react/test-utils";
import { parseDiffFromFile } from "@pierre/diffs";
import { act } from "react";
import type { AppBootstrap, DiffFile, LayoutMode } from "../src/core/types";

const { App } = await import("../src/ui/App");

function harmonicMean(values: number[]) {
  return values.length / values.reduce((sum, value) => sum + 1 / Math.max(value, 0.0001), 0);
}

function createFileStats(metadata: DiffFile["metadata"]) {
  let additions = 0;
  let deletions = 0;

  for (const hunk of metadata.hunks) {
    for (const content of hunk.hunkContent) {
      if (content.type === "change") {
        additions += content.additions;
        deletions += content.deletions;
      }
    }
  }

  return { additions, deletions };
}

function buildFile(index: number): DiffFile {
  const path = `src/module-${String(index + 1).padStart(2, "0")}.ts`;
  const before = Array.from({ length: 280 }, (_, lineIndex) => {
    const line = lineIndex + 1;
    return `export const value_${index}_${line} = ${line}; // ${"abcdefghij".repeat((line % 4) + 1)}\n`;
  }).join("");

  const after = Array.from({ length: 280 }, (_, lineIndex) => {
    const line = lineIndex + 1;
    if (line % 19 === 0) {
      return `export const value_${index}_${line} = ${line} + ${index}; // changed ${"longsegment".repeat((line % 3) + 2)}\n`;
    }

    if (line % 29 === 0) {
      return `export const value_${index}_${line} = ${line}; // ${"abcdefghij".repeat((line % 4) + 1)} updated path ${path}\n`;
    }

    return `export const value_${index}_${line} = ${line}; // ${"abcdefghij".repeat((line % 4) + 1)}\n`;
  }).join("");

  const metadata = parseDiffFromFile(
    { name: path, contents: before, cacheKey: `${path}:before` },
    { name: path, contents: after, cacheKey: `${path}:after` },
    { context: 3 },
    true,
  );

  return {
    id: `file-${index}`,
    path,
    patch: "",
    language: "typescript",
    stats: createFileStats(metadata),
    metadata,
    agent:
      index % 2 === 0
        ? {
            path,
            summary: `Notes for ${path}`,
            annotations: [
              {
                newRange: [19, 19],
                summary: `Explains the hot-path update in ${path}`,
                rationale: "Keeps a representative note payload attached to changed rows.",
              },
              {
                newRange: [58, 58],
                summary: `Explains the follow-up change in ${path}`,
                rationale: "Exercises note bookkeeping without changing the default hidden-note behavior.",
              },
            ],
          }
        : null,
  };
}

function createBootstrap(initialMode: LayoutMode, widthHint: number): AppBootstrap {
  const files = Array.from({ length: widthHint >= 180 ? 8 : 6 }, (_, index) => buildFile(index));
  return {
    input: {
      kind: "git",
      staged: false,
      options: {
        mode: initialMode,
      },
    },
    changeset: {
      id: `benchmark:${initialMode}`,
      sourceLabel: "benchmark",
      title: "benchmark working tree",
      summary: "Synthetic but review-like benchmark changeset",
      agentSummary: "Benchmark annotations",
      files,
    },
    initialMode,
    initialTheme: "midnight",
  };
}

async function settle(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await setup.renderOnce();
    await Bun.sleep(40);
    await setup.renderOnce();
  });
}

async function measureScenario(options: {
  mode: LayoutMode;
  width: number;
  height: number;
  iterations: number;
  runner: (setup: Awaited<ReturnType<typeof testRender>>, iteration: number) => Promise<void>;
}) {
  const setup = await testRender(<App bootstrap={createBootstrap(options.mode, options.width)} />, {
    width: options.width,
    height: options.height,
  });

  try {
    await settle(setup);

    const startedAt = performance.now();
    for (let iteration = 0; iteration < options.iterations; iteration += 1) {
      await act(async () => {
        await options.runner(setup, iteration);
        await Bun.sleep(0);
        await setup.renderOnce();
      });
    }
    const elapsedMs = performance.now() - startedAt;

    return {
      fps: (options.iterations * 1000) / elapsedMs,
      elapsedMs,
    };
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
}

const splitScroll = await measureScenario({
  mode: "auto",
  width: 240,
  height: 28,
  iterations: 48,
  runner: async (setup, iteration) => {
    await setup.mockMouse.scroll(150, 12, iteration < 24 ? "down" : "up");
  },
});

const stackScroll = await measureScenario({
  mode: "stack",
  width: 140,
  height: 28,
  iterations: 48,
  runner: async (setup, iteration) => {
    await setup.mockMouse.scroll(70, 12, iteration < 24 ? "down" : "up");
  },
});

const splitNav = await measureScenario({
  mode: "auto",
  width: 240,
  height: 28,
  iterations: 48,
  runner: async (setup) => {
    await setup.mockInput.typeText("]");
  },
});

const stackNav = await measureScenario({
  mode: "stack",
  width: 140,
  height: 28,
  iterations: 48,
  runner: async (setup) => {
    await setup.mockInput.typeText("]");
  },
});

const primaryFps = harmonicMean([splitScroll.fps, stackScroll.fps, splitNav.fps, stackNav.fps]);
const benchmarkMs = splitScroll.elapsedMs + stackScroll.elapsedMs + splitNav.elapsedMs + stackNav.elapsedMs;

console.log(`METRIC fps=${primaryFps.toFixed(2)}`);
console.log(`METRIC split_scroll_fps=${splitScroll.fps.toFixed(2)}`);
console.log(`METRIC stack_scroll_fps=${stackScroll.fps.toFixed(2)}`);
console.log(`METRIC split_nav_fps=${splitNav.fps.toFixed(2)}`);
console.log(`METRIC stack_nav_fps=${stackNav.fps.toFixed(2)}`);
console.log(`METRIC benchmark_ms=${benchmarkMs.toFixed(2)}`);
