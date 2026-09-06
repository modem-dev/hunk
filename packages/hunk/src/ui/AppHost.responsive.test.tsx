import { describe, expect, mock, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { AppBootstrap } from "../core/bootstrap";
import type { LayoutMode } from "../core/run/commandInputs";
import { createTestVcsAppBootstrap } from "../../../../test/helpers/app-bootstrap";
import { createTestDiffFile } from "../../../../test/helpers/diff-helpers";

const { AppHost } = await import("./AppHost");

function createBootstrap(initialMode: LayoutMode = "auto", pager = false): AppBootstrap {
  return createTestVcsAppBootstrap({
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
    const narrow = setup.captureCharFrame();

    await act(async () => {
      setup.resize(119, 24);
      await setup.renderOnce();
    });
    const tight = setup.captureCharFrame();

    return { ultraWide, full, medium, narrow, tight };
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
}

describe("responsive app", () => {
  test("App adjusts the visible panes and diff layout on live resize", async () => {
    const { ultraWide, full, medium, narrow, tight } = await captureResponsiveFrames();

    expect((ultraWide.match(/alpha\.ts/g) ?? []).length).toBe(2);
    expect(ultraWide).not.toContain("Changeset summary");

    expect((full.match(/alpha\.ts/g) ?? []).length).toBe(2);
    expect(full).not.toContain("Changeset summary");
    expect(full).toMatch(/▌.*▌/);

    expect((medium.match(/alpha\.ts/g) ?? []).length).toBe(2);
    expect(medium).not.toContain("Changeset summary");
    expect(medium).toMatch(/▌.*▌/);

    expect((narrow.match(/alpha\.ts/g) ?? []).length).toBe(1);
    expect(narrow).not.toContain("Changeset summary");
    expect(narrow).toMatch(/▌.*▌/);

    expect((tight.match(/alpha\.ts/g) ?? []).length).toBe(1);
    expect(tight).not.toContain("Changeset summary");
    expect(tight).not.toMatch(/▌.*▌/);
  });

  test("narrow viewports keep file stats visible and mark truncated paths with three dots", async () => {
    const bootstrap = createTestVcsAppBootstrap({
      changesetId: "changeset:narrow-header",
      files: [
        createTestDiffFile({
          after: "export const value = 2;\n",
          before: "export const value = 1;\n",
          id: "narrow-header",
          path: "packages/visual-studio-code-vscode/extension-postgres.ts",
        }),
      ],
      initialMode: "auto",
    });

    const frame = await captureFrameForBootstrap(bootstrap, 40, 12);

    expect(frame).toContain("packages/visual-studio-cod... +1 -1");
    expect(frame).not.toContain("packages/visual-studio-code-.");
  });

  test("View menu sidebar checkmark follows actual medium-viewport visibility", async () => {
    const setup = await testRender(<AppHost bootstrap={createBootstrap("auto")} />, {
      width: 180,
      height: 24,
    });

    try {
      await act(async () => {
        await setup.renderOnce();
      });

      const initialFrame = setup.captureCharFrame();
      expect((initialFrame.match(/alpha\.ts/g) ?? []).length).toBe(2);

      await act(async () => {
        await setup.mockInput.pressKey("F10");
      });
      await act(async () => {
        await setup.renderOnce();
      });
      await act(async () => {
        await setup.mockInput.pressArrow("right");
      });
      await act(async () => {
        await setup.renderOnce();
      });

      const menuFrame = setup.captureCharFrame();
      expect(menuFrame).toContain("[x] Files pane");
      expect(menuFrame).not.toContain("[ ] Files pane");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("sidebar shortcut opens the hidden sidebar on a tight viewport", async () => {
    const setup = await testRender(<AppHost bootstrap={createBootstrap("auto")} />, {
      width: 140,
      height: 24,
    });

    try {
      await act(async () => {
        await setup.renderOnce();
      });

      let frame = setup.captureCharFrame();
      expect((frame.match(/alpha\.ts/g) ?? []).length).toBe(1);

      await act(async () => {
        await setup.mockInput.typeText("s");
      });
      await act(async () => {
        await setup.renderOnce();
      });

      frame = setup.captureCharFrame();
      expect((frame.match(/alpha\.ts/g) ?? []).length).toBe(2);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
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
    const tight = await captureFrameForBootstrap(createBootstrap("auto", true), 110);

    expect(wide).not.toContain("File  View  Navigate  Agent  Help");
    expect(wide).not.toContain("F10 menu");
    expect((wide.match(/alpha\.ts/g) ?? []).length).toBe(1);
    expect(wide).toMatch(/▌.*▌/);

    expect(narrow).not.toContain("File  View  Navigate  Agent  Help");
    expect(narrow).not.toContain("F10 menu");
    expect((narrow.match(/alpha\.ts/g) ?? []).length).toBe(1);
    expect(narrow).toMatch(/▌.*▌/);

    expect(tight).not.toContain("File  View  Navigate  Agent  Help");
    expect(tight).not.toContain("F10 menu");
    expect((tight.match(/alpha\.ts/g) ?? []).length).toBe(1);
    expect(tight).not.toMatch(/▌.*▌/);
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
