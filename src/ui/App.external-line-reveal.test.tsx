import { describe, expect, test } from "bun:test";
import { ScrollBoxRenderable, type Renderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { createReviewSessionRuntime } from "../app/reviewSessionRuntime";
import { createTestVcsAppBootstrap } from "../../test/helpers/app-bootstrap";
import { createTestDiffFile } from "../../test/helpers/diff-helpers";
import { App } from "./App";

/** Find the vertically overflowing review pane in a rendered app. */
function findReviewScrollBox(renderable: Renderable): ScrollBoxRenderable | null {
  if (
    renderable instanceof ScrollBoxRenderable &&
    renderable.scrollHeight > renderable.viewport.height
  ) {
    return renderable;
  }
  for (const child of renderable.getChildren()) {
    const found = findReviewScrollBox(child);
    if (found) return found;
  }
  return null;
}

/** Render enough frames for pane measurement and passive controller reconciliation. */
async function flush(setup: Awaited<ReturnType<typeof testRender>>, frames = 3) {
  for (let index = 0; index < frames; index += 1) {
    await act(async () => {
      await setup.renderOnce();
      await Bun.sleep(0);
    });
  }
}

describe("external semantic line reveal", () => {
  test("scrolls DiffPane only after its terminal cursor adopts the requested line", async () => {
    const before = Array.from(
      { length: 80 },
      (_, index) => `old row ${String(index + 1).padStart(2, "0")}\n`,
    ).join("");
    const after = Array.from({ length: 80 }, (_, index) => {
      const line = index + 1;
      return line === 80
        ? "TARGET_EXTERNAL_REVEAL_80\n"
        : `new row ${String(line).padStart(2, "0")}\n`;
    }).join("");
    const bootstrap = createTestVcsAppBootstrap({
      changesetId: "external-line-reveal",
      files: [
        createTestDiffFile({
          after,
          before,
          context: 3,
          id: "external",
          path: "external.ts",
        }),
      ],
    });
    const runtime = createReviewSessionRuntime(bootstrap);
    const store = runtime.getSnapshot().store;
    const setup = await testRender(
      <App
        bootstrap={bootstrap}
        reviewStore={store}
        sessionRuntime={runtime}
        onReloadSession={async () => {
          throw new Error("Reload is not used by this test.");
        }}
      />,
      { width: 140, height: 14 },
    );

    try {
      await flush(setup);
      const scrollBox = findReviewScrollBox(setup.renderer.root);
      if (!scrollBox) throw new Error("Expected a scrollable DiffPane.");
      expect(scrollBox.scrollTop).toBe(0);
      expect(setup.captureCharFrame()).not.toContain("TARGET_EXTERNAL_REVEAL_80");

      const fileKey = store.getSnapshot().document.files[0]!.key;
      await act(async () => {
        store.dispatch({
          type: "selection/set-line",
          fileKey,
          hunkIndex: 0,
          side: "new",
          line: 80,
          reveal: true,
        });
      });
      await flush(setup, 6);

      expect(store.getSnapshot().selection).toMatchObject({
        fileKey,
        hunkIndex: 0,
        side: "new",
        line: 80,
      });
      expect(scrollBox.scrollTop).toBeGreaterThan(0);
      expect(setup.captureCharFrame()).toContain("TARGET_EXTERNAL_REVEAL_80");
    } finally {
      runtime.dispose();
      await act(async () => setup.renderer.destroy());
    }
  });
});
