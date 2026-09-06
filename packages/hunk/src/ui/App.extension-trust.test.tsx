import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import type { AppBootstrap } from "../app/types";
import { createEmptyExtensionLoadResult } from "../extensions/types";
import { createTestVcsAppBootstrap } from "../../../../test/helpers/app-bootstrap";
import { createTestDiffFile } from "../../../../test/helpers/diff-helpers";

const { App } = await import("./App");

/** Build a bootstrap whose extension load pass is waiting on a trust decision. */
function createBootstrap(pendingTrustRepoRoot?: string): AppBootstrap {
  const bootstrap = createTestVcsAppBootstrap({
    changesetId: "changeset:trust",
    files: [createTestDiffFile({ id: "alpha", path: "alpha.ts" })],
    initialMode: "stack",
  });
  const extensions = createEmptyExtensionLoadResult("/repo");

  return {
    ...bootstrap,
    extensions: pendingTrustRepoRoot ? { ...extensions, pendingTrustRepoRoot } : extensions,
  };
}

/**
 * Drive `App` directly so the bootstrap can be replaced without a remount.
 *
 * That is what a daemon-driven session reload does (`resetApp: false`), and it
 * is the case where a launch-time-only prompt state would go stale.
 */
function createTrustHarness(initial: AppBootstrap) {
  let replaceBootstrap: (next: AppBootstrap) => void = () => {};

  function Harness() {
    const [bootstrap, setBootstrap] = useState(initial);
    replaceBootstrap = setBootstrap;

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

  return { Harness, replaceBootstrap: (next: AppBootstrap) => replaceBootstrap(next) };
}

describe("repo extension trust prompt", () => {
  test("re-asks when a reload points the session at a different repo", async () => {
    const { Harness, replaceBootstrap } = createTrustHarness(createBootstrap("/repo/alpha"));
    const setup = await testRender(<Harness />, { width: 140, height: 24 });

    /** Settle pending effects and return the drawn frame. */
    const frame = async () => {
      await act(async () => {
        await setup.renderOnce();
        await Bun.sleep(0);
        await setup.renderOnce();
      });
      return setup.captureCharFrame();
    };

    /** Settle until the frame satisfies one condition, then return it. */
    const frameWhere = async (matches: (text: string) => boolean) => {
      let text = await frame();
      for (let attempt = 0; attempt < 20 && !matches(text); attempt++) {
        await act(async () => {
          await Bun.sleep(10);
        });
        text = await frame();
      }
      return text;
    };

    try {
      expect(await frame()).toContain("Run this repository's extensions?");
      expect(await frame()).toContain("/repo/alpha");

      await act(async () => {
        await setup.mockInput.pressEscape();
      });
      const dismissed = await frameWhere(
        (text) => !text.includes("Run this repository's extensions?"),
      );
      expect(dismissed).not.toContain("Run this repository's extensions?");

      // A reload that keeps the same pending root must not re-ask: "not now"
      // was an answer for this repository.
      await act(async () => {
        replaceBootstrap(createBootstrap("/repo/alpha"));
      });
      expect(await frame()).not.toContain("Run this repository's extensions?");

      // A different repository is a different question.
      await act(async () => {
        replaceBootstrap(createBootstrap("/repo/beta"));
      });
      const reasked = await frameWhere((text) =>
        text.includes("Run this repository's extensions?"),
      );
      expect(reasked).toContain("Run this repository's extensions?");
      expect(reasked).toContain("/repo/beta");

      // Trust resolved elsewhere (or extensions disabled) closes the prompt.
      await act(async () => {
        replaceBootstrap(createBootstrap());
      });
      expect(
        await frameWhere((text) => !text.includes("Run this repository's extensions?")),
      ).not.toContain("Run this repository's extensions?");
    } finally {
      await act(async () => {
        setup.renderer.destroy();
      });
    }
  });
});
