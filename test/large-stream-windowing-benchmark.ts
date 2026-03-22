// Measure first-frame cost for a very large multi-file review stream.
import { performance } from "perf_hooks";
import React from "react";
import { testRender } from "@opentui/react/test-utils";
import { parseDiffFromFile } from "@pierre/diffs";
import { act } from "react";
import { App } from "../src/ui/App";
import type { AppBootstrap, DiffFile } from "../src/core/types";

const FILE_COUNT = 180;
const LINES_PER_FILE = 120;

function createDiffFile(index: number): DiffFile {
  const path = `src/stream${index}.ts`;
  const before = Array.from({ length: LINES_PER_FILE }, (_, lineIndex) => {
    const line = lineIndex + 1;
    return `export function stream${index}_${line}(value: number) { return value + ${line}; }\n`;
  }).join("");

  const after = Array.from({ length: LINES_PER_FILE }, (_, lineIndex) => {
    const line = lineIndex + 1;
    if (lineIndex >= 36 && lineIndex < 84) {
      return `export function stream${index}_${line}(value: number) { return value * ${line} + ${index}; }\n`;
    }

    return `export function stream${index}_${line}(value: number) { return value + ${line}; }\n`;
  }).join("");

  const metadata = parseDiffFromFile(
    {
      name: path,
      contents: before,
      cacheKey: `stream:${index}:before`,
    },
    {
      name: path,
      contents: after,
      cacheKey: `stream:${index}:after`,
    },
    { context: 3 },
    true,
  );

  return {
    id: `stream:${index}`,
    path,
    patch: "",
    language: "typescript",
    stats: { additions: 48, deletions: 48 },
    metadata,
    agent: null,
  };
}

function createBootstrap(): AppBootstrap {
  return {
    input: {
      kind: "git",
      staged: false,
      options: {
        mode: "auto",
      },
    },
    changeset: {
      id: "changeset:large-stream-windowing",
      sourceLabel: "repo",
      title: "repo working tree",
      files: Array.from({ length: FILE_COUNT }, (_, index) => createDiffFile(index + 1)),
    },
    initialMode: "split",
    initialTheme: "midnight",
  };
}

const start = performance.now();
const setup = await testRender(React.createElement(App, { bootstrap: createBootstrap() }), {
  width: 240,
  height: 28,
});

try {
  await act(async () => {
    await setup.renderOnce();
    await Bun.sleep(0);
  });

  const firstFrameMs = performance.now() - start;
  console.log(`METRIC first_frame_ms=${firstFrameMs.toFixed(2)}`);
  console.log(`METRIC files=${FILE_COUNT}`);
  console.log(`METRIC lines_per_file=${LINES_PER_FILE}`);
} finally {
  await act(async () => {
    setup.renderer.destroy();
  });
}
