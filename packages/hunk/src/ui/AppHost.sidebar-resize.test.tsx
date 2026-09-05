import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { AppBootstrap } from "../core/bootstrap";
import { createTestVcsAppBootstrap } from "../../../../test/helpers/app-bootstrap";
import {
  createTestDiffFile as buildTestDiffFile,
  lines,
} from "../../../../test/helpers/diff-helpers";
import { createEmptyExtensionLoadResult } from "../extensions/types";

const { AppHost } = await import("./AppHost");

/** A wide terminal so the responsive layout always shows the resizable sidebar. */
const WIDE = { width: 240, height: 24 };
// At 240 columns the 16% responsive pane is 38 cells; body padding puts its divider at 39.
const INITIAL_DIVIDER_COLUMN = 39;
// A stable mid-height row that always falls inside the sidebar/divider band.
const PROBE_ROW = 10;

function createTestDiffFile(id: string, path: string, before: string, after: string) {
  return buildTestDiffFile({ after, agent: false, before, context: 3, id, path });
}

/** Two-file split-view bootstrap whose sidebar is wide enough to drag. */
function createResizeBootstrap(): AppBootstrap {
  return createTestVcsAppBootstrap({
    changesetId: "changeset:sidebar-resize",
    initialMode: "split",
    files: [
      createTestDiffFile(
        "alpha",
        "src/ui/alpha.ts",
        lines("export const a = 1;", "export const b = 2;"),
        lines("export const a = 10;", "export const b = 2;"),
      ),
      createTestDiffFile(
        "beta",
        "src/ui/beta.ts",
        lines("export const c = 3;"),
        lines("export const c = 30;"),
      ),
    ],
  });
}

/** Add one resizable top pane through the same registry user extensions populate. */
function createTopPaneResizeBootstrap(): AppBootstrap {
  const extensions = createEmptyExtensionLoadResult();
  extensions.registry.panes.push({
    extensionId: "resize-test",
    pane: {
      id: "top",
      placement: "top",
      defaultOpen: true,
      height: { preferred: 4, min: 2, max: 8 },
      component: ({ width, height }) => <text content={`TOP PANE ${width}x${height}`} />,
    },
  });
  return { ...createResizeBootstrap(), extensions, initialSidebar: false };
}

/** Drive one or two render passes so pending state commits land before assertions. */
async function flush(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await setup.renderOnce();
    await Bun.sleep(0);
    await setup.renderOnce();
  });
}

/** Column of the vertical sidebar/diff divider on the probe row, or -1 when absent. */
function dividerColumn(setup: Awaited<ReturnType<typeof testRender>>) {
  const row = setup.captureCharFrame().split("\n")[PROBE_ROW] ?? "";
  return row.indexOf("│");
}

/** Return only the file-sidebar columns so diff headers cannot satisfy sidebar assertions. */
function sidebarFrame(setup: Awaited<ReturnType<typeof testRender>>) {
  const divider = dividerColumn(setup);
  return setup
    .captureCharFrame()
    .split("\n")
    .map((line) => line.slice(0, divider))
    .join("\n");
}

/**
 * Press the divider, drag to a target x, then release. The resize handlers read React state
 * (`isResizingSidebar`), so each phase needs its own commit before the next event's closure sees
 * the updated state — hence the flush between press, drag, and release.
 */
async function dragDivider(
  setup: Awaited<ReturnType<typeof testRender>>,
  fromX: number,
  toX: number,
) {
  await act(async () => {
    await setup.mockMouse.pressDown(fromX, PROBE_ROW);
  });
  await flush(setup);
  await act(async () => {
    await setup.mockMouse.moveTo(toX, PROBE_ROW);
  });
  await flush(setup);
  await act(async () => {
    await setup.mockMouse.release(toX, PROBE_ROW);
  });
  await flush(setup);
}

/** Drag a horizontal divider on its row axis. */
async function dragHorizontalDivider(
  setup: Awaited<ReturnType<typeof testRender>>,
  fromY: number,
  toY: number,
) {
  const x = Math.floor(WIDE.width / 2);
  await act(async () => {
    await setup.mockMouse.pressDown(x, fromY);
  });
  await flush(setup);
  await act(async () => {
    await setup.mockMouse.moveTo(x, toY);
  });
  await flush(setup);
  await act(async () => {
    await setup.mockMouse.release(x, toY);
  });
  await flush(setup);
}

let setup: Awaited<ReturnType<typeof testRender>> | null = null;

beforeEach(() => {
  setup = null;
});

afterEach(() => {
  setup?.renderer.destroy();
  setup = null;
});

describe("AppHost sidebar resize", () => {
  test("resizes the default sidebar with the terminal until the user drags it", async () => {
    setup = await testRender(<AppHost bootstrap={createResizeBootstrap()} />, WIDE);
    await flush(setup);
    expect(dividerColumn(setup)).toBe(INITIAL_DIVIDER_COLUMN);

    await act(async () => setup!.resize(300, WIDE.height));
    await flush(setup);
    expect(dividerColumn(setup)).toBe(49);

    await act(async () => setup!.resize(220, WIDE.height));
    await flush(setup);
    expect(dividerColumn(setup)).toBe(36);

    await act(async () => setup!.resize(360, WIDE.height));
    await flush(setup);
    expect(dividerColumn(setup)).toBe(57);
  });

  test("dragging the divider rightward widens the sidebar", async () => {
    setup = await testRender(<AppHost bootstrap={createResizeBootstrap()} />, WIDE);
    await flush(setup);
    expect(dividerColumn(setup)).toBe(INITIAL_DIVIDER_COLUMN);

    await dragDivider(setup, INITIAL_DIVIDER_COLUMN, INITIAL_DIVIDER_COLUMN + 30);

    // The divider follows the new width: startWidth + (currentX - originX).
    expect(dividerColumn(setup)).toBeGreaterThan(INITIAL_DIVIDER_COLUMN);
  });

  test("resizing across the content-width threshold switches the file projection", async () => {
    setup = await testRender(<AppHost bootstrap={createResizeBootstrap()} />, WIDE);
    await flush(setup);
    expect(sidebarFrame(setup)).not.toContain("src/ui/");

    // Raw pane width 33 leaves 31 content columns, just below the preferred tree width.
    await dragDivider(setup, INITIAL_DIVIDER_COLUMN, 34);

    expect(sidebarFrame(setup)).toContain("src/ui/");
  });

  test("dragging the divider far left clamps the sidebar at its minimum width", async () => {
    setup = await testRender(<AppHost bootstrap={createResizeBootstrap()} />, WIDE);
    await flush(setup);

    await dragDivider(setup, INITIAL_DIVIDER_COLUMN, 2);

    // SIDEBAR_MIN_WIDTH is 22, plus the 1-column body padding => divider clamps at column 23.
    expect(dividerColumn(setup)).toBe(23);
  });

  test("dragging a horizontal divider resizes a top pane on the row axis", async () => {
    setup = await testRender(<AppHost bootstrap={createTopPaneResizeBootstrap()} />, WIDE);
    await flush(setup);
    expect(setup.captureCharFrame()).toContain("TOP PANE 238x4");

    // Menu row 0, four pane rows 1-4, divider row 5.
    await dragHorizontalDivider(setup, 5, 8);

    expect(setup.captureCharFrame()).toContain("TOP PANE 238x7");
  });

  test("a mouse release with no active drag leaves the layout unchanged", async () => {
    setup = await testRender(<AppHost bootstrap={createResizeBootstrap()} />, WIDE);
    await flush(setup);
    const before = setup.captureCharFrame();

    await act(async () => {
      await setup!.mockMouse.release(INITIAL_DIVIDER_COLUMN + 40, PROBE_ROW);
    });
    await flush(setup);

    expect(setup.captureCharFrame()).toBe(before);
    expect(dividerColumn(setup)).toBe(INITIAL_DIVIDER_COLUMN);
  });

  test("a non-left mouse button on the divider does not start a resize", async () => {
    setup = await testRender(<AppHost bootstrap={createResizeBootstrap()} />, WIDE);
    await flush(setup);

    // Right button (2) should be ignored by beginSidebarResize.
    await act(async () => {
      await setup!.mockMouse.pressDown(INITIAL_DIVIDER_COLUMN, PROBE_ROW, 2);
    });
    await flush(setup);
    await act(async () => {
      await setup!.mockMouse.moveTo(INITIAL_DIVIDER_COLUMN + 30, PROBE_ROW);
    });
    await flush(setup);
    await act(async () => {
      await setup!.mockMouse.release(INITIAL_DIVIDER_COLUMN + 30, PROBE_ROW, 2);
    });
    await flush(setup);

    expect(dividerColumn(setup)).toBe(INITIAL_DIVIDER_COLUMN);
  });
});
