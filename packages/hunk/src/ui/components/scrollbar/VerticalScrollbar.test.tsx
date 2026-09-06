import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { parseDiffFromFile } from "@pierre/diffs";
import { act, createRef } from "react";
import { capturedTestColorToHex } from "../../../../../../test/helpers/test-color-helpers";
import type { AppBootstrap } from "../../../core/bootstrap";
import type { DiffFile } from "../../../core/changeset/model";
import { resolveTheme } from "../../themes";
import {
  VerticalScrollbar,
  type VerticalScrollbarHandle,
  type VerticalScrollbarScheduler,
} from "./VerticalScrollbar";

const { AppHost } = await import("../../AppHost");

function createDiffFile(id: string, path: string, before: string, after: string): DiffFile {
  const metadata = parseDiffFromFile(
    { name: path, contents: before, cacheKey: `${id}:before` },
    { name: path, contents: after, cacheKey: `${id}:after` },
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
    id,
    path,
    patch: "",
    language: "typescript",
    stats: { additions, deletions },
    metadata,
    agent: null,
  };
}

function createScrollBootstrapWithManyFiles(fileCount: number): AppBootstrap {
  const files: DiffFile[] = [];

  for (let i = 0; i < fileCount; i++) {
    const before = Array.from(
      { length: 50 },
      (_, j) => `export const line${String(j + 1).padStart(2, "0")} = ${j + 1};`,
    ).join("\n");

    const after = Array.from({ length: 50 }, (_, j) => {
      if (j === 25) {
        return `export const line${String(j + 1).padStart(2, "0")} = ${j + 100}; // modified`;
      }
      return `export const line${String(j + 1).padStart(2, "0")} = ${j + 1};`;
    }).join("\n");

    files.push(createDiffFile(`file-${i}`, `src/file-${i}.ts`, before, after));
  }

  return {
    reloadContext: { cwd: process.cwd() },
    input: {
      kind: "vcs",
      staged: false,
      options: {
        mode: "split",
      },
    },
    changeset: {
      id: "scroll-test",
      sourceLabel: "repo",
      title: "test changeset",
      files,
    },
    initialMode: "split",
    initialTheme: "github-dark-default",
  };
}

async function flush(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await setup.renderOnce();
    await Bun.sleep(0);
    await setup.renderOnce();
  });
}

/** Return whether the terminal frame contains the requested painted background. */
function frameHasBackground(
  setup: Awaited<ReturnType<typeof testRender>>,
  backgroundColor: string,
  column?: number,
) {
  return setup.captureSpans().lines.some((line) => {
    let spanStart = 0;
    return line.spans.some((span) => {
      const spanEnd = spanStart + span.width;
      const includesColumn = column === undefined || (spanStart <= column && column < spanEnd);
      spanStart = spanEnd;
      return (
        includesColumn &&
        span.width > 0 &&
        capturedTestColorToHex(span.bg)?.toLowerCase() === backgroundColor.toLowerCase()
      );
    });
  });
}

/** Create an observable scroll target for direct scrollbar interaction tests. */
function createTestScrollRef(scrollTop = 0, height = 10) {
  const positions: number[] = [];
  const scrollRef = createRef<{
    scrollTop: number;
    scrollTo: (y: number) => void;
    viewport: { height: number };
  }>();
  scrollRef.current = {
    scrollTop,
    scrollTo: (y) => {
      positions.push(y);
      if (scrollRef.current) {
        scrollRef.current.scrollTop = y;
      }
    },
    viewport: { height },
  };
  return { positions, scrollRef };
}

type ScheduledTask = {
  callback: () => void;
  canceled: boolean;
  delayMs: number;
  dueAt: number;
};

/** Provides deterministic scrollbar timer control without replacing renderer timers. */
class TestScrollbarScheduler implements VerticalScrollbarScheduler {
  readonly cleared: number[] = [];
  readonly tasks = new Map<number, ScheduledTask>();
  private nextId = 1;
  private now = 0;

  setTimeout(callback: () => void, delayMs: number) {
    const id = this.nextId++;
    this.tasks.set(id, {
      callback,
      canceled: false,
      delayMs,
      dueAt: this.now + delayMs,
    });
    return id;
  }

  clearTimeout(handle: unknown) {
    const id = handle as number;
    this.cleared.push(id);
    const task = this.tasks.get(id);
    if (task) task.canceled = true;
  }

  /** Runs active callbacks due within the requested time window. */
  advance(durationMs: number) {
    this.now += durationMs;
    const due = [...this.tasks.entries()]
      .filter(([, task]) => task.dueAt <= this.now)
      .sort(([leftId, left], [rightId, right]) => left.dueAt - right.dueAt || leftId - rightId);
    for (const [id, task] of due) {
      this.tasks.delete(id);
      if (!task.canceled) task.callback();
    }
  }

  /** Delivers a callback even when cancellation already marked it stale. */
  forceFire(id: number) {
    this.tasks.get(id)?.callback();
  }
}

/** Wait until input produces a new rendered review frame. */
async function waitForFrameChange(
  setup: Awaited<ReturnType<typeof testRender>>,
  previousFrame: string,
) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const frame = setup.captureCharFrame();
    if (frame !== previousFrame) {
      return frame;
    }

    await act(async () => {
      await Bun.sleep(5);
      await setup.renderOnce();
    });
  }

  throw new Error("Timed out waiting for scroll input to change the rendered review frame.");
}

describe("Vertical scrollbar", () => {
  test("shows scrollbar when content exceeds viewport height", async () => {
    const theme = resolveTheme("github-dark-default", null);
    const handle = createRef<VerticalScrollbarHandle>();
    const { scrollRef } = createTestScrollRef();
    const setup = await testRender(
      <VerticalScrollbar
        ref={handle}
        scrollRef={scrollRef}
        contentHeight={40}
        theme={theme}
        height={10}
      />,
      { width: 2, height: 10 },
    );

    try {
      await flush(setup);
      expect(frameHasBackground(setup, theme.accentMuted)).toBe(false);

      await act(async () => {
        handle.current?.show();
      });
      await flush(setup);

      expect(frameHasBackground(setup, theme.accentMuted)).toBe(true);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("hides scrollbar after scroll activity stops", async () => {
    const theme = resolveTheme("github-dark-default", null);
    const handle = createRef<VerticalScrollbarHandle>();
    const scheduler = new TestScrollbarScheduler();
    const { scrollRef } = createTestScrollRef();
    const setup = await testRender(
      <VerticalScrollbar
        ref={handle}
        scrollRef={scrollRef}
        contentHeight={40}
        theme={theme}
        height={10}
        hideDelayMs={120}
        scheduler={scheduler}
      />,
      { width: 2, height: 10 },
    );

    try {
      await flush(setup);
      expect(frameHasBackground(setup, theme.accentMuted)).toBe(false);

      await act(async () => {
        handle.current?.show();
      });
      await flush(setup);
      expect(scheduler.tasks.get(1)?.delayMs).toBe(120);
      expect(frameHasBackground(setup, theme.accentMuted)).toBe(true);

      await act(async () => scheduler.advance(119));
      await flush(setup);
      expect(frameHasBackground(setup, theme.accentMuted)).toBe(true);

      await act(async () => scheduler.advance(1));
      await flush(setup);
      expect(frameHasBackground(setup, theme.accentMuted)).toBe(false);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("mouse wheel activity scrolls overflowing review content", async () => {
    const bootstrap = createScrollBootstrapWithManyFiles(5);
    const setup = await testRender(<AppHost bootstrap={bootstrap} />, {
      width: 160,
      height: 20,
    });

    try {
      await flush(setup);
      const initialFrame = setup.captureCharFrame();

      await act(async () => {
        await setup.mockMouse.scroll(50, 10, "down");
      });
      await flush(setup);

      const scrolledFrame = await waitForFrameChange(setup, initialFrame);
      // Character frames omit background-only scrollbar cells, so changed review rows prove that
      // the wheel moved visible content rather than merely revealing the scrollbar.
      expect(scrolledFrame.split("\n").slice(2)).not.toEqual(initialFrame.split("\n").slice(2));
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("repeated activity restarts the auto-hide deadline", async () => {
    const theme = resolveTheme("github-dark-default", null);
    const handle = createRef<VerticalScrollbarHandle>();
    const scheduler = new TestScrollbarScheduler();
    const { scrollRef } = createTestScrollRef();
    const setup = await testRender(
      <VerticalScrollbar
        ref={handle}
        scrollRef={scrollRef}
        contentHeight={40}
        theme={theme}
        height={10}
        hideDelayMs={120}
        scheduler={scheduler}
      />,
      { width: 2, height: 10 },
    );

    try {
      await flush(setup);
      await act(async () => handle.current?.show());
      await act(async () => scheduler.advance(100));
      await act(async () => handle.current?.show());
      await flush(setup);

      expect(scheduler.cleared).toEqual([1]);
      await act(async () => scheduler.forceFire(1));
      await flush(setup);
      expect(frameHasBackground(setup, theme.accentMuted)).toBe(true);

      await act(async () => scheduler.advance(119));
      await flush(setup);
      expect(frameHasBackground(setup, theme.accentMuted)).toBe(true);

      await act(async () => scheduler.advance(1));
      await flush(setup);
      expect(frameHasBackground(setup, theme.accentMuted)).toBe(false);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("scrollbar is hidden when content fits in viewport", async () => {
    const theme = resolveTheme("github-dark-default", null);
    const handle = createRef<VerticalScrollbarHandle>();
    const { scrollRef } = createTestScrollRef();
    const setup = await testRender(
      <VerticalScrollbar
        ref={handle}
        scrollRef={scrollRef}
        contentHeight={10}
        theme={theme}
        height={10}
      />,
      { width: 2, height: 10 },
    );

    try {
      await flush(setup);
      await act(async () => {
        handle.current?.show();
      });
      await flush(setup);

      expect(frameHasBackground(setup, theme.accentMuted)).toBe(false);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("thumb drag scrolls content and restarts auto-hide after release", async () => {
    const theme = resolveTheme("github-dark-default", null);
    const handle = createRef<VerticalScrollbarHandle>();
    const scheduler = new TestScrollbarScheduler();
    const { positions, scrollRef } = createTestScrollRef();
    const setup = await testRender(
      <VerticalScrollbar
        ref={handle}
        scrollRef={scrollRef}
        contentHeight={100}
        theme={theme}
        height={10}
        hideDelayMs={120}
        scheduler={scheduler}
      />,
      { width: 2, height: 10 },
    );

    try {
      await flush(setup);
      await act(async () => {
        handle.current?.show();
      });
      await flush(setup);

      await act(async () => {
        await setup.mockMouse.drag(1, 0, 1, 4);
      });
      await flush(setup);

      expect(positions.at(-1)).toBeCloseTo(45, 0);
      expect([...scheduler.tasks.values()].filter((task) => !task.canceled)).toHaveLength(1);

      await act(async () => scheduler.advance(119));
      await flush(setup);
      expect(frameHasBackground(setup, theme.accentMuted)).toBe(true);

      await act(async () => scheduler.advance(1));
      await flush(setup);
      expect(frameHasBackground(setup, theme.accentMuted)).toBe(false);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("track click scrolls by one viewport", async () => {
    const theme = resolveTheme("github-dark-default", null);
    const handle = createRef<VerticalScrollbarHandle>();
    const { positions, scrollRef } = createTestScrollRef(20);
    const setup = await testRender(
      <VerticalScrollbar
        ref={handle}
        scrollRef={scrollRef}
        contentHeight={100}
        theme={theme}
        height={10}
      />,
      { width: 2, height: 10 },
    );

    try {
      await flush(setup);
      await act(async () => {
        handle.current?.show();
      });
      await flush(setup);

      await act(async () => {
        await setup.mockMouse.click(1, 8);
      });
      await flush(setup);
      expect(positions.at(-1)).toBe(30);

      await act(async () => {
        await setup.mockMouse.click(1, 0);
      });
      await flush(setup);
      expect(positions.at(-1)).toBe(10);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("handles edge case when content barely exceeds viewport", async () => {
    const theme = resolveTheme("github-dark-default", null);
    const handle = createRef<VerticalScrollbarHandle>();
    const { positions, scrollRef } = createTestScrollRef();
    const setup = await testRender(
      <VerticalScrollbar
        ref={handle}
        scrollRef={scrollRef}
        contentHeight={11}
        theme={theme}
        height={10}
      />,
      { width: 2, height: 10 },
    );

    try {
      await flush(setup);
      await act(async () => {
        handle.current?.show();
      });
      await flush(setup);

      await act(async () => {
        await setup.mockMouse.drag(1, 0, 1, 5);
      });
      await flush(setup);

      expect(positions.at(-1)).toBe(1);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });
});
