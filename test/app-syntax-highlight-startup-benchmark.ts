import { performance } from "perf_hooks";
import React from "react";
import { RGBA } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { parseDiffFromFile } from "@pierre/diffs";
import { act } from "react";
import type { AppBootstrap, DiffFile } from "../src/core/types";

function createDiffFile(index: number): DiffFile {
  const path = `src/example${index}.ts`;
  const before = Array.from({ length: 160 }, (_, lineIndex) => {
    const line = lineIndex + 1;
    return `export function feature${index}_${line}(value: number) { return value + ${line}; }\n`;
  }).join("");

  const after = Array.from({ length: 160 }, (_, lineIndex) => {
    const line = lineIndex + 1;
    if (lineIndex >= 48 && lineIndex < 112) {
      return `export function feature${index}_${line}(value: number) { return value * ${line} + ${index}; }\n`;
    }

    return `export function feature${index}_${line}(value: number) { return value + ${line}; }\n`;
  }).join("");

  const metadata = parseDiffFromFile(
    {
      name: path,
      contents: before,
      cacheKey: `benchmark:${index}:before`,
    },
    {
      name: path,
      contents: after,
      cacheKey: `benchmark:${index}:after`,
    },
    { context: 3 },
    true,
  );

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

  return {
    id: `benchmark:${index}`,
    path,
    patch: "",
    language: "typescript",
    stats: { additions, deletions },
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
      id: "changeset:app-benchmark",
      sourceLabel: "repo",
      title: "repo working tree",
      files: Array.from({ length: 10 }, (_, index) => createDiffFile(index + 1)),
    },
    initialMode: "auto",
    initialTheme: "midnight",
  };
}

const addedContent = RGBA.fromHex("#102a1f");
const removedContent = RGBA.fromHex("#371b1e");
const start = performance.now();
const { App } = await import("../src/ui/App");
const setup = await testRender(React.createElement(App, { bootstrap: createBootstrap() }), { width: 240, height: 28 });

let selectedHighlighted = false;
let iterations = 0;

try {
  while (!selectedHighlighted && iterations < 400) {
    iterations += 1;
    await act(async () => {
      await setup.renderOnce();
      await Bun.sleep(0);
    });

    const frame = setup.captureSpans();
    selectedHighlighted = frame.lines.some((line) =>
      line.spans.some((span) => span.bg.equals(addedContent) || span.bg.equals(removedContent)),
    );
  }

  const selectedHighlightMs = performance.now() - start;

  console.log(`METRIC selected_highlight_ms=${selectedHighlightMs.toFixed(2)}`);
  console.log(`METRIC iterations=${iterations}`);
  console.log(`METRIC files=10`);
  console.log("METRIC lines_per_file=160");
} finally {
  await act(async () => {
    setup.renderer.destroy();
  });
}
