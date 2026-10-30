import { expect, spyOn, test } from "bun:test";
import { ScrollBoxRenderable, type BaseRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDeferred } from "../../../../../test/helpers/diff-helpers";
import { ThemeController } from "../theme/controller";
import { DocumentApp } from "./DocumentApp";
import { DocumentBrowserController } from "./controller";

/** Find the document scrollbox after the sidebar without relying on generated native ids. */
function findTestScrollboxes(node: BaseRenderable): ScrollBoxRenderable[] {
  return [
    ...(node instanceof ScrollBoxRenderable ? [node] : []),
    ...node.getChildren().flatMap(findTestScrollboxes),
  ];
}

/** Pause source-owned copy preparation while observing the real editor argument builder. */
async function createTestEditorTargetApp() {
  const root = await mkdtemp(join(tmpdir(), "hunk-editor-target-"));
  const copies = { a: join(root, "a.txt"), b: join(root, "b.txt") };
  await Promise.all(Object.values(copies).map((copy) => writeFile(copy, "copy")));
  const release = createTestDeferred<void>();
  const keys: string[] = [];
  const launches: string[][] = [];
  const controller = new DocumentBrowserController({
    root: { key: "root", name: "Collection", kind: "directory", hidden: false },
    async list() {
      return {
        kind: "entries",
        entries: ["a", "b"].map((key) => ({
          key,
          name: `${key}.txt`,
          kind: "file",
          hidden: false,
        })),
      };
    },
    async read(key) {
      return {
        kind: "text",
        text: Array.from({ length: 300 }, (_, index) => `${key} ROW_${index + 1}`).join("\n"),
        identity: key,
      };
    },
    async edit(key, launch) {
      keys.push(key);
      await release.promise;
      return launch(copies[key as keyof typeof copies]);
    },
  });
  await controller.initialize();
  await controller.select("a");
  const previousEditor = process.env.EDITOR;
  process.env.EDITOR = "nvim";
  const spawn = spyOn(Bun, "spawnSync").mockImplementation((command) => {
    launches.push(command as string[]);
    return { exitCode: 0 } as ReturnType<typeof Bun.spawnSync>;
  });
  const setup = await testRender(
    <DocumentApp
      controller={controller}
      themeController={new ThemeController({ initialTheme: "github-dark-default" })}
      options={{ lineNumbers: false }}
      keybindings={{}}
      onQuit={() => undefined}
    />,
    { width: 100, height: 20 },
  );
  await act(async () => {
    await setup.renderOnce();
    await Bun.sleep(30);
  });
  const pane = findTestScrollboxes(setup.renderer.root).at(-1)!;
  await act(async () => {
    pane.scrollTo({ y: 200, x: 0 });
    await setup.renderOnce();
  });
  await act(async () => setup.renderOnce());

  /** Release pending editing and restore process-local spies on every test exit. */
  const close = async () => {
    release.resolve();
    await controller.close();
    spawn.mockRestore();
    if (previousEditor === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = previousEditor;
    await act(async () => setup.renderer.destroy());
    await rm(root, { recursive: true, force: true });
  };
  return { setup, controller, release, keys, launches, copies, close };
}

for (const change of ["scroll", "document"] as const) {
  test(`an edit keeps its dispatch-time file and line when later ${change} input arrives during preparation`, async () => {
    const app = await createTestEditorTargetApp();

    try {
      expect(app.setup.captureCharFrame()).toContain("a ROW_201");
      if (change === "scroll") {
        await act(async () => {
          app.setup.mockInput.pressTab();
          await app.setup.renderOnce();
        });
      }
      await act(async () => {
        app.setup.mockInput.pressKey("e");
        if (change === "scroll") app.setup.mockInput.pressKey("g");
        else app.setup.mockInput.pressArrow("down");
        await Bun.sleep(20);
      });
      await act(async () => app.setup.renderOnce());
      expect(app.launches).toEqual([]);
      if (change === "document") expect(app.controller.getSnapshot().documentKey).toBe("b");
      else expect(app.setup.captureCharFrame()).toContain("a ROW_1");
      await act(async () => {
        app.release.resolve();
        await Bun.sleep(30);
      });
      expect(app.keys).toEqual(["a"]);
      expect(app.launches).toEqual([["nvim", "+201", app.copies.a]]);
    } finally {
      await app.close();
    }
  });
}

test("a document selected before editing in the same burst starts at its own first line", async () => {
  const app = await createTestEditorTargetApp();

  try {
    expect(app.setup.captureCharFrame()).toContain("a ROW_201");
    await act(async () => {
      app.setup.mockInput.pressArrow("down");
      app.setup.mockInput.pressKey("e");
      await Bun.sleep(20);
    });
    expect(app.controller.getSnapshot().documentKey).toBe("b");
    await act(async () => {
      app.release.resolve();
      await Bun.sleep(30);
    });
    expect(app.keys).toEqual(["b"]);
    expect(app.launches).toEqual([["nvim", "+1", app.copies.b]]);
  } finally {
    await app.close();
  }
});
