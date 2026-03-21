import { describe, expect, mock, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { parseDiffFromFile } from "@pierre/diffs";
import { act } from "react";
import type { AppBootstrap, DiffFile, LayoutMode } from "../src/core/types";

const { App } = await import("../src/ui/App");

function createDiffFile(id: string, path: string, before: string, after: string, withAgent = false): DiffFile {
  const metadata = parseDiffFromFile(
    {
      name: path,
      contents: before,
      cacheKey: `${id}:before`,
    },
    {
      name: path,
      contents: after,
      cacheKey: `${id}:after`,
    },
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
    stats: {
      additions,
      deletions,
    },
    metadata,
    agent: withAgent
      ? {
          path,
          summary: `${path} note`,
          annotations: [{ newRange: [2, 2], summary: `Annotation for ${path}` }],
        }
      : null,
  };
}

function createBootstrap(initialMode: LayoutMode = "auto", pager = false): AppBootstrap {
  return {
    input: {
      kind: "git",
      staged: false,
      options: {
        mode: initialMode,
        pager,
      },
    },
    changeset: {
      id: "changeset:responsive",
      sourceLabel: "repo",
      title: "repo working tree",
      summary: "Patch summary",
      agentSummary: "Changeset summary",
      files: [
        createDiffFile("alpha", "alpha.ts", "export const alpha = 1;\n", "export const alpha = 2;\nexport const add = true;\n", true),
        createDiffFile("beta", "beta.ts", "export const beta = 1;\n", "export const betaValue = 1;\n", false),
      ],
    },
    initialMode,
    initialTheme: "midnight",
  };
}

async function captureFrameForBootstrap(bootstrap: AppBootstrap, width: number, height = 24) {
  const setup = await testRender(<App bootstrap={bootstrap} />, { width, height });

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
  const setup = await testRender(<App bootstrap={createBootstrap()} />, { width: 280, height: 24 });

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

describe("responsive shell", () => {
  test("App adjusts the visible panes and diff layout on live resize", async () => {
    const { ultraWide, full, medium, tight } = await captureResponsiveFrames();

    expect(ultraWide).toContain("M alpha.ts");
    expect(ultraWide).not.toContain("Changeset summary");

    expect(full).toContain("M alpha.ts");
    expect(full).not.toContain("Changeset summary");
    expect(full).toContain("drag divider resize");
    expect(full).toMatch(/▌.*▌/);

    expect(medium).not.toContain("Files");
    expect(medium).not.toContain("Changeset summary");
    expect(medium).toMatch(/▌.*▌/);
    expect(medium).not.toContain("drag divider resize");

    expect(tight).not.toContain("Files");
    expect(tight).not.toContain("Changeset summary");
    expect(tight).not.toMatch(/▌.*▌/);
    expect(tight).not.toContain("drag divider resize");
  });

  test("explicit split and stack modes override responsive auto switching", async () => {
    const forcedSplit = await captureFrameForBootstrap(createBootstrap("split"), 140);
    const forcedStack = await captureFrameForBootstrap(createBootstrap("stack"), 240);

    expect(forcedSplit).not.toContain("Files");
    expect(forcedSplit).not.toContain("Changeset summary");
    expect(forcedSplit).toMatch(/▌.*▌/);
    expect(forcedSplit).not.toContain("drag divider resize");

    expect(forcedStack).not.toContain("Files");
    expect(forcedStack).not.toContain("Changeset summary");
    expect(forcedStack).not.toMatch(/▌.*▌/);
    expect(forcedStack).not.toContain("drag divider resize");
  });

  test("pager mode stays responsive while hiding app chrome", async () => {
    const wide = await captureFrameForBootstrap(createBootstrap("auto", true), 220);
    const narrow = await captureFrameForBootstrap(createBootstrap("auto", true), 150);

    expect(wide).not.toContain("File  View  Navigate  Theme  Agent  Help");
    expect(wide).not.toContain("F10 menu");
    expect(wide).not.toContain("M alpha.ts");
    expect(wide).toMatch(/▌.*▌/);

    expect(narrow).not.toContain("File  View  Navigate  Theme  Agent  Help");
    expect(narrow).not.toContain("F10 menu");
    expect(narrow).not.toContain("M alpha.ts");
    expect(narrow).not.toMatch(/▌.*▌/);
  });

  test("filter focus suppresses global shortcut keys like quit", async () => {
    const originalExit = process.exit;
    const exitMock = mock(() => undefined as never);
    (process as typeof process & { exit: typeof exitMock }).exit = exitMock;

    const setup = await testRender(<App bootstrap={createBootstrap()} />, { width: 240, height: 24 });

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
