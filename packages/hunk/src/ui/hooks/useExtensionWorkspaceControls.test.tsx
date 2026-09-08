import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act, useState } from "react";
import type { CliInput } from "../../core/run/commandInputs";
import type { ExtensionConfirmOptions } from "../../extension-api/types";
import type { WorkspaceFileSource } from "../lib/extensionWorkspace";
import {
  useExtensionWorkspaceControls,
  type WorkspaceFileWriter,
  type WorkspaceWriteRunner,
} from "./useExtensionWorkspaceControls";

const EXPIRED = {
  ok: false,
  reason: "unavailable",
  detail: "The review reloaded before this extension operation could finish.",
} as const;
const WRITABLE_INPUT: CliInput = { kind: "vcs", staged: false, options: {} };
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Create one isolated review root and a regular reviewed file. */
function createTestRoot() {
  const root = mkdtempSync(join(tmpdir(), "hunk-workspace-controls-"));
  tempDirs.push(root);
  writeFileSync(join(root, "alpha.txt"), "alpha\n");
  return root;
}

/** Build one reviewed file carrying an optional full-source reader. */
function createTestFile(overrides: Partial<WorkspaceFileSource> = {}): WorkspaceFileSource {
  return {
    id: "alpha",
    path: "alpha.txt",
    metadata: { type: "change" },
    sourceFetcher: { getFullText: async (side) => `${side} alpha` },
    ...overrides,
  };
}

/** Mount the controller with mutable lease authority and injectable host boundaries. */
async function renderController({
  confirm = async () => true,
  files = [createTestFile()],
  input = WRITABLE_INPUT,
  onWorkspaceWriteCompleted = () => {},
  root = createTestRoot(),
  runWorkspaceWrite = async (write) => {
    await write();
    return true;
  },
  workspaceFileWriter,
}: {
  confirm?: (options: ExtensionConfirmOptions, extensionId: string) => Promise<boolean>;
  files?: readonly WorkspaceFileSource[];
  input?: CliInput;
  onWorkspaceWriteCompleted?: () => void;
  root?: string;
  runWorkspaceWrite?: WorkspaceWriteRunner;
  workspaceFileWriter?: WorkspaceFileWriter;
} = {}) {
  let live = true;
  let controller!: ReturnType<typeof useExtensionWorkspaceControls>;
  let replaceInputs!: (next: {
    files: readonly WorkspaceFileSource[];
    input: CliInput;
    root: string;
  }) => void;
  let rerender!: () => void;
  const createExtensionDialogs = (extensionId: string) => ({
    confirm: (options: ExtensionConfirmOptions) => confirm(options, extensionId),
  });
  const createReviewCapabilityLease = () => ({ isLive: () => live });

  function Harness() {
    const [liveInputs, setLiveInputs] = useState({ files, input, root });
    const [, setRenderRevision] = useState(0);
    replaceInputs = setLiveInputs;
    rerender = () => setRenderRevision((current) => current + 1);
    controller = useExtensionWorkspaceControls({
      createExtensionDialogs,
      createReviewCapabilityLease,
      ...liveInputs,
      onWorkspaceWriteCompleted,
      runWorkspaceWrite,
      workspaceFileWriter,
    });
    return null;
  }

  const setup = await testRender(<Harness />, { width: 20, height: 4 });
  await act(async () => setup.renderOnce());
  return {
    controller: () => controller,
    replaceInputs: async (next: {
      files: readonly WorkspaceFileSource[];
      input: CliInput;
      root: string;
    }) => {
      await act(async () => {
        replaceInputs(next);
        await setup.renderOnce();
      });
    },
    rerender: async () => {
      await act(async () => {
        rerender();
        await setup.renderOnce();
      });
    },
    retire: () => {
      live = false;
    },
    setup,
  };
}

/** Destroy a mounted hook harness after one test body. */
async function destroy(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => setup.renderer.destroy());
}

describe("useExtensionWorkspaceControls reads", () => {
  test("reads available and filtered-hidden reviewed documents and normalizes failures", async () => {
    const hidden = createTestFile({
      id: "hidden",
      path: "hidden.txt",
      sourceFetcher: { getFullText: async () => "hidden text" },
    });
    const failed = createTestFile({
      id: "failed",
      path: "failed.txt",
      sourceFetcher: {
        getFullText: async () => {
          throw new Error("source unavailable");
        },
      },
    });
    const harness = await renderController({
      // The controller receives the full review, independently of App's visible-file filter.
      files: [
        createTestFile(),
        hidden,
        failed,
        createTestFile({ id: "unavailable", sourceFetcher: undefined }),
      ],
    });
    const workspace = harness.controller().createWorkspaceControls("probe");

    try {
      await expect(workspace.readDocument("alpha", "old")).resolves.toBe("old alpha");
      await expect(workspace.readDocument("hidden", "new")).resolves.toBe("hidden text");
      await expect(workspace.readDocument("failed", "new")).resolves.toBeNull();
      await expect(workspace.readDocument("unavailable", "new")).resolves.toBeNull();
      await expect(workspace.readDocument("missing", "new")).resolves.toBeNull();
    } finally {
      await destroy(harness.setup);
    }
  });

  test("refuses stale reads before fetching and after a deferred fetch", async () => {
    let fetches = 0;
    const beforeHarness = await renderController({
      files: [
        createTestFile({
          sourceFetcher: {
            getFullText: async () => {
              fetches += 1;
              return "unused";
            },
          },
        }),
      ],
    });

    try {
      const before = beforeHarness.controller().createWorkspaceControls("probe");
      beforeHarness.retire();
      await expect(before.readDocument("alpha", "new")).resolves.toBeNull();
      expect(fetches).toBe(0);
    } finally {
      await destroy(beforeHarness.setup);
    }

    let finishRead!: (text: string) => void;
    const deferredRead = new Promise<string>((resolve) => {
      finishRead = resolve;
    });
    const afterHarness = await renderController({
      files: [
        createTestFile({
          sourceFetcher: { getFullText: async () => await deferredRead },
        }),
      ],
    });
    try {
      const pending = afterHarness
        .controller()
        .createWorkspaceControls("probe")
        .readDocument("alpha", "new");
      afterHarness.retire();
      finishRead("stale text");
      await expect(pending).resolves.toBeNull();
    } finally {
      await destroy(afterHarness.setup);
    }
  });

  test("keeps expired retained controls inert for malformed reads", async () => {
    const harness = await renderController();
    const workspace = harness.controller().createWorkspaceControls("probe");
    harness.retire();

    try {
      await expect(workspace.readDocument("alpha", "both" as never)).resolves.toBeNull();
    } finally {
      await destroy(harness.setup);
    }
  });
});

describe("useExtensionWorkspaceControls lifecycle", () => {
  test("keeps stable identities while reading live inputs and retiring minted controls", async () => {
    const initialRoot = createTestRoot();
    const nextRoot = createTestRoot();
    writeFileSync(join(nextRoot, "beta.txt"), "beta\n");
    const writtenPaths: string[] = [];
    const harness = await renderController({
      files: [createTestFile()],
      input: { kind: "show", ref: "HEAD", options: {} },
      root: initialRoot,
      workspaceFileWriter: async (absolutePath) => {
        writtenPaths.push(absolutePath);
      },
    });
    const initialController = harness.controller();
    const initialFactory = initialController.createWorkspaceControls;
    const workspace = initialFactory("probe");

    try {
      await harness.rerender();
      expect(harness.controller()).toBe(initialController);
      expect(harness.controller().createWorkspaceControls).toBe(initialFactory);

      await harness.replaceInputs({
        files: [
          createTestFile({
            id: "beta",
            path: "beta.txt",
            sourceFetcher: { getFullText: async () => "current beta" },
          }),
        ],
        input: WRITABLE_INPUT,
        root: nextRoot,
      });
      expect(harness.controller()).toBe(initialController);
      expect(harness.controller().createWorkspaceControls).toBe(initialFactory);
      await expect(workspace.readDocument("beta", "new")).resolves.toBe("current beta");
      expect(workspace.canWriteDocument("alpha")).toBe(false);
      expect(workspace.canWriteDocument("beta")).toBe(true);
      await expect(
        workspace.writeDocument({ fileId: "beta", text: "replacement" }),
      ).resolves.toEqual({ ok: true });
      expect(writtenPaths).toEqual([join(nextRoot, "beta.txt")]);

      harness.retire();
      await expect(workspace.readDocument("beta", "both" as never)).resolves.toBeNull();
      expect(workspace.canWriteDocument("beta")).toBe(false);
      await expect(
        workspace.writeDocument({ fileId: "beta", text: "replacement" }),
      ).resolves.toEqual(EXPIRED);
    } finally {
      await destroy(harness.setup);
    }
  });
});

describe("useExtensionWorkspaceControls writes", () => {
  test("throws for malformed requests and refuses unwritable reviews without prompting", async () => {
    let prompts = 0;
    const harness = await renderController({
      input: { kind: "show", ref: "HEAD", options: {} },
      confirm: async () => {
        prompts += 1;
        return true;
      },
    });
    const workspace = harness.controller().createWorkspaceControls("probe");

    try {
      await expect(workspace.writeDocument({ fileId: "", text: "x" })).rejects.toThrow(
        "non-empty fileId",
      );
      expect(workspace.canWriteDocument("alpha")).toBe(false);
      await expect(workspace.writeDocument({ fileId: "alpha", text: "x" })).resolves.toMatchObject({
        ok: false,
        reason: "unavailable",
      });
      expect(prompts).toBe(0);
    } finally {
      await destroy(harness.setup);
    }
  });

  test("refuses a missing target before prompting and a changed target after prompting", async () => {
    const root = createTestRoot();
    unlinkSync(join(root, "alpha.txt"));
    let prompts = 0;
    const beforeHarness = await renderController({
      root,
      confirm: async () => {
        prompts += 1;
        return true;
      },
    });

    try {
      await expect(
        beforeHarness
          .controller()
          .createWorkspaceControls("probe")
          .writeDocument({ fileId: "alpha", text: "replacement" }),
      ).resolves.toMatchObject({ ok: false, reason: "unavailable" });
      expect(prompts).toBe(0);
    } finally {
      await destroy(beforeHarness.setup);
    }

    const afterRoot = createTestRoot();
    let resolveConfirm!: (confirmed: boolean) => void;
    const confirmPending = new Promise<boolean>((resolve) => {
      resolveConfirm = resolve;
    });
    let promptOptions: ExtensionConfirmOptions | null = null;
    let promptExtension = "";
    const afterHarness = await renderController({
      root: afterRoot,
      confirm: async (options, extensionId) => {
        promptOptions = options;
        promptExtension = extensionId;
        return await confirmPending;
      },
    });

    try {
      const pending = afterHarness
        .controller()
        .createWorkspaceControls("probe")
        .writeDocument({ fileId: "alpha", text: "replacement" });
      while (!promptOptions) await Bun.sleep(0);
      expect(promptExtension).toBe("probe");
      expect(promptOptions as ExtensionConfirmOptions).toEqual({
        title: "Write alpha.txt?",
        body: "Extension probe will replace this file's contents on disk.",
        confirmLabel: "write",
      });
      unlinkSync(join(afterRoot, "alpha.txt"));
      resolveConfirm(true);
      await expect(pending).resolves.toMatchObject({ ok: false, reason: "unavailable" });
    } finally {
      await destroy(afterHarness.setup);
    }
  });

  test("returns cancelled when the user declines consent", async () => {
    let writes = 0;
    const harness = await renderController({
      confirm: async () => false,
      workspaceFileWriter: async () => {
        writes += 1;
      },
    });

    try {
      await expect(
        harness
          .controller()
          .createWorkspaceControls("probe")
          .writeDocument({ fileId: "alpha", text: "replacement" }),
      ).resolves.toEqual({
        ok: false,
        reason: "cancelled",
        detail: "The write to alpha.txt was declined.",
      });
      expect(writes).toBe(0);
    } finally {
      await destroy(harness.setup);
    }
  });

  test("refuses expired writes before async work while still validating requests", async () => {
    let prompts = 0;
    const harness = await renderController({
      confirm: async () => {
        prompts += 1;
        return true;
      },
    });
    const workspace = harness.controller().createWorkspaceControls("probe");
    harness.retire();

    try {
      expect(workspace.canWriteDocument("alpha")).toBe(false);
      await expect(
        workspace.writeDocument({ fileId: "alpha", text: "replacement" }),
      ).resolves.toEqual(EXPIRED);
      await expect(workspace.writeDocument({ fileId: "", text: "replacement" })).rejects.toThrow(
        "non-empty fileId",
      );
      expect(prompts).toBe(0);
    } finally {
      await destroy(harness.setup);
    }
  });

  test("does not prompt when the lease expires during verification", async () => {
    let prompts = 0;
    const harness = await renderController({
      confirm: async () => {
        prompts += 1;
        return true;
      },
    });

    try {
      const pending = harness
        .controller()
        .createWorkspaceControls("probe")
        .writeDocument({ fileId: "alpha", text: "replacement" });
      harness.retire();
      await expect(pending).resolves.toEqual(EXPIRED);
      expect(prompts).toBe(0);
    } finally {
      await destroy(harness.setup);
    }
  });

  test("refuses stale authority after consent and shutdown at the write boundary", async () => {
    let confirmStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      confirmStarted = resolve;
    });
    let resolveConfirm!: (confirmed: boolean) => void;
    const confirmation = new Promise<boolean>((resolve) => {
      resolveConfirm = resolve;
    });
    let writes = 0;
    const staleHarness = await renderController({
      confirm: async () => {
        confirmStarted();
        return await confirmation;
      },
      workspaceFileWriter: async () => {
        writes += 1;
      },
    });

    try {
      const pending = staleHarness
        .controller()
        .createWorkspaceControls("probe")
        .writeDocument({ fileId: "alpha", text: "replacement" });
      await started;
      staleHarness.retire();
      resolveConfirm(true);
      await expect(pending).resolves.toEqual(EXPIRED);
      expect(writes).toBe(0);
    } finally {
      await destroy(staleHarness.setup);
    }

    let runnerCalls = 0;
    const shutdownHarness = await renderController({
      runWorkspaceWrite: async () => {
        runnerCalls += 1;
        return false;
      },
      workspaceFileWriter: async () => {
        writes += 1;
      },
    });
    try {
      await expect(
        shutdownHarness
          .controller()
          .createWorkspaceControls("probe")
          .writeDocument({ fileId: "alpha", text: "replacement" }),
      ).resolves.toEqual(EXPIRED);
      expect(runnerCalls).toBe(1);
      expect(writes).toBe(0);
    } finally {
      await destroy(shutdownHarness.setup);
    }
  });

  test("reports filesystem failures without reconciling", async () => {
    let reconciliations = 0;
    const harness = await renderController({
      onWorkspaceWriteCompleted: () => {
        reconciliations += 1;
      },
      workspaceFileWriter: async () => {
        throw new Error("disk full");
      },
    });

    try {
      await expect(
        harness
          .controller()
          .createWorkspaceControls("probe")
          .writeDocument({ fileId: "alpha", text: "replacement" }),
      ).resolves.toEqual({
        ok: false,
        reason: "failed",
        detail: "Failed to write alpha.txt • disk full",
      });
      expect(reconciliations).toBe(0);
    } finally {
      await destroy(harness.setup);
    }
  });

  test("reports a started write truthfully across reload and reconciles exactly once", async () => {
    const root = createTestRoot();
    let writeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });
    let finishWrite!: () => void;
    const barrier = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    let reconciliations = 0;
    const harness = await renderController({
      root,
      onWorkspaceWriteCompleted: () => {
        reconciliations += 1;
      },
      workspaceFileWriter: async (absolutePath, text) => {
        writeStarted();
        await barrier;
        writeFileSync(absolutePath, text);
      },
    });

    try {
      const pending = harness
        .controller()
        .createWorkspaceControls("probe")
        .writeDocument({ fileId: "alpha", text: "replacement\n" });
      await started;
      harness.retire();
      finishWrite();

      await expect(pending).resolves.toEqual({ ok: true });
      expect(readFileSync(join(root, "alpha.txt"), "utf8")).toBe("replacement\n");
      expect(reconciliations).toBe(1);
    } finally {
      await destroy(harness.setup);
    }
  });
});
