import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, mock, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { HunkHostClient } from "../mcp/client";
import type {
  HunkSessionRegistration,
  HunkSessionSnapshot,
  SessionServerMessage,
} from "../mcp/types";
import type { AppBootstrap, LayoutMode } from "../core/types";
import { createTestGitAppBootstrap } from "../../test/helpers/app-bootstrap";
import { createTestDiffFile as buildTestDiffFile, lines } from "../../test/helpers/diff-helpers";

const { loadAppBootstrap } = await import("../core/loaders");
const { AppHost } = await import("./AppHost");

function createTestDiffFile(
  id: string,
  path: string,
  before: string,
  after: string,
  withAgent = false,
) {
  return buildTestDiffFile({
    after,
    agent: withAgent,
    before,
    context: 3,
    id,
    path,
  });
}

function createNumberedAssignmentLines(start: number, count: number, valueOffset = 0) {
  return Array.from({ length: count }, (_, index) => {
    const lineNumber = start + index;
    return `export const line${String(lineNumber).padStart(2, "0")} = ${lineNumber + valueOffset};`;
  });
}

function createMockHostClient() {
  type Bridge = Parameters<HunkHostClient["setBridge"]>[0];

  let bridge: Bridge = null;
  let latestSnapshot: HunkSessionSnapshot | null = null;
  const registration: HunkSessionRegistration = {
    sessionId: "session-1",
    pid: process.pid,
    cwd: process.cwd(),
    repoRoot: process.cwd(),
    inputKind: "git",
    title: "repo working tree",
    sourceLabel: "repo",
    launchedAt: "2026-03-24T00:00:00.000Z",
    reviewFiles: [],
  };
  return {
    hostClient: {
      getRegistration: () => registration,
      replaceSession: () => {},
      setBridge: (nextBridge: Bridge) => {
        bridge = nextBridge;
      },
      updateSnapshot: (snapshot: HunkSessionSnapshot) => {
        latestSnapshot = snapshot;
      },
    } as unknown as HunkHostClient,
    getBridge: () => bridge,
    getLatestSnapshot: () => latestSnapshot,
    navigateToHunk: async (
      input: Extract<SessionServerMessage, { command: "navigate_to_hunk" }>["input"],
    ) => {
      if (!bridge) {
        throw new Error("Expected App to register a bridge before running the test command.");
      }

      return bridge.navigateToHunk({
        type: "command",
        requestId: "test-request",
        command: "navigate_to_hunk",
        input,
      });
    },
  };
}

function createBootstrap(initialMode: LayoutMode = "split", pager = false): AppBootstrap {
  return createTestGitAppBootstrap({
    changesetId: "changeset:app-interactions",
    files: [
      createTestDiffFile(
        "alpha",
        "alpha.ts",
        "export const alpha = 1;\n",
        "export const alpha = 2;\nexport const add = true;\n",
        true,
      ),
      createTestDiffFile(
        "beta",
        "beta.ts",
        "export const beta = 1;\n",
        "export const betaValue = 1;\n",
      ),
    ],
    initialMode,
    pager,
  });
}

function createSingleFileBootstrap(): AppBootstrap {
  return createTestGitAppBootstrap({
    changesetId: "changeset:app-single-file",
    files: [
      createTestDiffFile(
        "alpha",
        "alpha.ts",
        "export const alpha = 1;\n",
        "export const alpha = 2;\nexport const add = true;\n",
        true,
      ),
    ],
  });
}

/** Build a single-file fixture with one long changed line for wrap toggle interaction tests. */
function createWrapBootstrap(pager = false): AppBootstrap {
  return createTestGitAppBootstrap({
    changesetId: "changeset:app-wrap-interactions",
    files: [
      createTestDiffFile(
        "wrap",
        "wrap.ts",
        "export const message = 'short';\n",
        "export const message = 'this is a very long wrapped line for app interaction coverage';\n",
        true,
      ),
    ],
    pager,
  });
}

function createLineScrollBootstrap(pager = false): AppBootstrap {
  const before = lines(...createNumberedAssignmentLines(1, 18));
  const after = lines(...createNumberedAssignmentLines(1, 18, 100));

  return createTestGitAppBootstrap({
    changesetId: "changeset:app-line-scroll",
    files: [createTestDiffFile("scroll", "scroll.ts", before, after, true)],
    pager,
  });
}

/** Build a two-hunk fixture with a deep inline note for CLI comment-navigation scroll tests. */
function createDeepNoteBootstrap(): AppBootstrap {
  const beforeLines = Array.from(
    { length: 80 },
    (_, index) => `export const line${index + 1} = ${index + 1};`,
  );
  const afterLines = [...beforeLines];

  afterLines[0] = "export const line1 = 100;";
  afterLines[59] = "export const line60 = 6000;";
  afterLines[60] = "export const line61 = 6100;";
  afterLines[61] = "export const line62 = 6200;";
  afterLines[62] = "export const line63 = 6300;";
  afterLines[63] = "export const line64 = 6400;";
  afterLines[64] = "export const line65 = 6500;";

  const file = createTestDiffFile(
    "deep-note",
    "deep-note.ts",
    `${beforeLines.join("\n")}\n`,
    `${afterLines.join("\n")}\n`,
  );
  file.agent = {
    path: file.path,
    summary: "file note",
    annotations: [
      {
        newRange: [62, 62],
        summary: "Note anchored on second hunk.",
      },
    ],
  };

  return createTestGitAppBootstrap({
    changesetId: "changeset:app-deep-note",
    files: [file],
    gitOptions: { agentNotes: true },
    initialShowAgentNotes: true,
  });
}

/** Build a long-line fixture that is tall enough to verify viewport-anchor restoration. */
function createWrapScrollBootstrap(): AppBootstrap {
  const before = lines(...createNumberedAssignmentLines(1, 18));
  const after = lines(
    ...createNumberedAssignmentLines(1, 18, 100).map(
      (line) => `${line} // this is intentionally long wrap coverage for viewport anchoring`,
    ),
  );

  return createTestGitAppBootstrap({
    changesetId: "changeset:app-wrap-scroll",
    files: [createTestDiffFile("wrap-scroll", "wrap-scroll.ts", before, after, true)],
  });
}

function createTwoFileHunkBootstrap(): AppBootstrap {
  const firstBeforeLines = createNumberedAssignmentLines(1, 16);
  const secondBeforeLines = createNumberedAssignmentLines(17, 16);

  return createTestGitAppBootstrap({
    changesetId: "changeset:two-file-hunks",
    files: [
      createTestDiffFile(
        "first",
        "first.ts",
        lines(...firstBeforeLines),
        lines(...createNumberedAssignmentLines(1, 16, 100)),
        true,
      ),
      createTestDiffFile(
        "second",
        "second.ts",
        lines(...secondBeforeLines),
        lines(...createNumberedAssignmentLines(17, 16, 100)),
        true,
      ),
    ],
  });
}

function createMouseScrollSelectionBootstrap(): AppBootstrap {
  const firstBeforeLines = createNumberedAssignmentLines(1, 12);
  const secondBeforeLines = Array.from(
    { length: 90 },
    (_, index) => `export const line${String(index + 13).padStart(2, "0")} = ${index + 13};`,
  );
  const secondAfterLines = [...secondBeforeLines];

  secondAfterLines[0] = "export const line13 = 1300;";
  secondAfterLines[59] = "export const line72 = 7200;";
  secondAfterLines[60] = "export const line73 = 7300;";
  secondAfterLines[61] = "export const line74 = 7400;";

  return createTestGitAppBootstrap({
    changesetId: "changeset:mouse-scroll-selection",
    files: [
      createTestDiffFile(
        "first",
        "first.ts",
        lines(...firstBeforeLines),
        lines("export const line01 = 101;", ...createNumberedAssignmentLines(2, 11)),
        true,
      ),
      createTestDiffFile(
        "second",
        "second.ts",
        lines(...secondBeforeLines),
        lines(...secondAfterLines),
        true,
      ),
    ],
  });
}

function createCollapsedTopBootstrap(): AppBootstrap {
  const beforeLines = Array.from(
    { length: 400 },
    (_, index) => `export const line${String(index + 1).padStart(3, "0")} = ${index + 1};`,
  );
  const afterLines = [...beforeLines];
  afterLines[365] = "export const line366 = 9999;";

  return createTestGitAppBootstrap({
    changesetId: "changeset:collapsed-top",
    files: [
      createTestDiffFile(
        "late",
        "src/ui/components/panes/DiffPane.tsx",
        lines(...beforeLines),
        lines(...afterLines),
      ),
      createTestDiffFile(
        "second",
        "other.ts",
        lines("export const other = 1;"),
        lines("export const other = 2;"),
      ),
    ],
  });
}

async function flush(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await setup.renderOnce();
    await Bun.sleep(0);
    await setup.renderOnce();
  });
}

/** Let wrap-toggle renders and follow-up layout retries settle before asserting on the frame. */
async function settleWrapToggle(setup: Awaited<ReturnType<typeof testRender>>) {
  await flush(setup);
  await act(async () => {
    await Bun.sleep(80);
    await setup.renderOnce();
  });
}

/** Poll rendered frames until a predicate matches, which keeps interaction tests resilient to async repaints. */
async function waitForFrame(
  setup: Awaited<ReturnType<typeof testRender>>,
  predicate: (frame: string) => boolean,
  attempts = 8,
) {
  let frame = setup.captureCharFrame();

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate(frame)) {
      return frame;
    }

    await act(async () => {
      await Bun.sleep(30);
      await setup.renderOnce();
    });
    frame = setup.captureCharFrame();
  }

  return frame;
}

async function waitForSnapshot(
  setup: Awaited<ReturnType<typeof testRender>>,
  getSnapshot: () => HunkSessionSnapshot | null,
  predicate: (snapshot: HunkSessionSnapshot) => boolean,
  attempts = 8,
) {
  let snapshot = getSnapshot();

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (snapshot && predicate(snapshot)) {
      return snapshot;
    }

    await act(async () => {
      await Bun.sleep(30);
      await setup.renderOnce();
    });
    snapshot = getSnapshot();
  }

  return snapshot;
}

function firstVisibleAddedLine(frame: string) {
  return frame.match(/line\d{2} = 1\d{2}/)?.[0] ?? null;
}

function firstVisibleAddedLineNumber(frame: string) {
  return frame.match(/▌\s*(\d+)\s+\+/)?.[1] ?? null;
}

describe("App interactions", () => {
  test("keyboard shortcuts toggle notes, line numbers, and hunk metadata", async () => {
    const setup = await testRender(<AppHost bootstrap={createSingleFileBootstrap()} />, {
      width: 240,
      height: 24,
    });

    try {
      await flush(setup);

      await act(async () => {
        await setup.mockInput.typeText("a");
      });
      await flush(setup);

      let frame = setup.captureCharFrame();
      expect(frame).toContain("Annotation for alpha.ts");
      expect(frame).toContain("Why alpha.ts changed");

      await act(async () => {
        await setup.mockInput.typeText("a");
      });
      await flush(setup);

      frame = setup.captureCharFrame();
      expect(frame).not.toContain("Annotation for alpha.ts");

      await act(async () => {
        await setup.mockInput.typeText("l");
      });
      await flush(setup);

      frame = setup.captureCharFrame();
      expect(frame).not.toContain("1 - export const alpha = 1;");
      expect(frame).toContain("- export const alpha = 1;");

      await act(async () => {
        await setup.mockInput.typeText("m");
      });
      await flush(setup);

      frame = setup.captureCharFrame();
      expect(frame).not.toContain("@@ -1,1 +1,2 @@");
      expect(frame).toContain("- export const alpha = 1;");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("keyboard shortcut can wrap long lines in the app", async () => {
    const setup = await testRender(<AppHost bootstrap={createWrapBootstrap()} />, {
      width: 140,
      height: 20,
    });

    try {
      await flush(setup);

      let frame = setup.captureCharFrame();
      expect(frame).not.toContain("interaction coverage");

      await act(async () => {
        await setup.mockInput.typeText("w");
      });
      await flush(setup);

      frame = setup.captureCharFrame();
      expect(frame).toContain("this is a very");
      expect(frame).toContain("long wrapped line");
      expect(frame).toContain("coverage");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("pager mode keyboard shortcut can wrap long lines", async () => {
    const setup = await testRender(<AppHost bootstrap={createWrapBootstrap(true)} />, {
      width: 140,
      height: 20,
    });

    try {
      await flush(setup);

      let frame = setup.captureCharFrame();
      expect(frame).not.toContain("interaction coverage");

      await act(async () => {
        await setup.mockInput.typeText("w");
      });
      await flush(setup);

      frame = setup.captureCharFrame();
      expect(frame).toContain("this is a very");
      expect(frame).toContain("long wrapped line");
      expect(frame).toContain("coverage");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("keyboard shortcut can toggle line wrapping on, off, and on again", async () => {
    const setup = await testRender(<AppHost bootstrap={createWrapBootstrap()} />, {
      width: 102,
      height: 24,
    });

    try {
      await flush(setup);

      let frame = setup.captureCharFrame();
      expect(frame).not.toContain("coverage';");

      await act(async () => {
        await setup.mockInput.typeText("w");
      });
      await settleWrapToggle(setup);

      frame = await waitForFrame(setup, (nextFrame) => nextFrame.includes("coverage';"));
      // Assert on a suffix fragment that only appears once the long line has actually wrapped;
      // this is more stable than expecting the full sentence to remain on one terminal row.
      expect(frame).toContain("wrapped line");
      expect(frame).toContain("coverage';");

      await act(async () => {
        await setup.mockInput.typeText("w");
      });
      await settleWrapToggle(setup);

      frame = await waitForFrame(setup, (nextFrame) => !nextFrame.includes("coverage';"));
      expect(frame).not.toContain("coverage';");

      await act(async () => {
        await setup.mockInput.typeText("w");
      });
      await settleWrapToggle(setup);

      frame = await waitForFrame(setup, (nextFrame) => nextFrame.includes("coverage';"));
      expect(frame).toContain("wrapped line");
      expect(frame).toContain("coverage';");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("left and right arrows can reveal offscreen code columns in nowrap mode", async () => {
    const setup = await testRender(<AppHost bootstrap={createWrapBootstrap()} />, {
      width: 92,
      height: 20,
    });

    try {
      await flush(setup);

      let frame = setup.captureCharFrame();
      expect(frame).toContain("this is a very");
      expect(frame).not.toContain("interaction coverage");

      for (let index = 0; index < 64; index += 1) {
        await act(async () => {
          await setup.mockInput.pressArrow("right");
        });
        await flush(setup);
        frame = setup.captureCharFrame();
        if (frame.includes("interaction coverage")) {
          break;
        }
      }

      expect(frame).toContain("interaction coverage");
      expect(frame).not.toContain("this is a very");

      for (let index = 0; index < 64; index += 1) {
        await act(async () => {
          await setup.mockInput.pressArrow("left");
        });
        await flush(setup);
        frame = setup.captureCharFrame();
        if (frame.includes("this is a very")) {
          break;
        }
      }

      expect(frame).toContain("this is a very");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("shift plus left and right arrows scroll code horizontally faster", async () => {
    const setup = await testRender(<AppHost bootstrap={createWrapBootstrap()} />, {
      width: 92,
      height: 20,
    });

    try {
      await flush(setup);

      let frame = setup.captureCharFrame();
      expect(frame).toContain("this is a very");
      expect(frame).not.toContain("interaction coverage");

      for (let index = 0; index < 8; index += 1) {
        await act(async () => {
          await setup.mockInput.pressArrow("right", { shift: true });
        });
        await flush(setup);
        frame = setup.captureCharFrame();
        if (frame.includes("interaction coverage")) {
          break;
        }
      }

      expect(frame).toContain("interaction coverage");
      expect(frame).not.toContain("this is a very");

      for (let index = 0; index < 8; index += 1) {
        await act(async () => {
          await setup.mockInput.pressArrow("left", { shift: true });
        });
        await flush(setup);
        frame = setup.captureCharFrame();
        if (frame.includes("this is a very")) {
          break;
        }
      }

      expect(frame).toContain("this is a very");
      expect(frame).not.toContain("interaction coverage");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("shift plus mouse wheel scrolls code horizontally", async () => {
    const setup = await testRender(<AppHost bootstrap={createWrapBootstrap()} />, {
      width: 92,
      height: 20,
    });

    try {
      await flush(setup);

      let frame = setup.captureCharFrame();
      expect(frame).toContain("this is a very");
      expect(frame).not.toContain("interaction coverage");

      for (let index = 0; index < 8; index += 1) {
        await act(async () => {
          await setup.mockMouse.scroll(60, 10, "down", { modifiers: { shift: true } });
        });
        await flush(setup);
        frame = setup.captureCharFrame();
        if (frame.includes("interaction coverage")) {
          break;
        }
      }

      expect(frame).toContain("interaction coverage");
      expect(frame).not.toContain("this is a very");

      for (let index = 0; index < 8; index += 1) {
        await act(async () => {
          await setup.mockMouse.scroll(60, 10, "up", { modifiers: { shift: true } });
        });
        await flush(setup);
        frame = setup.captureCharFrame();
        if (frame.includes("this is a very")) {
          break;
        }
      }

      expect(frame).toContain("this is a very");
      expect(frame).not.toContain("interaction coverage");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("shift plus mouse wheel does not move the vertical review position", async () => {
    const setup = await testRender(<AppHost bootstrap={createWrapScrollBootstrap()} />, {
      width: 92,
      height: 20,
    });

    try {
      await flush(setup);

      let frame = setup.captureCharFrame();
      const initialTopLine = firstVisibleAddedLineNumber(frame);
      expect(initialTopLine).toBeTruthy();
      expect(frame).not.toContain("viewport anchoring");

      for (let index = 0; index < 8; index += 1) {
        await act(async () => {
          await setup.mockMouse.scroll(60, 10, "down", { modifiers: { shift: true } });
        });
        await flush(setup);
        frame = setup.captureCharFrame();
        if (frame.includes("viewport anchoring")) {
          break;
        }
      }

      expect(frame).toContain("viewport anchoring");
      expect(firstVisibleAddedLineNumber(frame)).toBe(initialTopLine);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("wrap toggles reset the horizontal code offset", async () => {
    const setup = await testRender(<AppHost bootstrap={createWrapBootstrap()} />, {
      width: 92,
      height: 20,
    });

    try {
      await flush(setup);

      let frame = setup.captureCharFrame();
      expect(frame).toContain("this is a very");

      for (let index = 0; index < 8; index += 1) {
        await act(async () => {
          await setup.mockInput.pressArrow("right", { shift: true });
        });
        await flush(setup);
        frame = setup.captureCharFrame();
        if (frame.includes("interaction coverage")) {
          break;
        }
      }

      expect(frame).toContain("interaction coverage");
      expect(frame).not.toContain("this is a very");

      await act(async () => {
        await setup.mockInput.typeText("w");
      });
      await settleWrapToggle(setup);

      frame = await waitForFrame(setup, (nextFrame) => nextFrame.includes("overage';"));
      expect(frame).toContain("this is a very");
      expect(frame).toContain("long wrapped line");
      expect(frame).toContain("overage';");

      await act(async () => {
        await setup.mockInput.typeText("w");
      });
      await settleWrapToggle(setup);

      frame = await waitForFrame(
        setup,
        (nextFrame) =>
          nextFrame.includes("this is a very") && !nextFrame.includes("interaction coverage"),
      );
      expect(frame).toContain("this is a very");
      expect(frame).not.toContain("interaction coverage");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("bootstrap preferences initialize the visible view state", async () => {
    const setup = await testRender(
      <AppHost
        bootstrap={{
          input: {
            kind: "git",
            staged: false,
            options: {
              mode: "split",
            },
          },
          changeset: {
            id: "changeset:bootstrap-prefs",
            sourceLabel: "repo",
            title: "repo working tree",
            files: [
              createTestDiffFile(
                "prefs",
                "prefs.ts",
                "export const message = 'short';\n",
                "export const message = 'this is a very long wrapped line for bootstrap preference coverage';\nexport const added = true;\n",
                true,
              ),
            ],
          },
          initialMode: "split",
          initialTheme: "paper",
          initialShowLineNumbers: false,
          initialWrapLines: true,
          initialShowHunkHeaders: false,
          initialShowAgentNotes: true,
        }}
      />,
      { width: 140, height: 20 },
    );

    try {
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("AI note · ▶ new 2");
      expect(frame).toContain("Annotation for prefs.ts");
      expect(frame).toContain("Why prefs.ts changed");
      expect(frame).not.toContain("@@ -1,1 +1,2 @@");
      expect(frame).not.toContain("1 - export const message");
      expect(frame.indexOf("AI note · ▶ new 2")).toBeLessThan(
        frame.indexOf("export const added = true;"),
      );
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("menu navigation can switch layouts and activate view actions", async () => {
    const setup = await testRender(<AppHost bootstrap={createBootstrap()} />, {
      width: 220,
      height: 24,
    });

    try {
      await flush(setup);

      await act(async () => {
        await setup.mockInput.pressKey("F10");
      });
      let frame = await waitForFrame(setup, (currentFrame) =>
        currentFrame.includes("Toggle files/filter focus"),
      );
      if (!frame.includes("Toggle files/filter focus")) {
        await act(async () => {
          await setup.mockInput.pressKey("F10");
        });
        frame = await waitForFrame(setup, (currentFrame) =>
          currentFrame.includes("Toggle files/filter focus"),
        );
      }

      expect(frame).toContain("Toggle files/filter focus");
      expect(frame).toContain("Reload");
      expect(frame).toContain("Quit");

      await act(async () => {
        await setup.mockInput.pressArrow("right");
      });
      await flush(setup);
      await act(async () => {
        await setup.mockInput.pressArrow("down");
      });
      await flush(setup);
      await act(async () => {
        await setup.mockInput.pressEnter();
      });
      await flush(setup);

      frame = setup.captureCharFrame();
      expect(frame).not.toContain("Split view");
      expect(frame).toContain("1   -  export const alpha = 1;");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("reload shortcut reloads the current file diff from disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hunk-reload-"));
    const left = join(dir, "before.ts");
    const right = join(dir, "after.ts");

    writeFileSync(left, "export const answer = 41;\n");
    writeFileSync(right, "export const answer = 42;\n");

    const bootstrap = await loadAppBootstrap({
      kind: "diff",
      left,
      right,
      options: {
        mode: "split",
      },
    });

    const setup = await testRender(<AppHost bootstrap={bootstrap} />, {
      width: 220,
      height: 20,
    });

    try {
      await flush(setup);

      let frame = setup.captureCharFrame();
      expect(frame).not.toContain("export const added = true;");

      writeFileSync(right, "export const answer = 42;\nexport const added = true;\n");

      await act(async () => {
        await setup.mockInput.typeText("r");
      });

      let refreshed = false;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await flush(setup);
        frame = setup.captureCharFrame();
        if (frame.includes("export const added = true;")) {
          refreshed = true;
          break;
        }
        await Bun.sleep(25);
      }

      expect(refreshed).toBe(true);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("watch mode reloads the current file diff from disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hunk-watch-"));
    const left = join(dir, "before.ts");
    const right = join(dir, "after.ts");

    writeFileSync(left, "export const answer = 41;\n");
    writeFileSync(right, "export const answer = 42;\n");

    const bootstrap = await loadAppBootstrap({
      kind: "diff",
      left,
      right,
      options: {
        mode: "split",
        watch: true,
      },
    });

    const setup = await testRender(<AppHost bootstrap={bootstrap} />, {
      width: 220,
      height: 20,
    });

    try {
      await flush(setup);

      let frame = setup.captureCharFrame();
      expect(frame).not.toContain("export const added = true;");

      writeFileSync(right, "export const answer = 42;\nexport const added = true;\n");

      let refreshed = false;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await flush(setup);
        frame = setup.captureCharFrame();
        if (frame.includes("export const added = true;")) {
          refreshed = true;
          break;
        }
        await Bun.sleep(25);
      }

      expect(refreshed).toBe(true);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("a shows notes that are visible in the current review viewport", async () => {
    const bootstrap = createBootstrap();
    bootstrap.changeset.files[1]!.agent = {
      path: "beta.ts",
      summary: "beta.ts note",
      annotations: [
        {
          newRange: [1, 1],
          summary: "Annotation for beta.ts",
          rationale: "Why beta.ts changed",
        },
      ],
    };

    const setup = await testRender(<AppHost bootstrap={bootstrap} />, { width: 240, height: 32 });

    try {
      await flush(setup);

      await act(async () => {
        await setup.mockInput.typeText("a");
      });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("Annotation for alpha.ts");
      expect(frame).toContain("Why alpha.ts changed");
      expect(frame).toContain("Annotation for beta.ts");
      expect(frame).toContain("Why beta.ts changed");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("arrow keys scroll the review pane line by line", async () => {
    const setup = await testRender(<AppHost bootstrap={createLineScrollBootstrap()} />, {
      width: 220,
      height: 12,
    });

    try {
      await flush(setup);

      const initialFrame = setup.captureCharFrame();
      expect(initialFrame).toContain("line01");
      expect(initialFrame).not.toContain("line08");

      let frame = initialFrame;
      for (let index = 0; index < 24; index += 1) {
        await act(async () => {
          await setup.mockInput.pressArrow("down");
        });
        await flush(setup);
        frame = setup.captureCharFrame();
        if (frame.includes("line08") && !frame.includes("line01")) {
          break;
        }
      }

      expect(frame).toContain("line08");
      expect(frame).not.toContain("line01");

      for (let index = 0; index < 12; index += 1) {
        await act(async () => {
          await setup.mockInput.pressArrow("up");
        });
        await flush(setup);
        frame = setup.captureCharFrame();
        if (frame.includes("line01")) {
          break;
        }
      }

      expect(frame).toContain("line01");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("the first down-arrow step still advances content under the always-pinned file header above a collapsed gap", async () => {
    const setup = await testRender(<AppHost bootstrap={createCollapsedTopBootstrap()} />, {
      width: 220,
      height: 10,
    });

    try {
      await flush(setup);
      await act(async () => {
        await Bun.sleep(80);
        await setup.renderOnce();
      });

      let frame = setup.captureCharFrame();
      expect(frame).toContain("DiffPane.tsx");
      expect(frame).toContain("··· 362 unchanged lines ···");
      expect(frame).not.toContain("366 - export const line366 = 366;");

      await act(async () => {
        await setup.mockInput.pressArrow("down");
      });
      await flush(setup);
      await act(async () => {
        await Bun.sleep(80);
        await setup.renderOnce();
      });

      frame = await waitForFrame(setup, (nextFrame) =>
        nextFrame.includes("366 - export const line366 = 366;"),
      );
      expect(frame).toContain("366 - export const line366 = 366;");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("one-line down then up at the top restores the collapsed-gap view beneath the pinned file header", async () => {
    const setup = await testRender(<AppHost bootstrap={createCollapsedTopBootstrap()} />, {
      width: 220,
      height: 10,
    });

    try {
      await flush(setup);
      await act(async () => {
        await Bun.sleep(80);
        await setup.renderOnce();
      });

      const initialFrame = setup.captureCharFrame();
      const initialHeaderCount = (initialFrame.match(/DiffPane\.tsx/g) ?? []).length;

      await act(async () => {
        await setup.mockInput.pressArrow("down");
      });
      await flush(setup);
      await act(async () => {
        await Bun.sleep(80);
        await setup.renderOnce();
      });

      let frame = await waitForFrame(setup, (nextFrame) =>
        nextFrame.includes("366 - export const line366 = 366;"),
      );

      await act(async () => {
        await setup.mockInput.pressArrow("up");
      });
      await flush(setup);
      await act(async () => {
        await Bun.sleep(80);
        await setup.renderOnce();
      });

      frame = await waitForFrame(
        setup,
        (nextFrame) =>
          nextFrame.includes("··· 362 unchanged lines ···") &&
          (nextFrame.match(/DiffPane\.tsx/g) ?? []).length === initialHeaderCount,
      );
      expect(frame).toContain("··· 362 unchanged lines ···");
      expect(frame).not.toContain("366 - export const line366 = 366;");
      expect((frame.match(/DiffPane\.tsx/g) ?? []).length).toBe(initialHeaderCount);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("pager mode arrow keys also scroll line by line", async () => {
    const setup = await testRender(<AppHost bootstrap={createLineScrollBootstrap(true)} />, {
      width: 220,
      height: 8,
    });

    try {
      await flush(setup);

      const initialFrame = setup.captureCharFrame();
      expect(initialFrame).toContain("line01");
      expect(initialFrame).not.toContain("line08");

      let frame = initialFrame;
      for (let index = 0; index < 12; index += 1) {
        await act(async () => {
          await setup.mockInput.pressArrow("down");
        });
        await flush(setup);
        frame = setup.captureCharFrame();
        if (frame.includes("line08")) {
          break;
        }
      }

      expect(frame).toContain("line08");
      expect(frame).not.toContain("line01");

      for (let index = 0; index < 12; index += 1) {
        await act(async () => {
          await setup.mockInput.pressArrow("up");
        });
        await flush(setup);
        frame = setup.captureCharFrame();
        if (frame.includes("line01")) {
          break;
        }
      }

      expect(frame).toContain("line01");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("toggling wrap preserves the current viewport anchor instead of snapping to the top", async () => {
    const setup = await testRender(<AppHost bootstrap={createWrapScrollBootstrap()} />, {
      width: 102,
      height: 12,
    });

    try {
      await flush(setup);

      let frame = setup.captureCharFrame();
      expect(frame).toContain("line01 = 101");
      expect(frame).not.toContain("line08 = 108");

      for (let index = 0; index < 24; index += 1) {
        await act(async () => {
          await setup.mockInput.pressArrow("down");
        });
        await flush(setup);
        frame = setup.captureCharFrame();
        if (frame.includes("line08 = 108") && !frame.includes("line01 = 101")) {
          break;
        }
      }

      expect(frame).toContain("line08 = 108");
      expect(frame).not.toContain("line01 = 101");
      const anchoredLine = firstVisibleAddedLine(frame);
      expect(anchoredLine).not.toBeNull();

      await act(async () => {
        await setup.mockInput.typeText("w");
      });
      await flush(setup);
      await act(async () => {
        await Bun.sleep(80);
        await setup.renderOnce();
      });

      frame = setup.captureCharFrame();
      expect(frame).toContain(anchoredLine!);
      expect(firstVisibleAddedLine(frame)).toBe(anchoredLine);

      await act(async () => {
        await setup.mockInput.typeText("w");
      });
      await flush(setup);
      await act(async () => {
        await Bun.sleep(80);
        await setup.renderOnce();
      });

      frame = setup.captureCharFrame();
      expect(frame).toContain(anchoredLine!);
      expect(firstVisibleAddedLine(frame)).toBe(anchoredLine);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("Space scrolls down by viewport", async () => {
    // Create a file with many lines so Space has room to scroll
    const before =
      Array.from(
        { length: 50 },
        (_, index) => `export const line${String(index + 1).padStart(2, "0")} = ${index + 1};`,
      ).join("\n") + "\n";
    const after =
      Array.from(
        { length: 50 },
        (_, index) => `export const line${String(index + 1).padStart(2, "0")} = ${index + 1001};`,
      ).join("\n") + "\n";

    const bootstrap: AppBootstrap = {
      input: {
        kind: "git",
        staged: false,
        options: {
          mode: "split",
        },
      },
      changeset: {
        id: "changeset:space-scroll",
        sourceLabel: "repo",
        title: "repo working tree",
        files: [createTestDiffFile("space", "space.ts", before, after)],
      },
      initialMode: "split",
      initialTheme: "midnight",
    };

    const setup = await testRender(<AppHost bootstrap={bootstrap} />, {
      width: 220,
      height: 12,
    });

    try {
      await flush(setup);
      setup.captureCharFrame();

      await act(async () => {
        await setup.mockInput.pressKey(" ");
      });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("export const line");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("PageUp scrolls up by viewport", async () => {
    const before =
      Array.from(
        { length: 50 },
        (_, index) => `export const line${String(index + 1).padStart(2, "0")} = ${index + 1};`,
      ).join("\n") + "\n";
    const after =
      Array.from(
        { length: 50 },
        (_, index) => `export const line${String(index + 1).padStart(2, "0")} = ${index + 1001};`,
      ).join("\n") + "\n";

    const bootstrap: AppBootstrap = {
      input: {
        kind: "git",
        staged: false,
        options: {
          mode: "split",
        },
      },
      changeset: {
        id: "changeset:pageup-scroll",
        sourceLabel: "repo",
        title: "repo working tree",
        files: [createTestDiffFile("pageup", "pageup.ts", before, after)],
      },
      initialMode: "split",
      initialTheme: "midnight",
    };

    const setup = await testRender(<AppHost bootstrap={bootstrap} />, {
      width: 220,
      height: 12,
    });

    try {
      await flush(setup);

      await act(async () => {
        await setup.mockInput.pressKey(" ");
      });
      await flush(setup);
      setup.captureCharFrame();

      await act(async () => {
        await setup.mockInput.pressKey("pageup");
      });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("export const line");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("new shortcuts d, u, f, and Shift+Space are accepted without errors", async () => {
    const before =
      Array.from(
        { length: 50 },
        (_, index) => `export const line${String(index + 1).padStart(2, "0")} = ${index + 1};`,
      ).join("\n") + "\n";
    const after =
      Array.from(
        { length: 50 },
        (_, index) => `export const line${String(index + 1).padStart(2, "0")} = ${index + 1001};`,
      ).join("\n") + "\n";

    const bootstrap: AppBootstrap = {
      input: {
        kind: "git",
        staged: false,
        options: {
          mode: "split",
        },
      },
      changeset: {
        id: "changeset:half-scroll",
        sourceLabel: "repo",
        title: "repo working tree",
        files: [createTestDiffFile("half", "half.ts", before, after)],
      },
      initialMode: "split",
      initialTheme: "midnight",
    };

    const setup = await testRender(<AppHost bootstrap={bootstrap} />, {
      width: 220,
      height: 12,
      otherModifiersMode: true,
    });

    try {
      await flush(setup);

      await act(async () => {
        await setup.mockInput.pressKey("d");
      });
      await flush(setup);
      let frame = setup.captureCharFrame();
      expect(frame).toContain("export const line");

      await act(async () => {
        await setup.mockInput.pressKey("u");
      });
      await flush(setup);
      frame = setup.captureCharFrame();
      expect(frame).toContain("export const line");

      await act(async () => {
        await setup.mockInput.pressKey("f");
      });
      await flush(setup);
      frame = setup.captureCharFrame();
      expect(frame).toContain("export const line");

      await act(async () => {
        await setup.mockInput.pressKey(" ", { shift: true });
      });
      await flush(setup);
      frame = setup.captureCharFrame();
      expect(frame).toContain("export const line");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("filter focus accepts typed input and narrows the visible file set", async () => {
    const setup = await testRender(<AppHost bootstrap={createBootstrap()} />, {
      width: 240,
      height: 24,
    });

    try {
      await flush(setup);

      await act(async () => {
        await setup.mockInput.pressTab();
      });
      await flush(setup);
      await act(async () => {
        await setup.mockInput.typeText("zzz");
      });
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("filter:");
      expect(frame).toContain("zzz");
      expect(frame).toContain("No files match the current filter.");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("filtering away the selected file reselects the first visible match", async () => {
    const setup = await testRender(<AppHost bootstrap={createBootstrap()} />, {
      width: 240,
      height: 24,
    });

    try {
      await flush(setup);

      await act(async () => {
        await setup.mockInput.pressTab();
      });
      await flush(setup);
      await act(async () => {
        await setup.mockInput.typeText("beta");
      });
      await flush(setup);

      let frame = setup.captureCharFrame();
      expect(frame).toContain("filter:");
      expect(frame).toContain("beta");
      expect((frame.match(/beta\.ts/g) ?? []).length).toBeGreaterThanOrEqual(1);
      expect(frame).not.toContain("Annotation for alpha.ts");

      await act(async () => {
        await setup.mockInput.pressTab();
      });
      await flush(setup);

      frame = setup.captureCharFrame();
      expect(frame).toContain("filter=beta");
      expect(frame).toContain("beta.ts");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("CLI comment navigation respects the active file filter", async () => {
    const { hostClient, navigateToHunk } = createMockHostClient();
    const setup = await testRender(
      <AppHost bootstrap={createBootstrap()} hostClient={hostClient} />,
      {
        width: 240,
        height: 24,
      },
    );

    try {
      await flush(setup);

      await act(async () => {
        await setup.mockInput.pressTab();
      });
      await flush(setup);
      await act(async () => {
        await setup.mockInput.typeText("beta");
      });
      await flush(setup);

      let frame = setup.captureCharFrame();
      expect(frame).toContain("filter:");
      expect(frame).toContain("beta");
      expect(frame).toContain("betaValue");
      expect(frame).not.toContain("add = true");

      let navigationError: unknown;
      await act(async () => {
        try {
          await navigateToHunk({ commentDirection: "next" });
        } catch (error) {
          navigationError = error;
        }
      });

      expect(navigationError).toBeInstanceOf(Error);
      expect((navigationError as Error).message).toContain(
        "No annotated hunks found in the current review.",
      );

      await flush(setup);
      frame = setup.captureCharFrame();
      expect(frame).toContain("betaValue");
      expect(frame).not.toContain("add = true");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("CLI comment navigation scrolls the inline note into view", async () => {
    const { hostClient, navigateToHunk } = createMockHostClient();
    const setup = await testRender(
      <AppHost bootstrap={createDeepNoteBootstrap()} hostClient={hostClient} />,
      {
        width: 104,
        height: 18,
      },
    );

    try {
      await flush(setup);

      let frame = setup.captureCharFrame();
      expect(frame).not.toContain("Note anchored on second hunk.");

      let result: Awaited<ReturnType<typeof navigateToHunk>> | undefined;
      await act(async () => {
        result = await navigateToHunk({ commentDirection: "next" });
      });

      expect(result).toMatchObject({
        filePath: "deep-note.ts",
        hunkIndex: 1,
      });

      frame = await waitForFrame(setup, (currentFrame) =>
        currentFrame.includes("Note anchored on second hunk."),
      );
      expect(frame).toContain("Note anchored on second hunk.");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("menu navigation wraps across the first and last top-level menus", async () => {
    const setup = await testRender(<AppHost bootstrap={createBootstrap()} />, {
      width: 220,
      height: 24,
    });

    try {
      await flush(setup);

      await act(async () => {
        await setup.mockInput.pressKey("F10");
      });
      await flush(setup);

      let frame = setup.captureCharFrame();
      expect(frame).toContain("Toggle files/filter focus");
      expect(frame).not.toContain("Controls help");

      await act(async () => {
        await setup.mockInput.pressArrow("left");
      });
      await flush(setup);

      frame = setup.captureCharFrame();
      expect(frame).toContain("Controls help");
      expect(frame).not.toContain("Toggle files/filter focus");

      await act(async () => {
        await setup.mockInput.pressArrow("right");
      });
      await flush(setup);

      frame = setup.captureCharFrame();
      expect(frame).toContain("Toggle files/filter focus");
      expect(frame).not.toContain("Controls help");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("sidebar visibility can toggle off and back on", async () => {
    const setup = await testRender(<AppHost bootstrap={createBootstrap()} />, {
      width: 240,
      height: 24,
    });

    try {
      await flush(setup);

      let frame = setup.captureCharFrame();
      expect((frame.match(/alpha\.ts/g) ?? []).length).toBe(2);

      await act(async () => {
        await setup.mockInput.typeText("s");
      });
      await flush(setup);

      frame = setup.captureCharFrame();
      expect((frame.match(/alpha\.ts/g) ?? []).length).toBe(1);

      await act(async () => {
        await setup.mockInput.typeText("s");
      });
      await flush(setup);

      frame = setup.captureCharFrame();
      expect((frame.match(/alpha\.ts/g) ?? []).length).toBe(2);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("sidebar shortcut can force the sidebar open when responsive layout hides it", async () => {
    const setup = await testRender(<AppHost bootstrap={createBootstrap("auto")} />, {
      width: 160,
      height: 24,
    });

    try {
      await flush(setup);

      let frame = setup.captureCharFrame();
      expect((frame.match(/alpha\.ts/g) ?? []).length).toBe(1);

      await act(async () => {
        await setup.mockInput.typeText("s");
      });
      await flush(setup);

      frame = setup.captureCharFrame();
      expect((frame.match(/alpha\.ts/g) ?? []).length).toBe(2);

      await act(async () => {
        await setup.mockInput.typeText("s");
      });
      await flush(setup);

      frame = setup.captureCharFrame();
      expect((frame.match(/alpha\.ts/g) ?? []).length).toBe(1);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("hunk navigation makes the destination file own the top of the review pane", async () => {
    const setup = await testRender(<AppHost bootstrap={createTwoFileHunkBootstrap()} />, {
      width: 220,
      height: 10,
    });

    try {
      await flush(setup);

      for (let index = 0; index < 10; index += 1) {
        await act(async () => {
          await setup.mockInput.pressArrow("down");
        });
        await flush(setup);
      }

      let frame = setup.captureCharFrame();
      expect(frame).toContain("first.ts");

      await act(async () => {
        await setup.mockInput.typeText("]");
      });
      await flush(setup);

      frame = await waitForFrame(
        setup,
        (nextFrame) =>
          nextFrame.includes("second.ts") && (nextFrame.match(/first\.ts/g) ?? []).length === 1,
        24,
      );
      expect(frame).toContain("second.ts");
      expect((frame.match(/first\.ts/g) ?? []).length).toBe(1);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("mouse wheel scrolling updates the active file and hunk to the viewport center", async () => {
    const { getLatestSnapshot, hostClient } = createMockHostClient();
    const setup = await testRender(
      <AppHost bootstrap={createMouseScrollSelectionBootstrap()} hostClient={hostClient} />,
      {
        width: 220,
        height: 12,
      },
    );

    try {
      await flush(setup);

      expect(getLatestSnapshot()).toMatchObject({
        selectedFilePath: "first.ts",
        selectedHunkIndex: 0,
      });

      let snapshot = getLatestSnapshot();
      for (let index = 0; index < 24; index += 1) {
        await act(async () => {
          await setup.mockMouse.scroll(120, 7, "down");
        });
        await flush(setup);

        snapshot = await waitForSnapshot(
          setup,
          getLatestSnapshot,
          (currentSnapshot) =>
            currentSnapshot.selectedFilePath === "second.ts" &&
            currentSnapshot.selectedHunkIndex === 1,
          4,
        );
        if (snapshot?.selectedFilePath === "second.ts" && snapshot.selectedHunkIndex === 1) {
          break;
        }
      }

      expect(snapshot).toMatchObject({
        selectedFilePath: "second.ts",
        selectedHunkIndex: 1,
      });
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("clicking a sidebar file makes that file own the top of the review pane", async () => {
    const setup = await testRender(<AppHost bootstrap={createTwoFileHunkBootstrap()} />, {
      width: 220,
      height: 10,
    });

    try {
      await flush(setup);

      // Move partway into the first file so ownership can visibly change on sidebar selection.
      for (let index = 0; index < 8; index += 1) {
        await act(async () => {
          await setup.mockInput.pressArrow("down");
        });
        await flush(setup);
      }

      await act(async () => {
        // Click inside the second file row in the left sidebar.
        await setup.mockMouse.click(6, 4);
      });
      await flush(setup);

      const frame = await waitForFrame(
        setup,
        (nextFrame) =>
          nextFrame.includes("second.ts") && (nextFrame.match(/first\.ts/g) ?? []).length === 1,
      );
      expect(frame).toContain("second.ts");
      expect((frame.match(/first\.ts/g) ?? []).length).toBe(1);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("quit shortcuts route through the provided onQuit handler in regular and pager modes", async () => {
    const regularQuit = mock(() => undefined);
    const regularSetup = await testRender(
      <AppHost bootstrap={createBootstrap()} onQuit={regularQuit} />,
      { width: 220, height: 24 },
    );

    try {
      await flush(regularSetup);
      await act(async () => {
        await regularSetup.mockInput.typeText("q");
      });
      await flush(regularSetup);

      expect(regularQuit).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => {
        regularSetup.renderer.destroy();
      });
    }

    const pagerQuit = mock(() => undefined);
    const pagerSetup = await testRender(
      <AppHost bootstrap={createBootstrap("auto", true)} onQuit={pagerQuit} />,
      { width: 180, height: 20 },
    );

    try {
      await flush(pagerSetup);
      await act(async () => {
        await pagerSetup.mockInput.typeText("q");
      });
      await flush(pagerSetup);

      expect(pagerQuit).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => {
        pagerSetup.renderer.destroy();
      });
    }
  });
});
