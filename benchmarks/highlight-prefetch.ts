// Measure both first selected-file highlighting and how ready the next file is
// once low-priority adjacent prefetch has had a chance to start.
import { performance } from "perf_hooks";
import React from "react";
import { testRender } from "@opentui/react/test-utils";
import { parseDiffFromFile } from "@pierre/diffs";
import { act } from "react";
import { AppHost } from "../src/ui/App";
import type { AppBootstrap, DiffFile } from "../src/core/types";

function createDiffFile(index: number, marker: string): DiffFile {
  const path = `src/example${index}.ts`;
  const before = [
    `export const ${marker} = ${index};`,
    `export function keep${index}(value: number) { return value + ${index}; }`,
    `export const tail${index} = true;`,
    "",
  ].join("\n");

  const after = [
    `export const ${marker} = ${index + 1};`,
    `export function keep${index}(value: number) { return value * ${index + 1}; }`,
    `export const tail${index} = true;`,
    "",
  ].join("\n");

  const metadata = parseDiffFromFile(
    {
      name: path,
      contents: before,
      cacheKey: `prefetch:${index}:before`,
    },
    {
      name: path,
      contents: after,
      cacheKey: `prefetch:${index}:after`,
    },
    { context: 3 },
    true,
  );

  return {
    id: `prefetch:${index}`,
    path,
    patch: "",
    language: "typescript",
    stats: { additions: 2, deletions: 2 },
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
      id: "changeset:prefetch-benchmark",
      sourceLabel: "repo",
      title: "repo working tree",
      files: [
        createDiffFile(1, "alphaMarker"),
        createDiffFile(2, "betaMarker"),
        createDiffFile(3, "gammaMarker"),
        createDiffFile(4, "deltaMarker"),
      ],
    },
    initialMode: "split",
    initialTheme: "midnight",
  };
}

function frameHasHighlightedMarker(
  frame: { lines: Array<{ spans: Array<{ text: string; fg?: unknown; bg?: unknown }> }> },
  marker: string,
) {
  return frame.lines.some((line) => {
    const text = line.spans.map((span) => span.text).join("");

    if (!text.includes(marker)) {
      return false;
    }

    // Plain fallback rendering tends to collapse the whole code cell into one span,
    // while highlighted output keeps token-level segmentation around the marker.
    return line.spans.some(
      (span) => span.text.includes(marker) && span.text.trim().length < text.trim().length,
    );
  });
}

const setup = await testRender(React.createElement(AppHost, { bootstrap: createBootstrap() }), {
  width: 240,
  height: 24,
});
const start = performance.now();
let iterations = 0;
let selectedStartupMs = 0;
let adjacentReadyBeforeMove = false;

try {
  while (iterations < 400) {
    iterations += 1;
    await act(async () => {
      await setup.renderOnce();
      await Bun.sleep(0);
    });

    const frame = setup.captureSpans();
    if (frameHasHighlightedMarker(frame, "alphaMarker")) {
      selectedStartupMs = performance.now() - start;
      adjacentReadyBeforeMove = frameHasHighlightedMarker(frame, "betaMarker");
      break;
    }
  }

  await act(async () => {
    await setup.renderOnce();
    await Bun.sleep(0);
    await setup.renderOnce();
    await Bun.sleep(0);
  });

  const moveStart = performance.now();

  await act(async () => {
    setup.mockInput.pressArrow("down");
    await setup.renderOnce();
    await Bun.sleep(0);
  });

  let nextFileReadyMs = 0;
  while (iterations < 800) {
    iterations += 1;
    await act(async () => {
      await setup.renderOnce();
      await Bun.sleep(0);
    });

    const frame = setup.captureSpans();
    if (frameHasHighlightedMarker(frame, "betaMarker")) {
      nextFileReadyMs = performance.now() - moveStart;
      break;
    }
  }

  console.log(`METRIC selected_startup_ms=${selectedStartupMs.toFixed(2)}`);
  console.log(`METRIC next_file_ready_ms=${nextFileReadyMs.toFixed(2)}`);
  console.log(`METRIC adjacent_ready_before_move=${adjacentReadyBeforeMove ? 1 : 0}`);
  console.log(`METRIC files=4`);
  console.log(`METRIC iterations=${iterations}`);
} finally {
  await act(async () => {
    setup.renderer.destroy();
  });
}
