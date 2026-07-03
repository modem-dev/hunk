import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { AppBootstrap } from "../core/types";
import { createTestVcsAppBootstrap } from "../../test/helpers/app-bootstrap";
import { createTestDiffFile as buildTestDiffFile, lines } from "../../test/helpers/diff-helpers";

const { AppHost } = await import("./AppHost");

/** A wide terminal so the responsive layout always shows the resizable sidebar. */
const WIDE = { width: 240, height: 24 };
// Default sidebar width (34) plus the body's 1-column left padding puts the divider at column 35.
const INITIAL_DIVIDER_COLUMN = 35;
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
        "src/alpha.ts",
        lines("export const a = 1;", "export const b = 2;"),
        lines("export const a = 10;", "export const b = 2;"),
      ),
      createTestDiffFile(
        "beta",
        "src/beta.ts",
        lines("export const c = 3;"),
        lines("export const c = 30;"),
      ),
    ],
  });
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

let setup: Awaited<ReturnType<typeof testRender>> | null = null;

beforeEach(() => {
  setup = null;
});

afterEach(() => {
  setup?.renderer.destroy();
  setup = null;
});

describe("AppHost sidebar resize", () => {
  test("dragging the divider rightward widens the sidebar", async () => {
    setup = await testRender(<AppHost bootstrap={createResizeBootstrap()} />, WIDE);
    await flush(setup);
    expect(dividerColumn(setup)).toBe(INITIAL_DIVIDER_COLUMN);

    await dragDivider(setup, INITIAL_DIVIDER_COLUMN, INITIAL_DIVIDER_COLUMN + 30);

    // The divider follows the new width: startWidth + (currentX - originX).
    expect(dividerColumn(setup)).toBeGreaterThan(INITIAL_DIVIDER_COLUMN);
  });

  test("dragging the divider far left clamps the sidebar at its minimum width", async () => {
    setup = await testRender(<AppHost bootstrap={createResizeBootstrap()} />, WIDE);
    await flush(setup);

    await dragDivider(setup, INITIAL_DIVIDER_COLUMN, 2);

    // SIDEBAR_MIN_WIDTH is 22, plus the 1-column body padding => divider clamps at column 23.
    expect(dividerColumn(setup)).toBe(23);
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

describe("AppHost edit-selected-file shortcut", () => {
  const originalEditor = process.env.EDITOR;

  beforeEach(() => {
    delete process.env.EDITOR;
  });

  afterEach(() => {
    if (originalEditor === undefined) {
      delete process.env.EDITOR;
    } else {
      process.env.EDITOR = originalEditor;
    }
  });

  test("pressing e with no $EDITOR surfaces a notice instead of crashing", async () => {
    setup = await testRender(<AppHost bootstrap={createResizeBootstrap()} />, WIDE);
    await flush(setup);

    await act(async () => {
      await setup!.mockInput.typeText("e");
    });
    await flush(setup);

    // openSelectedFileInEditor returns "$EDITOR is not set." which shows as a session notice.
    expect(setup.captureCharFrame()).toContain("EDITOR is not set");
  });
});
