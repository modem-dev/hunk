import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, StrictMode, useEffect, useState } from "react";
import { createReviewSessionRuntime } from "../app/reviewSessionRuntime";
import { createTestVcsAppBootstrap } from "../../test/helpers/app-bootstrap";
import { createTestDiffFile } from "../../test/helpers/diff-helpers";
import type { AppBootstrap } from "../core/types";
import type { ExtensionCommandControls } from "../extension-api/types";
import { createEmptyExtensionLoadResult } from "../extensions/types";
import { App } from "./App";

/** Build one bootstrap with a caller-supplied extension authority. */
function createBootstrap(extensions = createEmptyExtensionLoadResult("/repo")): AppBootstrap {
  return {
    ...createTestVcsAppBootstrap({
      changesetId: "changeset:command-controls",
      files: [createTestDiffFile({ id: "alpha", path: "alpha.ts" })],
      initialMode: "stack",
    }),
    extensions,
  };
}

/** Settle React effects and OpenTUI rendering. */
async function flush(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await setup.renderOnce();
    await Bun.sleep(0);
    await setup.renderOnce();
  });
}

describe("extension command control authority", () => {
  test("retires captured controls only when a soft reload replaces the extension registry", async () => {
    let capturedControls: ExtensionCommandControls | null = null;
    const initial = createBootstrap();
    initial.extensions!.registry.commands.push({
      extensionId: "probe",
      command: { id: "capture", title: "Capture controls", key: "y" },
      handler(ctx) {
        capturedControls = ctx.commands;
      },
    });
    let replaceBootstrap: (next: AppBootstrap) => void = () => {};

    function Harness() {
      const [runtime] = useState(() => createReviewSessionRuntime(initial));
      const [bootstrap, setBootstrap] = useState(initial);
      useEffect(() => () => runtime.dispose(), [runtime]);
      replaceBootstrap = setBootstrap;
      return (
        <App
          bootstrap={bootstrap}
          reviewStore={runtime.getSnapshot().store}
          sessionRuntime={runtime}
          onReloadSession={async () => ({
            sessionId: "test",
            inputKind: bootstrap.input.kind,
            title: bootstrap.changeset.title,
            sourceLabel: bootstrap.changeset.sourceLabel,
            fileCount: bootstrap.changeset.files.length,
            selectedHunkIndex: 0,
          })}
        />
      );
    }

    const setup = await testRender(
      <StrictMode>
        <Harness />
      </StrictMode>,
      { width: 140, height: 24 },
    );

    try {
      await flush(setup);
      await act(async () => {
        await setup.mockInput.typeText("y");
      });
      await flush(setup);
      expect(capturedControls).not.toBeNull();
      expect(capturedControls!.isEnabled("hunk.review.nextHunk")).toBe(true);

      // Ordinary content reloads retain the extension registry and its async authority.
      await act(async () => {
        replaceBootstrap({ ...createBootstrap(), extensions: initial.extensions });
      });
      await flush(setup);
      expect(capturedControls!.isEnabled("hunk.review.nextHunk")).toBe(true);

      // AppHost closes the old registry before its async replacement load finishes.
      // Captured controls lose authority at that boundary, before App receives new props.
      initial.extensions!.registry.eventBusPhase = "closed";
      expect(capturedControls!.isEnabled("hunk.review.nextHunk")).toBe(false);
      expect(capturedControls!.execute("hunk.review.nextHunk")).toBe(false);

      // Reloading extensions then swaps the registry without remounting App. The
      // retired controls must stay stale against the replacement command table.
      await act(async () => {
        replaceBootstrap(createBootstrap());
      });
      await flush(setup);
      expect(capturedControls!.isEnabled("hunk.review.nextHunk")).toBe(false);
      expect(capturedControls!.execute("hunk.review.nextHunk")).toBe(false);
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });
});
