import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { AppBootstrap, DiffFile } from "../core/types";
import { createTestVcsAppBootstrap } from "../../test/helpers/app-bootstrap";
import { createTestDiffFile } from "../../test/helpers/diff-helpers";

const { AppHost } = await import("./AppHost");

/** Build a changeset with one collapsible lockfile and one ordinary source file. */
function createNoiseBootstrap(): AppBootstrap {
  const lockFile: DiffFile = createTestDiffFile({
    id: "lock",
    path: "bun.lock",
    before: "lockData = 1\n",
    after: "lockData = 2\n",
  });
  // Simulate what buildDiffFile records for a recognized lockfile.
  lockFile.noiseKind = "lockfile";

  const sourceFile = createTestDiffFile({
    id: "alpha",
    path: "alpha.ts",
    before: "export const alpha = 1;\n",
    after: "export const alpha = 2;\n",
  });

  return createTestVcsAppBootstrap({
    changesetId: "changeset:collapse",
    files: [lockFile, sourceFile],
    initialMode: "stack",
  });
}

/** Settle pending renders so frame assertions see the committed UI. */
async function flush(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await setup.renderOnce();
    await Bun.sleep(0);
    await setup.renderOnce();
  });
}

describe("AppHost generated-file collapse", () => {
  test("collapses noise files by default and expands the selected one with x", async () => {
    const setup = await testRender(<AppHost bootstrap={createNoiseBootstrap()} />, {
      width: 200,
      height: 24,
    });

    try {
      await flush(setup);

      // The lockfile renders as a collapsed placeholder; its diff body is hidden,
      // while the ordinary source file shows its change in full.
      let frame = setup.captureCharFrame();
      expect(frame).toContain("Lockfile collapsed");
      expect(frame).toContain("press x to expand");
      expect(frame).not.toContain("lockData");
      expect(frame).toContain("export const alpha");

      // The lockfile is the first file and selected by default; x expands it.
      await act(async () => {
        await setup.mockInput.typeText("x");
      });
      await flush(setup);

      frame = setup.captureCharFrame();
      expect(frame).toContain("lockData");
      expect(frame).not.toContain("Lockfile collapsed");

      // x again re-collapses it.
      await act(async () => {
        await setup.mockInput.typeText("x");
      });
      await flush(setup);

      frame = setup.captureCharFrame();
      expect(frame).toContain("Lockfile collapsed");
      expect(frame).not.toContain("lockData");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });
});
