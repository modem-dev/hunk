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
    stats: { additions, deletions },
    metadata,
    agent: withAgent
      ? {
          path,
          summary: `${path} note`,
          annotations: [{ newRange: [2, 2], summary: `Annotation for ${path}`, rationale: `Why ${path} changed` }],
        }
      : null,
  };
}

function createBootstrap(initialMode: LayoutMode = "split", pager = false): AppBootstrap {
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
      id: "changeset:app-interactions",
      sourceLabel: "repo",
      title: "repo working tree",
      files: [
        createDiffFile("alpha", "alpha.ts", "export const alpha = 1;\n", "export const alpha = 2;\nexport const add = true;\n", true),
        createDiffFile("beta", "beta.ts", "export const beta = 1;\n", "export const betaValue = 1;\n", false),
      ],
    },
    initialMode,
    initialTheme: "midnight",
  };
}

function createSingleFileBootstrap(): AppBootstrap {
  return {
    input: {
      kind: "git",
      staged: false,
      options: {
        mode: "split",
      },
    },
    changeset: {
      id: "changeset:app-single-file",
      sourceLabel: "repo",
      title: "repo working tree",
      files: [createDiffFile("alpha", "alpha.ts", "export const alpha = 1;\n", "export const alpha = 2;\nexport const add = true;\n", true)],
    },
    initialMode: "split",
    initialTheme: "midnight",
  };
}

function createWrapBootstrap(): AppBootstrap {
  return {
    input: {
      kind: "git",
      staged: false,
      options: {
        mode: "split",
      },
    },
    changeset: {
      id: "changeset:app-wrap-interactions",
      sourceLabel: "repo",
      title: "repo working tree",
      files: [
        createDiffFile(
          "wrap",
          "wrap.ts",
          "export const message = 'short';\n",
          "export const message = 'this is a very long wrapped line for app interaction coverage';\n",
          true,
        ),
      ],
    },
    initialMode: "split",
    initialTheme: "midnight",
  };
}

function createFileScrollBootstrap(): AppBootstrap {
  const files = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"].map((name, index) =>
    createDiffFile(
      name,
      `${name}.ts`,
      `export const ${name}Marker = ${index + 1};\n`,
      `export const ${name}Marker = ${index + 2};\nexport const ${name}Added = true;\n`,
    ),
  );

  return {
    input: {
      kind: "git",
      staged: false,
      options: {
        mode: "auto",
      },
    },
    changeset: {
      id: "changeset:app-file-scroll",
      sourceLabel: "repo",
      title: "repo working tree",
      files,
    },
    initialMode: "auto",
    initialTheme: "midnight",
  };
}

async function flush(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await setup.renderOnce();
    await Bun.sleep(0);
    await setup.renderOnce();
  });
}

function lineIndexOf(frame: string, needle: string) {
  return frame.split("\n").findIndex((line) => line.includes(needle));
}


describe("App interactions", () => {
  test("keyboard shortcuts toggle notes, line numbers, and hunk metadata", async () => {
    const setup = await testRender(<App bootstrap={createSingleFileBootstrap()} />, { width: 240, height: 24 });

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

  test("keyboard shortcut can wrap long lines in the app shell", async () => {
    const setup = await testRender(<App bootstrap={createWrapBootstrap()} />, { width: 140, height: 20 });

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

  test("bootstrap preferences initialize the visible view state", async () => {
    const setup = await testRender(
      <App
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
              createDiffFile(
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
      expect(frame).toContain("Annotation for prefs.ts");
      expect(frame).toContain("long wrapped line");
      expect(frame).toContain("coverage");
      expect(frame).not.toContain("@@ -1,1 +1,2 @@");
      expect(frame).not.toContain("1 - export const message");
      expect(frame).toContain("- export const message");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("menu navigation can switch layouts and activate view actions", async () => {
    const setup = await testRender(<App bootstrap={createBootstrap()} />, { width: 220, height: 24 });

    try {
      await flush(setup);

      await act(async () => {
        setup.mockInput.pressKey("F10");
      });
      await flush(setup);

      let frame = setup.captureCharFrame();
      expect(frame).toContain("Focus files");
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

  test("file navigation changes which file can surface agent notes", async () => {
    const setup = await testRender(<App bootstrap={createBootstrap()} />, { width: 240, height: 24 });

    try {
      await flush(setup);

      await act(async () => {
        await setup.mockInput.pressArrow("down");
      });
      await flush(setup);
      await act(async () => {
        await setup.mockInput.typeText("a");
      });
      await flush(setup);

      let frame = setup.captureCharFrame();
      expect(frame).not.toContain("Annotation for alpha.ts");

      await act(async () => {
        await setup.mockInput.pressArrow("up");
      });
      await flush(setup);

      frame = setup.captureCharFrame();
      expect(frame).toContain("Annotation for alpha.ts");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("arrow-key file navigation scrolls the review pane to the selected file hunk", async () => {
    const setup = await testRender(<App bootstrap={createFileScrollBootstrap()} />, { width: 280, height: 12 });

    try {
      await flush(setup);

      for (let index = 0; index < 4; index += 1) {
        await act(async () => {
          await setup.mockInput.pressArrow("down");
        });
        await flush(setup);
      }

      await act(async () => {
        await Bun.sleep(80);
        await setup.renderOnce();
      });

      const frame = setup.captureCharFrame();
      expect(frame).toContain("M epsilon.ts");
      expect(frame).toContain("epsilon.ts");
      expect(frame).toContain("▌@@ -1,1 +1,2 @@");
      expect(frame).not.toContain("alphaMarker");

      const selectedHunkLine = lineIndexOf(frame, "▌@@ -1,1 +1,2 @@");
      expect(selectedHunkLine).toBeGreaterThanOrEqual(0);
      expect(selectedHunkLine).toBeLessThanOrEqual(8);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("filter focus accepts typed input and narrows the visible file set", async () => {
    const setup = await testRender(<App bootstrap={createBootstrap()} />, { width: 240, height: 24 });

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
    const setup = await testRender(<App bootstrap={createBootstrap()} />, { width: 240, height: 24 });

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
      expect(frame).toContain("M beta.ts");
      expect(frame).not.toContain("M alpha.ts");
      expect(frame).toContain("beta.ts");
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

  test("menu navigation wraps across the first and last top-level menus", async () => {
    const setup = await testRender(<App bootstrap={createBootstrap()} />, { width: 220, height: 24 });

    try {
      await flush(setup);

      await act(async () => {
        setup.mockInput.pressKey("F10");
      });
      await flush(setup);

      let frame = setup.captureCharFrame();
      expect(frame).toContain("Focus files");
      expect(frame).not.toContain("Keyboard help");

      await act(async () => {
        await setup.mockInput.pressArrow("left");
      });
      await flush(setup);

      frame = setup.captureCharFrame();
      expect(frame).toContain("Keyboard help");
      expect(frame).not.toContain("Focus files");

      await act(async () => {
        await setup.mockInput.pressArrow("right");
      });
      await flush(setup);

      frame = setup.captureCharFrame();
      expect(frame).toContain("Focus files");
      expect(frame).not.toContain("Keyboard help");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("sidebar visibility can toggle off and back on", async () => {
    const setup = await testRender(<App bootstrap={createBootstrap()} />, { width: 240, height: 24 });

    try {
      await flush(setup);

      let frame = setup.captureCharFrame();
      expect(frame).toContain("M alpha.ts");

      await act(async () => {
        await setup.mockInput.typeText("s");
      });
      await flush(setup);

      frame = setup.captureCharFrame();
      expect(frame).not.toContain("M alpha.ts");
      expect(frame).toContain("alpha.ts");
      expect(frame).not.toContain("drag divider resize");

      await act(async () => {
        await setup.mockInput.typeText("s");
      });
      await flush(setup);

      frame = setup.captureCharFrame();
      expect(frame).toContain("M alpha.ts");
      expect(frame).toContain("drag divider resize");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("quit shortcuts route through the provided onQuit handler in regular and pager modes", async () => {
    const regularQuit = mock(() => undefined);
    const regularSetup = await testRender(<App bootstrap={createBootstrap()} onQuit={regularQuit} />, { width: 220, height: 24 });

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
    const pagerSetup = await testRender(<App bootstrap={createBootstrap("auto", true)} onQuit={pagerQuit} />, { width: 180, height: 20 });

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
