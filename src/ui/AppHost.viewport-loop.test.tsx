/**
 * Regression stress test for PR #242 / issue #233.
 *
 * This file is intentionally separate from the broad AppHost interaction suite because it is a
 * one-off reproduction for a React/OpenTUI feedback loop rather than normal product behavior:
 * rapid hunk navigation and wheel scrolling can cause OpenTUI's scrollbar to emit synchronous
 * viewport `change` events while DiffPane layout effects are still committing scroll updates.
 * Dispatching React state updates directly from that listener used to recurse through
 * `updateSliderFromScrollState -> onChange -> handleViewportChange -> setScrollViewport` until
 * React threw "Maximum update depth exceeded".
 *
 * The fixture below keeps several ingredients that made the crash reproducible on `main`: many
 * files, separated hunks, stack mode, visible agent notes, repeated `]` navigation, and bursty
 * wheel scrolling. If this test fails or times out, treat it as a signal that viewport event
 * coalescing has regressed; avoid merging it into a generic smoke test unless it can still
 * reproduce the original loop reliably.
 */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { createTestGitAppBootstrap } from "../../test/helpers/app-bootstrap";
import { createTestDiffFile, lines } from "../../test/helpers/diff-helpers";
import { AppHost } from "./AppHost";

/** Build numbered source lines for repeatable multi-hunk viewport stress fixtures. */
function numberedLines(start: number, count: number, valueOffset = 0) {
  return Array.from({ length: count }, (_, index) => {
    const line = start + index;
    return `export const line${String(line).padStart(3, "0")} = ${line + valueOffset};`;
  });
}

/** Build one file with several separated hunks and agent notes to exercise viewport reflow. */
function createStressFile(fileIndex: number) {
  const start = fileIndex * 100 + 1;
  const before = numberedLines(start, 90);
  const after = [...before];

  after[0] = `export const line${String(start).padStart(3, "0")} = ${start + 1000};`;
  after[30] = `export const line${String(start + 30).padStart(3, "0")} = ${start + 3000};`;
  after[60] = `export const line${String(start + 60).padStart(3, "0")} = ${start + 6000};`;

  const file = createTestDiffFile({
    id: `rapid-${fileIndex}`,
    path: `rapid-${fileIndex}.ts`,
    before: lines(...before),
    after: lines(...after),
    context: 3,
  });

  file.agent = {
    path: file.path,
    summary: `rapid ${fileIndex}`,
    annotations: [
      { newRange: [start, start], summary: `note start ${fileIndex}` },
      { newRange: [start + 30, start + 30], summary: `note middle ${fileIndex}` },
      { newRange: [start + 60, start + 60], summary: `note late ${fileIndex}` },
    ],
  };
  return file;
}

/** Render and give OpenTUI/React one paint turn to settle pending viewport updates. */
async function flush(setup: Awaited<ReturnType<typeof testRender>>, cycles = 1) {
  await act(async () => {
    for (let index = 0; index < cycles; index += 1) {
      await setup.renderOnce();
      await Bun.sleep(0);
    }
  });
}

test("rapid hunk navigation and wheel scrolling do not trip React's update-depth guard", async () => {
  const updateDepthErrors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    if (args.some((arg) => String(arg).includes("Maximum update depth exceeded"))) {
      updateDepthErrors.push(args.map(String).join(" "));
    }
    originalError(...args);
  };

  const bootstrap = createTestGitAppBootstrap({
    changesetId: "changeset:rapid-viewport",
    files: Array.from({ length: 10 }, (_, index) => createStressFile(index + 1)),
    gitOptions: { mode: "stack", agentNotes: true },
    initialMode: "stack",
    initialShowAgentNotes: true,
  });
  const setup = await testRender(<AppHost bootstrap={bootstrap} />, { width: 220, height: 12 });

  try {
    await flush(setup, 4);

    for (let batch = 0; batch < 4; batch += 1) {
      await act(async () => {
        for (let index = 0; index < 10; index += 1) {
          await setup.mockInput.typeText("]");
        }
      });
      await flush(setup, 2);
    }

    for (let batch = 0; batch < 4; batch += 1) {
      await act(async () => {
        for (let index = 0; index < 6; index += 1) {
          await setup.mockMouse.scroll(120, 7, "down");
        }
      });
      await flush(setup, 2);
    }

    expect(updateDepthErrors).toEqual([]);
  } finally {
    console.error = originalError;
    await act(async () => {
      setup.renderer.destroy();
    });
  }
}, 20_000);
