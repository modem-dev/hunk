// Benchmark the wrapped Japanese Markdown shape reported in issue #579: first paint must include
// renderer setup, and burst scrolling must not hide the cost behind serialized wheel ticks.
import { performance } from "node:perf_hooks";
import { parsePatchFiles } from "@pierre/diffs";
import { testRender } from "@opentui/react/test-utils";
import React, { act } from "react";
import type { AppBootstrap } from "../packages/hunk/src/core/bootstrap";
import type { DiffFile } from "../packages/hunk/src/core/changeset/model";
import { AppHost } from "../packages/hunk/src/ui/AppHost";
import { prefetchHighlightedDiff } from "../packages/hunk/src/ui/diff/useHighlightedDiff";
import { VIEWPORT_READ_COALESCE_MS } from "../packages/hunk/src/ui/lib/viewportTiming";
import { resolveTheme } from "../packages/hunk/src/ui/themes";
import {
  destroyRenderer,
  renderPass,
  SCROLL_TARGET,
  type TestRendererSetup,
} from "./lib/interaction";

const VIEWPORT = { width: 240, height: 60 } as const;
const ISSUE_PHYSICAL_LINES = 518;
const WHEEL_BURST_EVENTS = 12;
const LONG_LINE_REPEATS = 96;
const MINIMUM_VISIBLE_CONTENT_RATIO = 0.8;
const CJK_CONTENT_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const CJK_PARAGRAPH =
  "日本語のコメント行および、改行入力されている前提だが、折り返し描画のコストは体感的な引っかかりを生む。長い文章を繰り返して、スクロール中の描画と選択位置が安定していることを確認する。";

/** Build one normalized untracked Markdown file without paying Myers diff cost. */
function createWrappedCjkDiffFile(fixtureId: string, lines: string[]): DiffFile {
  const path = `benchmarks/${fixtureId}.md`;
  const patch = [
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    "",
  ].join("\n");
  const metadata = parsePatchFiles(patch, fixtureId, true).flatMap((entry) => entry.files)[0];

  if (!metadata) {
    throw new Error(`Failed to parse wrapped CJK fixture ${fixtureId}`);
  }

  return {
    id: fixtureId,
    path,
    patch,
    language: "markdown",
    stats: { additions: lines.length, deletions: 0 },
    metadata,
    agent: null,
  };
}

/** Build a wrapped split-view bootstrap around one deterministic Japanese Markdown file. */
function createWrappedCjkBootstrap(fixtureId: string, lines: string[]): AppBootstrap {
  return {
    reloadContext: { cwd: process.cwd() },
    input: {
      kind: "vcs",
      staged: false,
      options: { mode: "split", wrapLines: true },
    },
    changeset: {
      id: `changeset:${fixtureId}`,
      sourceLabel: "repo",
      title: "repo working tree",
      files: [createWrappedCjkDiffFile(fixtureId, lines)],
    },
    initialMode: "split",
    initialWrapLines: true,
    initialTheme: "github-dark-default",
    initialShowAgentNotes: false,
  };
}

/** Reproduce the recording's many-line mix of short labels and wrapped paragraphs. */
function createIssuePhysicalLines() {
  return Array.from({ length: ISSUE_PHYSICAL_LINES }, (_, index) => {
    const label = `項目${index + 1}:`;
    return index % 3 === 0 ? `${label} 短い編集書き` : `${label} ${CJK_PARAGRAPH.repeat(2)}`;
  });
}

/** Include renderer creation and initial React planning in first-frame latency. */
async function measureMountToFirstFrameMs(bootstrap: AppBootstrap) {
  const start = performance.now();
  const setup = await testRender(React.createElement(AppHost, { bootstrap }), VIEWPORT);

  try {
    await renderPass(setup);
    const elapsedMs = performance.now() - start;
    const contentRows = countCjkContentRows(setup.captureCharFrame());
    const minimumContentRows = Math.floor(VIEWPORT.height * MINIMUM_VISIBLE_CONTENT_RATIO);
    if (contentRows < minimumContentRows) {
      throw new Error(
        `Wrapped CJK first frame exposed blank rows: content=${contentRows}, minimum=${minimumContentRows}`,
      );
    }
    return elapsedMs;
  } finally {
    await destroyRenderer(setup);
  }
}

/** Count visual rows containing Japanese text so blank burst frames remain observable. */
function countCjkContentRows(frame: string) {
  return frame.split("\n").filter((line) => CJK_CONTENT_PATTERN.test(line)).length;
}

/** Settle the initial viewport snapshot and deferred highlighting before measuring wheel input. */
async function settleInitialViewport(setup: TestRendererSetup) {
  await renderPass(setup, 2);
  await act(async () => {
    await Bun.sleep(VIEWPORT_READ_COALESCE_MS + 1);
  });
  await renderPass(setup, 2);
}

/** Dispatch a real wheel burst, then measure both its immediate and coalesced frames. */
async function measureWheelBurst(bootstrap: AppBootstrap) {
  const file = bootstrap.changeset.files[0];
  if (!file) {
    throw new Error("Wrapped CJK wheel benchmark requires one diff file");
  }

  // Keep deferred syntax highlighting out of the wheel sample so timing reflects scroll work.
  await prefetchHighlightedDiff({
    file,
    theme: resolveTheme(bootstrap.initialTheme, null),
  });
  const setup = await testRender(React.createElement(AppHost, { bootstrap }), VIEWPORT);

  try {
    await settleInitialViewport(setup);
    const initialFrame = setup.captureCharFrame();
    const initialContentRows = countCjkContentRows(initialFrame);
    const start = performance.now();

    await act(async () => {
      for (let index = 0; index < WHEEL_BURST_EVENTS; index += 1) {
        await setup.mockMouse.scroll(SCROLL_TARGET.x, SCROLL_TARGET.y, "down");
      }
      await setup.renderOnce();
    });

    const immediateMs = performance.now() - start;
    const immediateFrame = setup.captureCharFrame();

    await act(async () => {
      await Bun.sleep(VIEWPORT_READ_COALESCE_MS + 1);
    });
    await renderPass(setup);

    const settledMs = performance.now() - start;
    const settledFrame = setup.captureCharFrame();
    if (initialFrame === immediateFrame && initialFrame === settledFrame) {
      throw new Error("Wrapped CJK wheel burst did not move the review viewport");
    }

    const immediateContentRows = countCjkContentRows(immediateFrame);
    const settledContentRows = countCjkContentRows(settledFrame);
    const minimumContentRows = Math.max(
      1,
      Math.floor(initialContentRows * MINIMUM_VISIBLE_CONTENT_RATIO),
    );
    if (immediateContentRows < minimumContentRows || settledContentRows < minimumContentRows) {
      throw new Error(
        `Wrapped CJK wheel burst exposed blank rows: initial=${initialContentRows}, immediate=${immediateContentRows}, settled=${settledContentRows}`,
      );
    }

    return {
      immediateMs,
      settledMs,
      initialContentRows,
      immediateContentRows,
      settledContentRows,
    };
  } finally {
    await destroyRenderer(setup);
  }
}

const issueLines = createIssuePhysicalLines();
const issueFirstFrameMs = await measureMountToFirstFrameMs(
  createWrappedCjkBootstrap("cjk-wrap-518-first-frame", issueLines),
);
const longLine = CJK_PARAGRAPH.repeat(LONG_LINE_REPEATS);
const longLineFirstFrameMs = await measureMountToFirstFrameMs(
  createWrappedCjkBootstrap("cjk-wrap-single-long-line", [longLine]),
);
const wheelBurst = await measureWheelBurst(
  createWrappedCjkBootstrap("cjk-wrap-518-wheel-burst", issueLines),
);

console.log(`METRIC wrapped_cjk_518_mount_first_frame_ms=${issueFirstFrameMs.toFixed(2)}`);
console.log(`METRIC wrapped_cjk_long_line_mount_first_frame_ms=${longLineFirstFrameMs.toFixed(2)}`);
console.log(`METRIC wrapped_cjk_wheel_burst_immediate_ms=${wheelBurst.immediateMs.toFixed(2)}`);
console.log(`METRIC wrapped_cjk_wheel_burst_settled_ms=${wheelBurst.settledMs.toFixed(2)}`);
console.log(`METRIC wrapped_cjk_wheel_burst_initial_content_rows=${wheelBurst.initialContentRows}`);
console.log(
  `METRIC wrapped_cjk_wheel_burst_immediate_content_rows=${wheelBurst.immediateContentRows}`,
);
console.log(`METRIC wrapped_cjk_wheel_burst_settled_content_rows=${wheelBurst.settledContentRows}`);
console.log(`METRIC physical_lines=${ISSUE_PHYSICAL_LINES}`);
console.log(`METRIC long_line_characters=${longLine.length}`);
console.log(`METRIC wheel_burst_events=${WHEEL_BURST_EVENTS}`);
