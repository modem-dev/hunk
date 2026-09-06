import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, mock, test } from "bun:test";
import { ScrollBoxRenderable, type Renderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { AppBootstrap } from "../core/bootstrap";
import { createTestVcsAppBootstrap } from "../../../../test/helpers/app-bootstrap";
import { createTestDiffFile } from "../../../../test/helpers/diff-helpers";
import { loadStartupExtensions } from "../extensions/startup";

mock.restore();

const { AppHost } = await import("./AppHost");

/**
 * Key-ownership routing between the global handler chain and a focused
 * scroll box.
 *
 * OpenTUI runs Hunk's global key handler before the focused renderable, and
 * its scroll boxes answer arrows and j/k with a fifth-of-a-viewport scroll of
 * their own. Any modal surface that acts on a key without consuming it
 * therefore scrolls the review stream behind itself whenever the scroll box
 * holds focus — which it always does in pager mode, and does in review mode
 * once focus lands on it. These tests pin the modal surfaces that must own
 * their keys outright.
 */
function createScrollableBootstrap(): AppBootstrap {
  // Change every line so no context collapses: the review stream must be
  // taller than the viewport for the scroll box to have anywhere to go.
  const before = Array.from(
    { length: 80 },
    (_, index) => `line ${String(index + 1).padStart(2, "0")} old value\n`,
  ).join("");
  const after = Array.from(
    { length: 80 },
    (_, index) => `line ${String(index + 1).padStart(2, "0")} new value\n`,
  ).join("");

  return createTestVcsAppBootstrap({
    changesetId: "key-routing",
    files: [
      createTestDiffFile({
        after,
        before,
        context: 3,
        id: "big",
        path: "big.ts",
      }),
    ],
  });
}

/** Find the review stream's scroll box: the one with vertical overflow. */
function findReviewScrollBox(renderable: Renderable): ScrollBoxRenderable | null {
  if (
    renderable instanceof ScrollBoxRenderable &&
    renderable.scrollHeight > renderable.viewport.height
  ) {
    return renderable;
  }

  for (const child of renderable.getChildren()) {
    const found = findReviewScrollBox(child);
    if (found) {
      return found;
    }
  }

  return null;
}

/** Render pending frames until React and OpenTUI both settle. */
async function flush(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await setup.renderOnce();
    await Bun.sleep(0);
    await setup.renderOnce();
  });
}

/** Poll rendered frames until a predicate matches, keeping tests resilient to async repaints. */
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

/** Boot the app and hand keyboard focus to the review scroll box. */
async function setupWithFocusedScrollBox() {
  const setup = await testRender(<AppHost bootstrap={createScrollableBootstrap()} />, {
    width: 120,
    height: 24,
  });

  await act(async () => {
    await setup.renderOnce();
    await Bun.sleep(100);
    await setup.renderOnce();
  });

  // Model the state an unconsumed review-stream click produces (and the state
  // pager mode starts in): the scroll box holds keyboard focus, so every key
  // the global chain fails to consume reaches its own arrow/jk scrolling.
  const scrollBox = findReviewScrollBox(setup.renderer.root);
  if (!scrollBox) {
    throw new Error("No scrollable review scroll box found in the rendered app.");
  }

  await act(async () => {
    scrollBox.focus();
    await setup.renderOnce();
  });

  return { setup, scrollBox };
}

describe("UI key routing with a focused scroll box", () => {
  test("menu arrows move the selection without scrolling the stream behind the menu", async () => {
    const { setup, scrollBox } = await setupWithFocusedScrollBox();

    try {
      const scrollTopBefore = scrollBox.scrollTop;

      await act(async () => {
        await setup.mockInput.pressKey("F10");
      });
      const menuFrame = await waitForFrame(setup, (frame) => frame.includes("Reload"), 12);
      expect(menuFrame).toContain("Reload");

      for (let press = 0; press < 3; press += 1) {
        await act(async () => {
          await setup.mockInput.pressArrow("down");
        });
        await flush(setup);
      }

      // The menu owns its arrows: the focused scroll box must not see them.
      expect(scrollBox.scrollTop).toBe(scrollTopBefore);
      expect(setup.captureCharFrame()).toContain("Reload");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("the theme selector owns vertical review keys instead of scrolling the stream", async () => {
    const { setup, scrollBox } = await setupWithFocusedScrollBox();

    try {
      const scrollTopBefore = scrollBox.scrollTop;

      await act(async () => {
        await setup.mockInput.typeText("t");
      });
      const selectorFrame = await waitForFrame(
        setup,
        (frame) => frame.includes("Theme selector"),
        12,
      );
      expect(selectorFrame).toContain("Theme selector");

      // The review's down key moves the selector and must not reach the focused scroll box.
      await act(async () => {
        await setup.mockInput.typeText("j");
      });
      await flush(setup);

      expect(scrollBox.scrollTop).toBe(scrollTopBefore);
      const movedFrame = setup.captureCharFrame();
      expect(movedFrame).toContain("Theme selector");
      expect(movedFrame).toContain("›  github-dark-dimmed");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });

  test("an active file-view mode consumes what it handles and leaves what it passes", async () => {
    const root = mkdtempSync(join(tmpdir(), "hunk-key-routing-mode-"));
    const extension = join(root, "scroll-mode");
    mkdirSync(extension, { recursive: true });
    writeFileSync(
      join(extension, "package.json"),
      JSON.stringify({ name: "scroll-mode", private: true, hunk: { extensions: ["./index.ts"] } }),
    );
    // Taller than the viewport, so the review scroll box has somewhere to go
    // while the view is the file's presentation.
    writeFileSync(
      join(extension, "index.ts"),
      `export default function (hunk) {
  hunk.registerFileView({
    id: "tall",
    title: "Tall",
    matches: () => true,
    layout: ({ file }) => ({
      rows: Array.from({ length: 200 }, (_, index) => ({
        id: "row:" + index,
        spans: [{ text: "TALL ROW " + (index + 1) }],
      })),
      hunkRows: (file.hunks ?? []).map(() => ({ startRow: 0, endRow: 0 })),
    }),
    mode: { onKey: (key) => (key.name === "n" ? "handled" : "pass") },
  });
  hunk.registerCommand({ id: "toggle", title: "Toggle tall", key: "f8" }, (ctx) =>
    ctx.fileViews.toggle("tall"),
  );
  hunk.registerCommand({ id: "enter", title: "Enter tall mode", key: "f9" }, (ctx) =>
    ctx.fileViews.enterMode("tall"),
  );
}
`,
    );
    const extensions = await loadStartupExtensions({
      cliExtensionPaths: [extension],
      cwd: root,
      env: { XDG_CONFIG_HOME: root } as NodeJS.ProcessEnv,
      extensions: { enabled: true, extensionConfigs: {}, paths: [], repoPaths: [] },
    });
    const bootstrap = createScrollableBootstrap();
    bootstrap.extensions = extensions;
    const setup = await testRender(<AppHost bootstrap={bootstrap} onQuit={() => {}} />, {
      width: 120,
      height: 24,
    });

    try {
      await waitForFrame(setup, (frame) => frame.includes("big.ts"), 12);
      await act(async () => setup.mockInput.pressKey("F8"));
      await waitForFrame(setup, (frame) => frame.includes("TALL ROW 1"), 20);

      const scrollBox = findReviewScrollBox(setup.renderer.root);
      if (!scrollBox) {
        throw new Error("No scrollable review scroll box found in the rendered app.");
      }

      await act(async () => {
        scrollBox.focus();
        await setup.renderOnce();
      });
      await act(async () => setup.mockInput.pressKey("F9"));
      await waitForFrame(setup, (frame) => frame.includes("mode — Esc exits"), 12);
      const scrollTopBefore = scrollBox.scrollTop;

      // "handled" must stop the key dead: neither the command bound to it nor
      // the focused scroll box may act on a key the mode claimed.
      await act(async () => setup.mockInput.typeText("n"));
      await flush(setup);
      expect(scrollBox.scrollTop).toBe(scrollTopBefore);

      // "pass" leaves scrolling exactly as it is with no mode running.
      await act(async () => setup.mockInput.typeText("j"));
      await flush(setup);
      expect(scrollBox.scrollTop).toBeGreaterThan(scrollTopBefore);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an extension pane editor receives typing before app and extension commands", async () => {
    const root = mkdtempSync(join(tmpdir(), "hunk-key-routing-pane-input-"));
    const extension = join(root, "prompt-pane");
    mkdirSync(extension, { recursive: true });
    writeFileSync(
      join(extension, "package.json"),
      JSON.stringify({
        name: "prompt-pane",
        private: true,
        hunk: { extensions: ["./index.tsx"] },
      }),
    );
    writeFileSync(
      join(extension, "index.tsx"),
      `import { createElement, useState } from "react";
export default function (hunk) {
  hunk.registerPane({
    id: "prompt",
    placement: "bottom",
    defaultOpen: true,
    height: { preferred: 3, min: 3, max: 3 },
    component: () => {
      const [value, setValue] = useState("");
      return createElement("input", { value, focused: true, onInput: setValue });
    },
  });
  hunk.registerCommand({ id: "letter", title: "Letter command", key: "j" }, (ctx) => {
    ctx.notify("COMMAND FIRED");
  });
}
`,
    );
    const extensions = await loadStartupExtensions({
      cliExtensionPaths: [extension],
      cwd: root,
      env: { XDG_CONFIG_HOME: root } as NodeJS.ProcessEnv,
      extensions: { enabled: true, extensionConfigs: {}, paths: [], repoPaths: [] },
    });
    const bootstrap = createScrollableBootstrap();
    bootstrap.extensions = extensions;
    const setup = await testRender(<AppHost bootstrap={bootstrap} onQuit={() => {}} />, {
      width: 120,
      height: 24,
    });

    try {
      await waitForFrame(setup, () => setup.renderer.currentFocusedEditor !== null, 12);
      expect(setup.renderer.currentFocusedEditor).not.toBeNull();

      await act(async () => setup.mockInput.typeText("j?"));
      await flush(setup);

      const frame = setup.captureCharFrame();
      expect(frame).toContain("j?");
      expect(frame).not.toContain("COMMAND FIRED");
      expect(frame).not.toContain("Controls help");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
