import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, Suspense, useState } from "react";
import { createTestVcsAppBootstrap } from "../../../../test/helpers/app-bootstrap";
import { createTestDiffFile } from "../../../../test/helpers/diff-helpers";
import type { AppBootstrap } from "../app/types";
import { createEmptyExtensionLoadResult, type ExtensionLoadResult } from "../extensions/types";
import { App } from "./App";

/** Build one review generation with caller-owned extension authority. */
function createBootstrap(id: string, extensions: ExtensionLoadResult): AppBootstrap {
  return {
    ...createTestVcsAppBootstrap({
      changesetId: id,
      files: [createTestDiffFile({ id: "alpha", path: "alpha.ts" })],
      initialMode: "stack",
    }),
    extensions,
  };
}

/** Mount App with the narrow host callbacks these lifecycle tests need. */
function TestApp({ bootstrap }: { bootstrap: AppBootstrap }) {
  return (
    <App
      bootstrap={bootstrap}
      onRegisterWorkspaceRefreshRequest={() => () => {}}
      onReloadSession={async () => ({
        sessionId: "test",
        inputKind: bootstrap.input.kind,
        title: bootstrap.changeset.title,
        sourceLabel: bootstrap.changeset.sourceLabel,
        fileCount: bootstrap.changeset.files.length,
        selectedHunkIndex: 0,
      })}
      onRequestExtensionReviewReload={async () => ({
        ok: false,
        reason: "unavailable",
        detail: "The test host does not reload reviews.",
      })}
      onWorkspaceWriteCompleted={() => {}}
      runWorkspaceWrite={async (write) => {
        await write();
        return true;
      }}
    />
  );
}

/** Settle React effects and OpenTUI rendering. */
async function flush(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await setup.renderOnce();
    await Bun.sleep(0);
    await setup.renderOnce();
  });
}

describe("extension runtime commit authority", () => {
  test("does not publish an event provider from a render that never commits", async () => {
    const extensions = createEmptyExtensionLoadResult("/repo");
    const bootstrap = createBootstrap("runtime:suspended", extensions);
    const suspended = new Promise<void>(() => {});

    function SuspendedSibling(): never {
      throw suspended;
    }

    const setup = await testRender(
      <Suspense fallback={<text>waiting</text>}>
        <TestApp bootstrap={bootstrap} />
        <SuspendedSibling />
      </Suspense>,
      { width: 140, height: 24 },
    );

    try {
      await flush(setup);
      expect(setup.captureCharFrame()).toContain("waiting");
      expect(extensions.eventContextProvider).toBeUndefined();
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("retires providers when their registry is replaced or App unmounts", async () => {
    const firstExtensions = createEmptyExtensionLoadResult("/repo/first");
    const secondExtensions = createEmptyExtensionLoadResult("/repo/second");
    const first = createBootstrap("runtime:first", firstExtensions);
    const second = createBootstrap("runtime:second", secondExtensions);
    let replaceBootstrap!: () => void;

    function Harness() {
      const [bootstrap, setBootstrap] = useState(first);
      replaceBootstrap = () => setBootstrap(second);
      return <TestApp bootstrap={bootstrap} />;
    }

    const setup = await testRender(<Harness />, { width: 140, height: 24 });

    try {
      await flush(setup);
      expect(firstExtensions.eventContextProvider).toBeDefined();

      await act(async () => replaceBootstrap());
      await flush(setup);

      expect(firstExtensions.eventContextProvider).toBeUndefined();
      expect(secondExtensions.eventContextProvider).toBeDefined();
    } finally {
      await act(async () => setup.renderer.destroy());
    }

    expect(secondExtensions.eventContextProvider).toBeUndefined();
  });
});
