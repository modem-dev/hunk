import { describe, expect, mock, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { AppBootstrap, LayoutMode } from "../core/types";
import { createTestGitAppBootstrap } from "../../test/helpers/app-bootstrap";
import { createTestDiffFile } from "../../test/helpers/diff-helpers";

const { AppHost } = await import("./AppHost");

function createBootstrap(initialMode: LayoutMode = "auto", pager = false): AppBootstrap {
  return createTestGitAppBootstrap({
    agentSummary: "Changeset summary",
    changesetId: "changeset:responsive",
    files: [
      createTestDiffFile({
        after: "export const alpha = 2;\nexport const add = true;\n",
        agent: true,
        before: "export const alpha = 1;\n",
        context: 3,
        id: "alpha",
        path: "alpha.ts",
      }),
      createTestDiffFile({
        after: "export const betaValue = 1;\n",
        before: "export const beta = 1;\n",
        context: 3,
        id: "beta",
        path: "beta.ts",
      }),
    ],
    initialMode,
    pager,
    summary: "Patch summary",
  });
}

async function captureFrameForBootstrap(bootstrap: AppBootstrap, width: number, height = 24) {
  const setup = await testRender(<AppHost bootstrap={bootstrap} />, { width, height });

  try {
    await act(async () => {
      await setup.renderOnce();
    });

    return setup.captureCharFrame();
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
}

async function captureResponsiveFrames() {
  const setup = await testRender(<AppHost bootstrap={createBootstrap()} />, {
    width: 280,
    height: 24,
  });

  try {
    await act(async () => {
      await setup.renderOnce();
    });
    const ultraWide = setup.captureCharFrame();

    await act(async () => {
      setup.resize(220, 24);
      await setup.renderOnce();
    });
    const full = setup.captureCharFrame();

    await act(async () => {
      setup.resize(160, 24);
      await setup.renderOnce();
    });
    const medium = setup.captureCharFrame();

    await act(async () => {
      setup.resize(159, 24);
      await setup.renderOnce();
    });
    const tight = setup.captureCharFrame();

    return { ultraWide, full, medium, tight };
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
}

describe("responsive app", () => {
  test("App adjusts the visible panes and diff layout on live resize", async () => {
    const { ultraWide, full, medium, tight } = await captureResponsiveFrames();

    expect((ultraWide.match(/alpha\.ts/g) ?? []).length).toBe(2);
    expect(ultraWide).not.toContain("Changeset summary");

    expect((full.match(/alpha\.ts/g) ?? []).length).toBe(2);
    expect(full).not.toContain("Changeset summary");
    expect(full).toMatch(/▌.*▌/);

    expect(medium).not.toContain("Files");
    expect(medium).not.toContain("Changeset summary");
    expect(medium).toMatch(/▌.*▌/);

    expect(tight).not.toContain("Files");
    expect(tight).not.toContain("Changeset summary");
    expect(tight).not.toMatch(/▌.*▌/);
  });

  test("explicit split and stack modes override responsive auto switching", async () => {
    const forcedSplit = await captureFrameForBootstrap(createBootstrap("split"), 140);
    const forcedStack = await captureFrameForBootstrap(createBootstrap("stack"), 240);

    expect(forcedSplit).not.toContain("Files");
    expect(forcedSplit).not.toContain("Changeset summary");
    expect(forcedSplit).toMatch(/▌.*▌/);

    expect((forcedStack.match(/alpha\.ts/g) ?? []).length).toBe(2);
    expect(forcedStack).not.toContain("Changeset summary");
    expect(forcedStack).not.toMatch(/▌.*▌/);
  });

  test("pager mode stays responsive while hiding app chrome", async () => {
    const wide = await captureFrameForBootstrap(createBootstrap("auto", true), 220);
    const narrow = await captureFrameForBootstrap(createBootstrap("auto", true), 150);

    expect(wide).not.toContain("File  View  Navigate  Theme  Agent  Help");
    expect(wide).not.toContain("F10 menu");
    expect((wide.match(/alpha\.ts/g) ?? []).length).toBe(1);
    expect(wide).toMatch(/▌.*▌/);

    expect(narrow).not.toContain("File  View  Navigate  Theme  Agent  Help");
    expect(narrow).not.toContain("F10 menu");
    expect((narrow.match(/alpha\.ts/g) ?? []).length).toBe(1);
    expect(narrow).not.toMatch(/▌.*▌/);
  });

  test("filter focus suppresses global shortcut keys like quit", async () => {
    const originalExit = process.exit;
    const exitMock = mock(() => undefined as never);
    (process as typeof process & { exit: typeof exitMock }).exit = exitMock;

    const setup = await testRender(<AppHost bootstrap={createBootstrap()} />, {
      width: 240,
      height: 24,
    });

    try {
      await act(async () => {
        await setup.renderOnce();
        await setup.mockInput.pressTab();
        await setup.renderOnce();
      });

      await act(async () => {
        await setup.mockInput.typeText("q");
        await setup.renderOnce();
      });

      const frame = setup.captureCharFrame();
      expect(exitMock).not.toHaveBeenCalled();
      expect(frame).toContain("filter:");
      expect(frame).toContain("q");
    } finally {
      (process as typeof process & { exit: typeof originalExit }).exit = originalExit;
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });
});
