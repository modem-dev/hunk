import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, StrictMode, useState } from "react";
import type { ExtensionTrustDecision } from "../../extensions/trust";
import type { CurrentReviewRefreshOptions } from "../currentReviewRefresh";
import {
  useExtensionTrustController,
  type ExtensionTrustController,
  type ExtensionTrustWriter,
} from "./useExtensionTrustController";

/** Mount the trust controller with mutable session facts and observable side effects. */
async function renderTrustController({
  canRefresh = true,
  initialPagerMode = false,
  initialPendingRepoRoot = "/repo/alpha",
  refresh = async () => {},
  strictMode = false,
  writeTrust,
}: {
  canRefresh?: boolean;
  initialPagerMode?: boolean;
  initialPendingRepoRoot?: string;
  refresh?: (options?: CurrentReviewRefreshOptions) => Promise<void>;
  strictMode?: boolean;
  writeTrust?: ExtensionTrustWriter;
} = {}) {
  let controller!: ExtensionTrustController;
  let rerender!: () => void;
  let setPagerMode!: (enabled: boolean) => void;
  let setPendingRepoRoot!: (root: string | undefined) => void;
  const notices: string[] = [];
  const refreshes: Array<CurrentReviewRefreshOptions | undefined> = [];
  const writes: Array<{ repoRoot: string; decision: ExtensionTrustDecision }> = [];

  const recordTrust: ExtensionTrustWriter = (repoRoot, decision) => {
    writes.push({ repoRoot, decision });
    return writeTrust?.(repoRoot, decision);
  };
  const recordRefresh = async (options?: CurrentReviewRefreshOptions) => {
    refreshes.push(options);
    await refresh(options);
  };

  function Harness() {
    const [generation, setGeneration] = useState(0);
    const [pagerMode, updatePagerMode] = useState(initialPagerMode);
    const [pendingRepoRoot, updatePendingRepoRoot] = useState<string | undefined>(
      initialPendingRepoRoot,
    );
    rerender = () => setGeneration((current) => current + 1);
    setPagerMode = updatePagerMode;
    setPendingRepoRoot = updatePendingRepoRoot;
    controller = useExtensionTrustController({
      canRefreshCurrentInput: canRefresh,
      pagerMode,
      pendingRepoRoot,
      refreshCurrentInput: recordRefresh,
      showNotice: (message) => notices.push(message),
      writeTrust: recordTrust,
    });

    return (
      <text>
        {generation}:
        {controller.extensionTrustPromptOpen ? controller.extensionTrustPromptRoot : ""}
      </text>
    );
  }

  const setup = await testRender(
    strictMode ? (
      <StrictMode>
        <Harness />
      </StrictMode>
    ) : (
      <Harness />
    ),
    { width: 60, height: 2 },
  );

  /** Flush effects and terminal rendering after one controller transition. */
  const settle = async () => {
    await act(async () => {
      await setup.renderOnce();
      await Bun.sleep(0);
      await setup.renderOnce();
    });
  };

  await settle();
  return {
    current: () => controller,
    notices,
    refreshes,
    rerender,
    setPagerMode,
    setPendingRepoRoot,
    settle,
    setup,
    writes,
  };
}

/** Destroy one mounted controller harness. */
async function destroy(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => setup.renderer.destroy());
}

describe("useExtensionTrustController", () => {
  test("suppresses prompts in pager mode and offers the root when pager mode ends", async () => {
    const harness = await renderTrustController({ initialPagerMode: true });
    try {
      expect(harness.current().extensionTrustPromptOpen).toBeFalse();
      expect(harness.current().extensionTrustPromptRoot).toBeNull();

      await act(async () => harness.setPagerMode(false));
      await harness.settle();
      expect(harness.current().extensionTrustPromptOpen).toBeTrue();
      expect(harness.current().extensionTrustPromptRoot).toBe("/repo/alpha");
    } finally {
      await destroy(harness.setup);
    }
  });

  test("keeps a dismissed root closed, offers a changed root, and closes when pending clears", async () => {
    const harness = await renderTrustController();
    try {
      expect(harness.current().extensionTrustPromptRoot).toBe("/repo/alpha");

      await act(async () => harness.current().closeExtensionTrustPrompt());
      await harness.settle();
      expect(harness.current().extensionTrustPromptOpen).toBeFalse();

      await act(async () => harness.rerender());
      await harness.settle();
      expect(harness.current().extensionTrustPromptOpen).toBeFalse();

      await act(async () => harness.setPendingRepoRoot("/repo/beta"));
      await harness.settle();
      expect(harness.current().extensionTrustPromptRoot).toBe("/repo/beta");

      // Returning to an already offered root must close Beta rather than displaying it for Alpha.
      await act(async () => harness.setPendingRepoRoot("/repo/alpha"));
      await harness.settle();
      expect(harness.current().extensionTrustPromptOpen).toBeFalse();
      expect(harness.current().extensionTrustPromptRoot).toBeNull();

      await act(async () => harness.setPendingRepoRoot(undefined));
      await harness.settle();
      expect(harness.current().extensionTrustPromptRoot).toBeNull();
    } finally {
      await destroy(harness.setup);
    }
  });

  test("does not reopen an offered root after pager mode temporarily hides it", async () => {
    const harness = await renderTrustController();
    try {
      expect(harness.current().extensionTrustPromptRoot).toBe("/repo/alpha");

      await act(async () => harness.setPagerMode(true));
      await harness.settle();
      expect(harness.current().extensionTrustPromptOpen).toBeFalse();
      expect(harness.current().extensionTrustPromptRoot).toBeNull();

      await act(async () => harness.setPagerMode(false));
      await harness.settle();
      expect(harness.current().extensionTrustPromptOpen).toBeFalse();
      expect(harness.current().extensionTrustPromptRoot).toBeNull();
    } finally {
      await destroy(harness.setup);
    }
  });

  test("keeps initial offering and same-root dismissal stable under StrictMode replay", async () => {
    const harness = await renderTrustController({ strictMode: true });
    try {
      expect(harness.current().extensionTrustPromptOpen).toBeTrue();
      expect(harness.current().extensionTrustPromptRoot).toBe("/repo/alpha");

      await act(async () => harness.current().closeExtensionTrustPrompt());
      await harness.settle();
      await act(async () => harness.rerender());
      await harness.settle();
      expect(harness.current().extensionTrustPromptOpen).toBeFalse();
      expect(harness.current().extensionTrustPromptRoot).toBeNull();
    } finally {
      await destroy(harness.setup);
    }
  });

  test("records trust and soft-reloads extensions through the current-review operation", async () => {
    const harness = await renderTrustController();
    try {
      await act(async () => harness.current().trustRepoExtensions());
      await harness.settle();

      expect(harness.writes).toEqual([{ repoRoot: "/repo/alpha", decision: "trusted" }]);
      expect(harness.refreshes).toEqual([{ reason: "manual", reloadExtensions: true }]);
      expect(harness.notices).toEqual([]);
      expect(harness.current().extensionTrustPromptOpen).toBeFalse();
    } finally {
      await destroy(harness.setup);
    }
  });

  test("records trust without reloading a non-reloadable review", async () => {
    const harness = await renderTrustController({ canRefresh: false });
    try {
      await act(async () => harness.current().trustRepoExtensions());
      await harness.settle();

      expect(harness.writes).toEqual([{ repoRoot: "/repo/alpha", decision: "trusted" }]);
      expect(harness.refreshes).toEqual([]);
      expect(harness.notices).toEqual([
        "Trusted this repository • restart Hunk to load its extensions",
      ]);
    } finally {
      await destroy(harness.setup);
    }
  });

  test("contains trust persistence failures and leaves the app mounted", async () => {
    const harness = await renderTrustController({
      writeTrust: () => {
        throw new Error("state is read-only");
      },
    });
    try {
      await act(async () => harness.current().trustRepoExtensions());
      await harness.settle();

      expect(harness.refreshes).toEqual([]);
      expect(harness.notices).toEqual(["state is read-only"]);
      expect(harness.current().extensionTrustPromptOpen).toBeFalse();
    } finally {
      await destroy(harness.setup);
    }
  });

  test("reports a rejected trust reload without reopening the prompt", async () => {
    const harness = await renderTrustController({
      refresh: async () => {
        throw new Error("reload failed");
      },
    });
    try {
      await act(async () => harness.current().trustRepoExtensions());
      await harness.settle();

      expect(harness.notices).toEqual([
        "Failed to reload after trusting this repository's extensions.",
      ]);
      expect(harness.current().extensionTrustPromptOpen).toBeFalse();
    } finally {
      await destroy(harness.setup);
    }
  });

  test("records denial and reports the existing confirmation", async () => {
    const harness = await renderTrustController();
    try {
      await act(async () => harness.current().denyRepoExtensions());
      await harness.settle();

      expect(harness.writes).toEqual([{ repoRoot: "/repo/alpha", decision: "denied" }]);
      expect(harness.refreshes).toEqual([]);
      expect(harness.notices).toEqual(["Won't run this repository's extensions"]);
    } finally {
      await destroy(harness.setup);
    }
  });

  test("contains non-Error denial persistence failures with the fallback message", async () => {
    const harness = await renderTrustController({
      writeTrust: () => {
        throw "state failure";
      },
    });
    try {
      await act(async () => harness.current().denyRepoExtensions());
      await harness.settle();

      expect(harness.notices).toEqual(["Failed to record the trust decision."]);
      expect(harness.current().extensionTrustPromptOpen).toBeFalse();
    } finally {
      await destroy(harness.setup);
    }
  });
});
