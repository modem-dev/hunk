import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { AppBootstrap } from "../core/bootstrap";
import type { SidebarVisibility } from "../core/run/commandInputs";
import { createTestVcsAppBootstrap } from "../../../../test/helpers/app-bootstrap";
import {
  createTestDiffFile as buildTestDiffFile,
  lines,
} from "../../../../test/helpers/diff-helpers";
import { HUNK_FILES_PANE_KEY } from "../extensions/extensionIds";
import { createEmptyExtensionLoadResult } from "../extensions/types";

const { AppHost } = await import("./AppHost");

/** Wide enough for the responsive layout to show the sidebar on its own. */
const WIDE = { width: 240, height: 24 };
/** Uses the compact file projection while keeping split review geometry. */
const MEDIUM = { width: 180, height: 24 };
/** Hides the sidebar automatically while still leaving enough room to force it open. */
const TIGHT = { width: 120, height: 24 };

function createSidebarBootstrap(initialSidebar?: SidebarVisibility): AppBootstrap {
  return {
    ...createTestVcsAppBootstrap({
      changesetId: "changeset:sidebar-visibility",
      initialMode: "split",
      files: [
        buildTestDiffFile({
          after: lines("export const a = 10;"),
          agent: false,
          before: lines("export const a = 1;"),
          context: 3,
          id: "alpha",
          path: "src/ui/alpha.ts",
        }),
      ],
    }),
    initialSidebar,
  };
}

/** Add an independent pane plus a replacement for the built-in files pane. */
function createExtensionSidebarBootstrap(initialSidebar: SidebarVisibility): AppBootstrap {
  const extensions = createEmptyExtensionLoadResult();
  extensions.registry.panes.push(
    {
      extensionId: "activity-test",
      pane: {
        id: "activity",
        title: "Activity",
        placement: "right",
        defaultOpen: true,
        component: () => <text content="ACTIVITY PANE" />,
      },
    },
    {
      extensionId: "replacement-test",
      pane: {
        id: "files",
        title: "Replacement files",
        replaces: HUNK_FILES_PANE_KEY,
        component: () => <text content="REPLACEMENT FILES" />,
      },
    },
  );
  return { ...createSidebarBootstrap(initialSidebar), extensions };
}

/** Drive one or two render passes so pending state commits land before assertions. */
async function flush(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await setup.renderOnce();
    await Bun.sleep(0);
    await setup.renderOnce();
  });
}

/** Return only the columns before the left pane divider. */
function sidebarFrame(setup: Awaited<ReturnType<typeof testRender>>) {
  return setup
    .captureCharFrame()
    .split("\n")
    .map((line) => line.split("│", 1)[0])
    .join("\n");
}

/** Whether file navigation duplicates the selected file beside its review header. */
function sidebarVisible(setup: Awaited<ReturnType<typeof testRender>>) {
  return (setup.captureCharFrame().match(/alpha\.ts/g) ?? []).length > 1;
}

let setup: Awaited<ReturnType<typeof testRender>> | null = null;

beforeEach(() => {
  setup = null;
});

afterEach(() => {
  setup?.renderer.destroy();
  setup = null;
});

describe("AppHost sidebar visibility preference", () => {
  test("auto shows the sidebar on a full-width viewport", async () => {
    setup = await testRender(<AppHost bootstrap={createSidebarBootstrap("auto")} />, WIDE);
    await flush(setup);

    expect(sidebarVisible(setup)).toBe(true);
    expect(sidebarFrame(setup)).not.toContain("src/ui/");
  });

  test("auto shows the compact sidebar on a medium-width viewport", async () => {
    setup = await testRender(<AppHost bootstrap={createSidebarBootstrap("auto")} />, MEDIUM);
    await flush(setup);

    expect(sidebarVisible(setup)).toBe(true);
    expect(sidebarFrame(setup)).toContain("src/ui/");
  });

  test("auto hides the sidebar on a tight viewport", async () => {
    setup = await testRender(<AppHost bootstrap={createSidebarBootstrap("auto")} />, TIGHT);
    await flush(setup);

    expect(sidebarVisible(setup)).toBe(false);
  });

  test("the toggle forces the sidebar open where auto hides it", async () => {
    setup = await testRender(<AppHost bootstrap={createSidebarBootstrap("auto")} />, TIGHT);
    await flush(setup);
    expect(sidebarVisible(setup)).toBe(false);

    await act(async () => {
      setup!.mockInput.pressKey("s");
    });
    await flush(setup);
    expect(sidebarVisible(setup)).toBe(true);

    // A second press closes it again rather than returning to the responsive default.
    await act(async () => {
      setup!.mockInput.pressKey("s");
    });
    await flush(setup);
    expect(sidebarVisible(setup)).toBe(false);
  });

  test("true shows the sidebar where auto would hide it", async () => {
    setup = await testRender(<AppHost bootstrap={createSidebarBootstrap(true)} />, TIGHT);
    await flush(setup);

    expect(sidebarVisible(setup)).toBe(true);
  });

  test("false starts the sidebar closed but leaves the toggle working", async () => {
    setup = await testRender(<AppHost bootstrap={createSidebarBootstrap(false)} />, WIDE);
    await flush(setup);
    expect(sidebarVisible(setup)).toBe(false);

    await act(async () => {
      setup!.mockInput.pressKey("s");
    });
    await flush(setup);

    expect(sidebarVisible(setup)).toBe(true);
  });

  test("false closes only the active files pane and preserves independent extension panes", async () => {
    setup = await testRender(<AppHost bootstrap={createExtensionSidebarBootstrap(false)} />, WIDE);
    await flush(setup);

    expect(setup.captureCharFrame()).toContain("ACTIVITY PANE");
    expect(setup.captureCharFrame()).not.toContain("REPLACEMENT FILES");

    await act(async () => {
      setup!.mockInput.pressKey("s");
    });
    await flush(setup);

    expect(setup.captureCharFrame()).toContain("ACTIVITY PANE");
    expect(setup.captureCharFrame()).toContain("REPLACEMENT FILES");
  });
});
